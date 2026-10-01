import type { ConflictRecord, RowChange, SequencedChange } from '@xyra/contracts';
import type { NeonQueryClient } from './neon';
import {
  byteLength,
  type IdempotencyEntry,
  type Page,
  type PageRequest,
  type StoredConflict,
  type StoredRow,
  type SyncStorePort,
} from './store';

const TOMBSTONE_FIELD = '__xyra_deleted__';

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function rowKeyParts(key: string): { table: string; id: string } {
  const separator = key.indexOf(':');
  const table = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (separator <= 0 || !/^[a-z][a-z0-9_]*$/.test(table) || !/^[0-9a-f-]{36}$/i.test(id))
    throw new Error('INVALID_SYNC_ROW_KEY');
  return { table, id };
}

function changeJson(change: RowChange): string {
  return JSON.stringify(change);
}

/** Store adapter for one tenant/workspace transaction. Callers lock its sequence row before push. */
export class NeonSyncStore implements SyncStorePort {
  constructor(
    private readonly client: NeonQueryClient,
    private readonly tenantId: string,
    private readonly workspaceId: string,
  ) {}

  async getRow(key: string): Promise<StoredRow | undefined> {
    const { table, id } = rowKeyParts(key);
    const result = await this.client.query<{ fields: unknown; deleted_hlc: string | null }>(
      `SELECT fields,deleted_hlc FROM cloud_sync_rows
        WHERE tenant_id=$1 AND workspace_id=$2 AND table_name=$3 AND row_id=$4`,
      [this.tenantId, this.workspaceId, table, id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      fields: parseJson<StoredRow['fields']>(row.fields),
      ...(row.deleted_hlc ? { deletedHlc: row.deleted_hlc } : {}),
    };
  }

  async putRow(key: string, row: StoredRow): Promise<void> {
    const { table, id } = rowKeyParts(key);
    await this.client.query(
      `INSERT INTO cloud_sync_rows(tenant_id,workspace_id,table_name,row_id,fields,deleted_hlc,updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,now())
       ON CONFLICT (tenant_id,workspace_id,table_name,row_id)
       DO UPDATE SET fields=EXCLUDED.fields,deleted_hlc=EXCLUDED.deleted_hlc,updated_at=now()`,
      [this.tenantId, this.workspaceId, table, id, JSON.stringify(row.fields), row.deletedHlc ?? null],
    );
  }

  async serverSeq(): Promise<bigint> {
    const result = await this.client.query<{ last_seq: string | number }>(
      'SELECT last_seq FROM cloud_sync_sequences WHERE tenant_id=$1 AND workspace_id=$2',
      [this.tenantId, this.workspaceId],
    );
    return BigInt(result.rows[0]?.last_seq ?? 0);
  }

  async appendLog(change: RowChange): Promise<bigint> {
    const { table, id } = rowKeyParts(`${change.table}:${change.id}`);
    const allocated = await this.client.query<{ last_seq: string | number }>(
      `UPDATE cloud_sync_sequences SET last_seq=last_seq+1
        WHERE tenant_id=$1 AND workspace_id=$2 RETURNING last_seq`,
      [this.tenantId, this.workspaceId],
    );
    const allocatedSeq = allocated.rows[0]?.last_seq;
    if (allocatedSeq === undefined) throw new Error('SYNC_SEQUENCE_NOT_INITIALIZED');
    const seq = BigInt(allocatedSeq);
    const text = changeJson(change);
    await this.client.query(
      `INSERT INTO cloud_sync_changes(tenant_id,workspace_id,server_seq,table_name,row_id,change,bytes)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [this.tenantId, this.workspaceId, seq.toString(), table, id, text, byteLength(text)],
    );
    await this.client.query(
      `INSERT INTO cloud_sync_outbox(tenant_id,workspace_id,server_seq)
       VALUES ($1,$2,$3)`,
      [this.tenantId, this.workspaceId, seq.toString()],
    );

    if (change.op === 'append') return seq;
    if (change.op === 'delete') {
      await this.client.query(
        `DELETE FROM cloud_sync_changes c
          WHERE c.tenant_id=$1 AND c.workspace_id=$2 AND c.server_seq IN (
            SELECT f.server_seq FROM cloud_sync_field_seq f
             WHERE f.tenant_id=$1 AND f.workspace_id=$2 AND f.table_name=$3 AND f.row_id=$4
          )`,
        [this.tenantId, this.workspaceId, table, id],
      );
      await this.client.query(
        `DELETE FROM cloud_sync_field_seq
          WHERE tenant_id=$1 AND workspace_id=$2 AND table_name=$3 AND row_id=$4`,
        [this.tenantId, this.workspaceId, table, id],
      );
      await this.client.query(
        `INSERT INTO cloud_sync_field_seq(tenant_id,workspace_id,table_name,row_id,field_name,server_seq)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [this.tenantId, this.workspaceId, table, id, TOMBSTONE_FIELD, seq.toString()],
      );
      return seq;
    }

    const superseded = new Map<string, string[]>();
    for (const field of Object.keys(change.fields)) {
      const current = await this.client.query<{ server_seq: string | number }>(
        `SELECT server_seq FROM cloud_sync_field_seq
          WHERE tenant_id=$1 AND workspace_id=$2 AND table_name=$3 AND row_id=$4 AND field_name=$5`,
        [this.tenantId, this.workspaceId, table, id, field],
      );
      const oldSeq = current.rows[0]?.server_seq;
      if (oldSeq !== undefined) {
        const key = String(oldSeq);
        superseded.set(key, [...(superseded.get(key) ?? []), field]);
      }
      await this.client.query(
        `INSERT INTO cloud_sync_field_seq(tenant_id,workspace_id,table_name,row_id,field_name,server_seq)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id,workspace_id,table_name,row_id,field_name)
         DO UPDATE SET server_seq=EXCLUDED.server_seq`,
        [this.tenantId, this.workspaceId, table, id, field, seq.toString()],
      );
    }
    for (const [oldSeq, fields] of superseded) {
      const previous = await this.client.query<{ change: unknown }>(
        `SELECT change FROM cloud_sync_changes
          WHERE tenant_id=$1 AND workspace_id=$2 AND server_seq=$3`,
        [this.tenantId, this.workspaceId, oldSeq],
      );
      if (!previous.rows[0]) continue;
      const original = parseJson<RowChange>(previous.rows[0].change);
      const kept = Object.fromEntries(
        Object.entries(original.fields).filter(([field]) => !fields.includes(field)),
      );
      if (Object.keys(kept).length === 0) {
        await this.client.query(
          'DELETE FROM cloud_sync_changes WHERE tenant_id=$1 AND workspace_id=$2 AND server_seq=$3',
          [this.tenantId, this.workspaceId, oldSeq],
        );
      } else {
        const compacted = { ...original, fields: kept };
        const compactedText = changeJson(compacted);
        await this.client.query(
          `UPDATE cloud_sync_changes SET change=$4::jsonb,bytes=$5
            WHERE tenant_id=$1 AND workspace_id=$2 AND server_seq=$3`,
          [this.tenantId, this.workspaceId, oldSeq, compactedText, byteLength(compactedText)],
        );
      }
    }
    return seq;
  }

  async readLogPage(request: PageRequest): Promise<Page<SequencedChange>> {
    const candidates = await this.client.query<{
      server_seq: string | number;
      table_name: string;
      bytes: number;
    }>(
      `SELECT server_seq,table_name,bytes FROM cloud_sync_changes
        WHERE tenant_id=$1 AND workspace_id=$2 AND server_seq>$3
        ORDER BY server_seq LIMIT $4`,
      [this.tenantId, this.workspaceId, request.after.toString(), request.maxScan + 1],
    );
    return this.page(
      candidates.rows.map((row) => ({
        position: BigInt(row.server_seq),
        table: row.table_name,
        bytes: row.bytes,
      })),
      request,
      async (position) => {
        const result = await this.client.query<{ change: unknown }>(
          `SELECT change FROM cloud_sync_changes
          WHERE tenant_id=$1 AND workspace_id=$2 AND server_seq=$3`,
          [this.tenantId, this.workspaceId, position.toString()],
        );
        return { seq: position.toString(), change: parseJson<RowChange>(result.rows[0]?.change) };
      },
    );
  }

  async getIdempotency(key: string): Promise<IdempotencyEntry | undefined> {
    const result = await this.client.query<{
      payload_hash: string;
      response: unknown;
      created_at: string | Date;
    }>(
      `SELECT payload_hash,response,created_at FROM cloud_sync_idempotency
        WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3`,
      [this.tenantId, this.workspaceId, key],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      hash: row.payload_hash,
      response: parseJson<IdempotencyEntry['response']>(row.response),
      atMs: new Date(row.created_at).getTime(),
    };
  }

  async putIdempotency(key: string, entry: IdempotencyEntry): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_sync_idempotency(tenant_id,workspace_id,idempotency_key,payload_hash,response,created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,to_timestamp($6 / 1000.0))`,
      [this.tenantId, this.workspaceId, key, entry.hash, JSON.stringify(entry.response), entry.atMs],
    );
  }

  async pruneIdempotency(beforeMs: number): Promise<void> {
    await this.client.query(
      `DELETE FROM cloud_sync_idempotency
        WHERE tenant_id=$1 AND workspace_id=$2 AND created_at<to_timestamp($3 / 1000.0)`,
      [this.tenantId, this.workspaceId, beforeMs],
    );
  }

  async addConflict(record: ConflictRecord): Promise<void> {
    const text = JSON.stringify(record);
    await this.client.query(
      `INSERT INTO cloud_sync_conflicts(tenant_id,workspace_id,table_name,row_id,record,bytes)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [this.tenantId, this.workspaceId, record.table, record.rowId, text, byteLength(text)],
    );
  }

  async readConflictPage(request: PageRequest): Promise<Page<StoredConflict>> {
    const candidates = await this.client.query<{ id: string | number; table_name: string; bytes: number }>(
      `SELECT id,table_name,bytes FROM cloud_sync_conflicts
        WHERE tenant_id=$1 AND workspace_id=$2 AND id>$3 ORDER BY id LIMIT $4`,
      [this.tenantId, this.workspaceId, request.after.toString(), request.maxScan + 1],
    );
    return this.page(
      candidates.rows.map((row) => ({ position: BigInt(row.id), table: row.table_name, bytes: row.bytes })),
      request,
      async (position) => {
        const result = await this.client.query<{ id: string | number; record: unknown }>(
          `SELECT id,record FROM cloud_sync_conflicts WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
          [this.tenantId, this.workspaceId, position.toString()],
        );
        const row = result.rows[0];
        if (!row || !Number.isSafeInteger(Number(row.id))) throw new Error('CONFLICT_CURSOR_OVERFLOW');
        return {
          id: Number(row.id),
          record: parseJson<ConflictRecord>(row.record),
        };
      },
    );
  }

  async setRefs(childKey: string, parentKeys: readonly string[]): Promise<void> {
    const child = rowKeyParts(childKey);
    await this.client.query(
      `DELETE FROM cloud_sync_refs
        WHERE tenant_id=$1 AND workspace_id=$2 AND child_table=$3 AND child_row=$4`,
      [this.tenantId, this.workspaceId, child.table, child.id],
    );
    for (const parentKey of new Set(parentKeys)) {
      const parent = rowKeyParts(parentKey);
      await this.client.query(
        `INSERT INTO cloud_sync_refs(tenant_id,workspace_id,child_table,child_row,parent_table,parent_row)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [this.tenantId, this.workspaceId, child.table, child.id, parent.table, parent.id],
      );
    }
  }

  async hasLiveChildren(parentKey: string): Promise<boolean> {
    const parent = rowKeyParts(parentKey);
    const result = await this.client.query(
      `SELECT 1 FROM cloud_sync_refs
        WHERE tenant_id=$1 AND workspace_id=$2 AND parent_table=$3 AND parent_row=$4 LIMIT 1`,
      [this.tenantId, this.workspaceId, parent.table, parent.id],
    );
    return result.rows.length > 0;
  }

  private async page<T>(
    candidates: readonly { position: bigint; table: string; bytes: number }[],
    request: PageRequest,
    load: (position: bigint) => Promise<T>,
  ): Promise<Page<T>> {
    const items: T[] = [];
    let bytes = 0;
    let lastExamined = request.after;
    let scanned = 0;
    for (const candidate of candidates) {
      if (items.length >= request.maxRows || scanned >= request.maxScan)
        return { items, lastExamined, exhausted: false };
      scanned += 1;
      if (request.readable(candidate.table)) {
        const cost = candidate.bytes + 128;
        if (items.length > 0 && bytes + cost > request.maxBytes)
          return { items, lastExamined, exhausted: false };
        bytes += cost;
        items.push(await load(candidate.position));
      }
      lastExamined = candidate.position;
    }
    return { items, lastExamined, exhausted: candidates.length <= request.maxScan };
  }
}

export async function lockWorkspaceSequence(
  client: NeonQueryClient,
  tenantId: string,
  workspaceId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO cloud_sync_sequences(tenant_id,workspace_id,last_seq)
     VALUES ($1,$2,0) ON CONFLICT DO NOTHING`,
    [tenantId, workspaceId],
  );
  const locked = await client.query(
    `SELECT last_seq FROM cloud_sync_sequences WHERE tenant_id=$1 AND workspace_id=$2 FOR UPDATE`,
    [tenantId, workspaceId],
  );
  if (!locked.rows.length) throw new Error('SYNC_SEQUENCE_NOT_INITIALIZED');
}

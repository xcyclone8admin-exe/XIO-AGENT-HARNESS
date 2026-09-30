import type { ConflictRecord, PushResponse, RowChange, SequencedChange } from '@xyra/contracts';

export type FieldWrite = RowChange['fields'][string];

export interface StoredRow {
  readonly fields: Record<string, FieldWrite>;
  readonly deletedHlc?: string;
}

export interface IdempotencyEntry {
  readonly hash: string;
  readonly response: PushResponse;
  readonly atMs: number;
}

export interface StoredConflict {
  readonly id: number;
  readonly record: ConflictRecord;
}

/**
 * Storage port for the pure sync engine. The Durable Object implements it over
 * SQLite inside one transactionSync; tests use the in-memory implementation.
 */
export interface SyncStorePort {
  getRow(key: string): StoredRow | undefined;
  putRow(key: string, row: StoredRow): void;
  serverSeq(): bigint;
  /** Appends to the ordered log and returns the newly assigned server sequence. */
  appendLog(change: RowChange): bigint;
  readLog(after: bigint, limit: number): SequencedChange[];
  getIdempotency(key: string): IdempotencyEntry | undefined;
  putIdempotency(key: string, entry: IdempotencyEntry): void;
  pruneIdempotency(beforeMs: number): void;
  addConflict(record: ConflictRecord): void;
  readConflicts(afterId: number, limit: number): StoredConflict[];
}

export class MemorySyncStore implements SyncStorePort {
  private seq = 0n;
  private readonly rows = new Map<string, StoredRow>();
  private readonly log: SequencedChange[] = [];
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly conflicts: StoredConflict[] = [];

  getRow(key: string): StoredRow | undefined {
    return this.rows.get(key);
  }
  putRow(key: string, row: StoredRow): void {
    this.rows.set(key, structuredClone(row));
  }
  serverSeq(): bigint {
    return this.seq;
  }
  appendLog(change: RowChange): bigint {
    this.seq += 1n;
    this.log.push({ seq: this.seq.toString(10), change: structuredClone(change) });
    return this.seq;
  }
  readLog(after: bigint, limit: number): SequencedChange[] {
    return this.log.filter((entry) => BigInt(entry.seq) > after).slice(0, limit);
  }
  getIdempotency(key: string): IdempotencyEntry | undefined {
    return this.idempotency.get(key);
  }
  putIdempotency(key: string, entry: IdempotencyEntry): void {
    this.idempotency.set(key, structuredClone(entry));
  }
  pruneIdempotency(beforeMs: number): void {
    for (const [key, entry] of this.idempotency) if (entry.atMs < beforeMs) this.idempotency.delete(key);
  }
  addConflict(record: ConflictRecord): void {
    this.conflicts.push({ id: this.conflicts.length + 1, record: structuredClone(record) });
  }
  readConflicts(afterId: number, limit: number): StoredConflict[] {
    return this.conflicts.filter((entry) => entry.id > afterId).slice(0, limit);
  }

  /** Test helper. */
  snapshot(): {
    rows: Record<string, StoredRow>;
    log: SequencedChange[];
    conflicts: ConflictRecord[];
    seq: string;
    idempotencyCount: number;
  } {
    return {
      rows: Object.fromEntries(this.rows),
      log: structuredClone(this.log),
      conflicts: this.conflicts.map((entry) => entry.record),
      seq: this.seq.toString(10),
      idempotencyCount: this.idempotency.size,
    };
  }
}

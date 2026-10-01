import { z } from 'zod';
import type { NeonQueryClient } from './neon';

export const ERASURE_PROTOCOL_VERSION = 'cloud-erasure-v1' as const;

export const ErasureSource = z.object({
  kind: z.literal('brain_source'),
  id: z.uuid(),
});

export const BeginErasureRequest = z.object({
  protocolVersion: z.literal(ERASURE_PROTOCOL_VERSION),
  erasureId: z.uuid(),
  attemptId: z.uuid(),
  approvalId: z.uuid(),
  source: ErasureSource,
  sourceVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

export const ClaimLocalPurgeRequest = z.object({
  protocolVersion: z.literal(ERASURE_PROTOCOL_VERSION),
  attemptId: z.uuid(),
  reservationId: z.uuid(),
}).strict();

export const LocalPurgeAckRequest = z.object({
  protocolVersion: z.literal(ERASURE_PROTOCOL_VERSION),
  attemptId: z.uuid(),
  claimId: z.uuid(),
  claimGeneration: z.number().int().positive(),
  localPurgeReceiptId: z.uuid(),
  localPurgeReceiptDigest: z.string().regex(/^[0-9a-f]{64}$/),
  sourceVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

export const AbortErasureRequest = z.object({
  protocolVersion: z.literal(ERASURE_PROTOCOL_VERSION),
  attemptId: z.uuid(),
  claimId: z.uuid(),
  abortReceiptId: z.uuid(),
  abortReceiptDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type ErasureStatus =
  | 'eligible'
  | 'retained_shared'
  | 'retained_hold'
  | 'hold_unknown'
  | 'unavailable'
  | 'eligibility_expired'
  | 'eligibility_invalidated'
  | 'purge_claimed'
  | 'local_purge_acknowledged'
  | 'delete_pending'
  | 'completed'
  | 'aborted'
  | 'retryable_failure'
  | 'terminal_failure';

export interface SourceVersionEntry {
  readonly id: string;
  readonly version: number;
  readonly contentHash: string;
}

export interface SourceVersionSnapshot {
  readonly sourceId: string;
  readonly versions: readonly SourceVersionEntry[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** BRAIN's agreed opaque precondition encoding; caller values never replace the server snapshot. */
export async function sourceVersionDigest(snapshot: SourceVersionSnapshot): Promise<string> {
  const versions = [...snapshot.versions]
    .sort((left, right) => left.version - right.version || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map(({ id, version, contentHash }) => ({ id, version, contentHash }));
  const body = canonical({ sourceId: snapshot.sourceId, versions });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export type SyncedField = { readonly value: unknown };
export type SyncedFields = Readonly<Record<string, SyncedField>>;

/** Extracts only a live, server-synced BRAIN source/version snapshot. Missing state is an error. */
export async function sourceVersionFromSyncedRows(
  sourceId: string,
  sourceRow: { readonly fields: SyncedFields; readonly deleted: boolean } | undefined,
  versionRows: readonly { readonly id: string; readonly fields: SyncedFields; readonly deleted: boolean }[],
): Promise<string> {
  // The source identity is the cloud_sync_rows.row_id; only a present, live row is needed here.
  if (!sourceRow || sourceRow.deleted) throw new Error('SOURCE_STATE_UNAVAILABLE');
  if (versionRows.length === 0 || versionRows.some((row) => row.deleted))
    throw new Error('SOURCE_STATE_UNAVAILABLE');

  const versions: SourceVersionEntry[] = versionRows.map(({ id, fields }) => {
    const version = fields['version']?.value;
    const contentHash = fields['content_hash']?.value;
    if (
      !Number.isSafeInteger(version) ||
      Number(version) < 0 ||
      typeof contentHash !== 'string' ||
      !contentHash
    )
      throw new Error('SOURCE_STATE_UNAVAILABLE');
    return { id, version: Number(version), contentHash };
  });

  return sourceVersionDigest({ sourceId, versions });
}

/** True when any incoming row is permanently fenced by a completed Cloud erasure. */
export async function hasErasureFence(
  client: NeonQueryClient,
  tenantId: string,
  workspaceId: string,
  changes: readonly { readonly table: string; readonly id: string }[],
): Promise<boolean> {
  for (const change of changes) {
    const result = await client.query(
      `SELECT 1 FROM cloud_erasure_source_fences
        WHERE tenant_id=$1 AND workspace_id=$2 AND table_name=$3 AND row_id=$4 LIMIT 1`,
      [tenantId, workspaceId, change.table, change.id],
    );
    if (result.rows.length > 0) return true;
  }
  return false;
}

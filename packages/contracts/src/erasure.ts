import { z } from 'zod';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CloudBrainSourceVersion = z.string().regex(/^cloud-ingest-v2:sha256:[a-f0-9]{64}$/);
const UuidList = z.array(z.uuid()).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message: 'Object references must be unique' });
  }
  if (values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    context.addIssue({ code: 'custom', message: 'Object references must be sorted' });
  }
});

export const CloudBrainIngestionMode = z.enum(['with_objects', 'text_only']);
export type CloudBrainIngestionMode = z.infer<typeof CloudBrainIngestionMode>;

/** Client input contains no tenant, workspace, actor, ingestion id, ref list, or trust assertion. */
export const CloudBrainIngestionBeginRequest = z.strictObject({
  protocolVersion: z.literal('cloud-ingest-v2'),
  sourceId: z.uuid(),
  mode: CloudBrainIngestionMode,
});
export type CloudBrainIngestionBeginRequest = z.infer<typeof CloudBrainIngestionBeginRequest>;

/** Scope and ingestion id are generated from the authenticated Cloud request and persisted state. */
export const CloudBrainIngestionBeginResult = z.strictObject({
  protocolVersion: z.literal('cloud-ingest-v2'),
  ingestionId: z.uuid(),
  sourceId: z.uuid(),
  tenantId: z.uuid(),
  workspaceId: z.uuid(),
  mode: CloudBrainIngestionMode,
  startedAt: z.iso.datetime({ offset: true }),
});
export type CloudBrainIngestionBeginResult = z.infer<typeof CloudBrainIngestionBeginResult>;

/** Hash covers normalized source content only; refs are tracked and hashed independently by Cloud. */
export const CloudBrainIngestionFinalizeRequest = z.strictObject({
  protocolVersion: z.literal('cloud-ingest-v2'),
  sourceVersionId: z.uuid(),
  contentDigest: Digest,
});
export type CloudBrainIngestionFinalizeRequest = z.infer<typeof CloudBrainIngestionFinalizeRequest>;

/** Only this Cloud-authenticated durable receipt can establish a verified object-ref snapshot. */
export const CloudBrainIngestionFinalizationReceipt = z.strictObject({
  protocolVersion: z.literal('cloud-ingest-v2'),
  status: z.literal('finalized'),
  ingestionId: z.uuid(),
  sourceId: z.uuid(),
  sourceVersionId: z.uuid(),
  sourceVersion: CloudBrainSourceVersion,
  tenantId: z.uuid(),
  workspaceId: z.uuid(),
  contentDigest: Digest,
  referenceState: z.enum(['verified_empty', 'verified_nonempty']),
  objectRefIds: UuidList,
  referenceSetDigest: Digest,
  referenceStateVersion: z.number().int().positive(),
  finalizedAt: z.iso.datetime({ offset: true }),
}).superRefine((receipt, context) => {
  const empty = receipt.objectRefIds.length === 0;
  if ((receipt.referenceState === 'verified_empty') !== empty) {
    context.addIssue({ code: 'custom', message: 'Reference state must match the complete reference set' });
  }
});
export type CloudBrainIngestionFinalizationReceipt = z.infer<typeof CloudBrainIngestionFinalizationReceipt>;

export const CloudBrainIngestionStatus = z.discriminatedUnion('status', [
  z.strictObject({
    protocolVersion: z.literal('cloud-ingest-v2'),
    status: z.literal('pending'),
    ingestionId: z.uuid(),
    sourceId: z.uuid(),
    tenantId: z.uuid(),
    workspaceId: z.uuid(),
    mode: CloudBrainIngestionMode,
    startedAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    protocolVersion: z.literal('cloud-ingest-v2'),
    status: z.literal('finalized'),
    receipt: CloudBrainIngestionFinalizationReceipt,
  }),
  z.strictObject({
    protocolVersion: z.literal('cloud-ingest-v2'),
    status: z.literal('invalidated'),
    ingestionId: z.uuid(),
    sourceId: z.uuid(),
    sourceVersionId: z.uuid(),
    invalidatedAt: z.iso.datetime({ offset: true }),
  }),
]);
export type CloudBrainIngestionStatus = z.infer<typeof CloudBrainIngestionStatus>;

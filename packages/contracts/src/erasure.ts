import { z } from 'zod';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const CanonicalUuid = z.uuid().refine((value) => value === value.toLowerCase(), {
  message: 'UUID must use lowercase canonical form',
});
export const CloudBrainSourceVersion = z.string().regex(/^cloud-ingest-v2:sha256:[a-f0-9]{64}$/);
const UuidList = z.array(CanonicalUuid).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message: 'Object references must be unique' });
  }
  if (values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    context.addIssue({ code: 'custom', message: 'Object references must be sorted' });
  }
});

interface WebCryptoRuntime {
  crypto: { subtle: { digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer> } };
  TextEncoder: new () => { encode(value: string): Uint8Array };
}
const webCryptoRuntime = globalThis as unknown as WebCryptoRuntime;

export const CloudBrainIngestionMode = z.enum(['with_objects', 'text_only']);
export type CloudBrainIngestionMode = z.infer<typeof CloudBrainIngestionMode>;

/** Client input contains no tenant, workspace, actor, ingestion id, ref list, or trust assertion. */
export const CloudBrainIngestionBeginRequest = z.strictObject({
  protocolVersion: z.literal('cloud-ingest-v2'),
  sourceId: CanonicalUuid,
  mode: CloudBrainIngestionMode,
});
export type CloudBrainIngestionBeginRequest = z.infer<typeof CloudBrainIngestionBeginRequest>;

/** Scope and ingestion id are generated from the authenticated Cloud request and persisted state. */
export const CloudBrainIngestionBeginResult = z.strictObject({
  protocolVersion: z.literal('cloud-ingest-v2'),
  ingestionId: CanonicalUuid,
  sourceId: CanonicalUuid,
  tenantId: CanonicalUuid,
  workspaceId: CanonicalUuid,
  mode: CloudBrainIngestionMode,
  startedAt: z.iso.datetime({ offset: true }),
});
export type CloudBrainIngestionBeginResult = z.infer<typeof CloudBrainIngestionBeginResult>;

/** Hash covers normalized source content only; refs are tracked and hashed independently by Cloud. */
export const CloudBrainIngestionFinalizeRequest = z.strictObject({
  protocolVersion: z.literal('cloud-ingest-v2'),
  sourceVersionId: CanonicalUuid,
  contentDigest: Digest,
});
export type CloudBrainIngestionFinalizeRequest = z.infer<typeof CloudBrainIngestionFinalizeRequest>;

/** Only this Cloud-authenticated durable receipt can establish a verified object-ref snapshot. */
export const CloudBrainIngestionFinalizationReceipt = z
  .strictObject({
    protocolVersion: z.literal('cloud-ingest-v2'),
    status: z.literal('finalized'),
    ingestionId: CanonicalUuid,
    sourceId: CanonicalUuid,
    sourceVersionId: CanonicalUuid,
    sourceVersion: CloudBrainSourceVersion,
    tenantId: CanonicalUuid,
    workspaceId: CanonicalUuid,
    contentDigest: Digest,
    referenceState: z.enum(['verified_empty', 'verified_nonempty']),
    objectRefIds: UuidList,
    referenceSetDigest: Digest,
    referenceStateVersion: z.number().int().positive(),
    finalizedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((receipt, context) => {
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
    ingestionId: CanonicalUuid,
    sourceId: CanonicalUuid,
    tenantId: CanonicalUuid,
    workspaceId: CanonicalUuid,
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
    ingestionId: CanonicalUuid,
    sourceId: CanonicalUuid,
    sourceVersionId: CanonicalUuid,
    invalidatedAt: z.iso.datetime({ offset: true }),
  }),
]);
export type CloudBrainIngestionStatus = z.infer<typeof CloudBrainIngestionStatus>;

export const CloudBlobReferenceIssueRequest = z.strictObject({
  mode: z.literal('PUT'),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/),
  expiresInSec: z.number().int().min(30).max(300),
  ingestionId: CanonicalUuid,
});
export type CloudBlobReferenceIssueRequest = z.infer<typeof CloudBlobReferenceIssueRequest>;

export const CloudBlobReferenceIssueResult = z.strictObject({
  objectRefId: CanonicalUuid,
  mode: z.literal('PUT'),
  expiresAtMs: z.number().int().positive(),
  url: z.string().regex(/^\/v1\/blobs\/access\/[A-Za-z0-9._-]+$/),
  referenceStatus: z.literal('tracked'),
});
export type CloudBlobReferenceIssueResult = z.infer<typeof CloudBlobReferenceIssueResult>;

const CloudBrainReferenceSetDigestInput = z.strictObject({
  sourceId: CanonicalUuid,
  sourceVersionId: CanonicalUuid,
  objectRefIds: UuidList,
});

export const CloudBrainSourceVersionInput = z.strictObject({
  protocolVersion: z.literal('cloud-ingest-v2'),
  sourceId: CanonicalUuid,
  sourceVersionId: CanonicalUuid,
  tenantId: CanonicalUuid,
  workspaceId: CanonicalUuid,
  contentDigest: Digest,
  objectRefIds: UuidList,
  referenceStateVersion: z.number().int().positive(),
});
export type CloudBrainSourceVersionInput = z.infer<typeof CloudBrainSourceVersionInput>;

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const b = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

/** Deterministic JSON encoding shared by Cloud and product clients for v2 provenance digests. */
export function canonicalCloudIngestionJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const encode = (item: unknown): string => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Canonical JSON requires finite numbers');
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) throw new TypeError('Canonical JSON cannot contain cycles');
      seen.add(item);
      try {
        return `[${item.map(encode).join(',')}]`;
      } finally {
        seen.delete(item);
      }
    }
    if (typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const prototype = Object.getPrototypeOf(record) as object | null;
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('Canonical JSON accepts only plain objects');
      if (seen.has(record)) throw new TypeError('Canonical JSON cannot contain cycles');
      seen.add(record);
      try {
        const keys = Object.keys(record).sort(compareCodePoints);
        if (keys.some((key) => record[key] === undefined))
          throw new TypeError('Canonical JSON cannot contain undefined values');
        return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(',')}}`;
      } finally {
        seen.delete(record);
      }
    }
    throw new TypeError('Canonical JSON contains a non-JSON value');
  };
  return encode(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const hash = await webCryptoRuntime.crypto.subtle.digest('SHA-256', input.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Normalize only line endings and Unicode canonical composition; preserve all other whitespace. */
export function normalizeCloudBrainContent(content: string): string {
  if (typeof content !== 'string') throw new TypeError('Content must be text');
  return content.replace(/\r\n?/g, '\n').normalize('NFC');
}

/** BRAIN content hash convention: SHA-256 of normalized UTF-8 text, unprefixed lowercase hex. */
export async function cloudBrainContentDigest(content: string): Promise<string> {
  return sha256Hex(new webCryptoRuntime.TextEncoder().encode(normalizeCloudBrainContent(content)));
}

/** Hashes the exact normalized source-version/ref set shared with the Cloud finalization API. */
export async function cloudReferenceSetDigest(
  input: z.input<typeof CloudBrainReferenceSetDigestInput>,
): Promise<string> {
  const parsed = CloudBrainReferenceSetDigestInput.parse(input);
  return sha256Hex(new webCryptoRuntime.TextEncoder().encode(canonicalCloudIngestionJson(parsed)));
}

/** Final immutable v2 source version; only a Cloud finalization receipt may authorize its use. */
export async function cloudBrainSourceVersion(
  input: z.input<typeof CloudBrainSourceVersionInput>,
): Promise<string> {
  const parsed = CloudBrainSourceVersionInput.parse(input);
  const digest = await sha256Hex(
    new webCryptoRuntime.TextEncoder().encode(canonicalCloudIngestionJson(parsed)),
  );
  return `cloud-ingest-v2:sha256:${digest}`;
}

/** Fixed cross-runtime vectors for Cloud, BRAIN, and SDK canonicalizer parity. */
export const CLOUD_INGESTION_V2_TEST_VECTORS = Object.freeze({
  normalizedContent: 'XYRA source text\nsecond line',
  sourceId: '00000000-0000-4000-8000-000000000001',
  sourceVersionId: '00000000-0000-4000-8000-000000000002',
  tenantId: '00000000-0000-4000-8000-000000000003',
  workspaceId: '00000000-0000-4000-8000-000000000004',
  objectRefIds: Object.freeze([
    '00000000-0000-4000-8000-000000000006',
    '00000000-0000-4000-8000-000000000007',
  ]),
  contentDigest: '1b5eff67634792263f1dd55bff09faa96bc7171c8d788c36039f684ceaf12609',
  referenceSetDigest: '9e040ea50d090b2830e6f3a424339e5823dfee1027a9bd2ef9ed34f31de8eb71',
  referenceStateVersion: 7,
  sourceVersion: 'cloud-ingest-v2:sha256:f15954fb1c65da5a2eff6475ffac97de6a60e2d10d6af25e2ce9ac6f98ddb111',
});

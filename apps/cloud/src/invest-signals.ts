import { withNeonTransaction, type NeonQueryClient } from './neon';
import {
  CloudInvestSignalEnvelopeDigestAlgorithm,
  CloudInvestSignalEnvelopeDigestVersion,
  cloudInvestSignalEnvelopeDigest as sharedInvestSignalEnvelopeDigest,
  type CloudInvestSignalEnvelopeDigestInput,
} from '@xyra/contracts';

export const INVEST_SIGNAL_PROTOCOL = 'xyra.invest.signal.v1';
export const INVEST_SIGNAL_CONSUME_PROTOCOL = 'xyra.invest.signal.consume.v1';
export const INVEST_SIGNAL_ENVELOPE_DIGEST_VERSION = CloudInvestSignalEnvelopeDigestVersion;
export const INVEST_SIGNAL_ENVELOPE_DIGEST_ALGORITHM = CloudInvestSignalEnvelopeDigestAlgorithm;
export const MAX_INVEST_SIGNAL_BODY_BYTES = 32 * 1024;
export const INVEST_SIGNAL_LEASE_MS = 30_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ALGORITHM_ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9._/-]{0,31}$/;
const QUANTITY = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,12})?$/;

export type SignalSigningAlgorithm = 'ES256' | 'EdDSA';

export interface InvestSignalVerificationKey {
  readonly sourceId: string;
  readonly keyId: string;
  readonly signingAlg: SignalSigningAlgorithm;
  readonly publicJwk: JsonWebKey;
  readonly active: boolean;
}

type InvestSignalKeyMaterial = Pick<
  InvestSignalVerificationKey,
  'sourceId' | 'keyId' | 'signingAlg' | 'publicJwk'
> & { readonly active?: boolean };

export interface InvestSignalBody {
  readonly protocol: typeof INVEST_SIGNAL_PROTOCOL;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly expiresAt: string;
  readonly algorithmId: string;
  readonly signalId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: string;
}

export interface VerifiedInvestSignalEnvelope extends InvestSignalBody {
  readonly sourceId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly receivedAt: string;
  readonly payloadDigest: string;
  readonly verification: {
    readonly signature: 'verified';
    readonly keyId: string;
    readonly signingAlg: SignalSigningAlgorithm;
  };
  readonly envelopeDigestVersion: typeof INVEST_SIGNAL_ENVELOPE_DIGEST_VERSION;
  readonly envelopeDigestAlgorithm: typeof INVEST_SIGNAL_ENVELOPE_DIGEST_ALGORITHM;
  readonly envelopeDigest: string;
}

export type InvestSignalEnvelopeDigestInput = CloudInvestSignalEnvelopeDigestInput;

/**
 * Hashes the exact normalized claim payload, scope, receipt time, raw-body digest and
 * server-resolved verification key/algorithm. The raw `payloadDigest` remains the digest
 * of the signed request bytes; this separate digest binds the typed envelope sent to Invest.
 */
export async function investSignalEnvelopeDigest(input: InvestSignalEnvelopeDigestInput): Promise<string> {
  return sharedInvestSignalEnvelopeDigest(input);
}

export async function verifyInvestSignalEnvelopeDigest(
  envelope: VerifiedInvestSignalEnvelope,
): Promise<boolean> {
  if (
    envelope.envelopeDigestVersion !== INVEST_SIGNAL_ENVELOPE_DIGEST_VERSION ||
    envelope.envelopeDigestAlgorithm !== INVEST_SIGNAL_ENVELOPE_DIGEST_ALGORITHM ||
    !DIGEST.test(envelope.envelopeDigest)
  )
    return false;
  const {
    envelopeDigest: _digest,
    envelopeDigestAlgorithm: _algorithm,
    envelopeDigestVersion: _version,
    ...input
  } = envelope;
  return (await investSignalEnvelopeDigest(input)) === envelope.envelopeDigest;
}

export interface InvestSignalSourceKey {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly keyId: string;
  readonly signingAlg: SignalSigningAlgorithm;
  readonly publicJwk: JsonWebKey;
  readonly allowedAlgorithmIds: readonly string[];
  readonly allowedSymbols: readonly string[];
  readonly maxAgeSeconds: number;
  readonly maxLifetimeSeconds: number;
  readonly maxEventsPerMinute: number;
}

export class InvestSignalError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 409 | 413 | 429 | 503,
  ) {
    super(code);
  }
}

export interface RawInvestWebhook {
  readonly sourceId: string;
  readonly keyId: string;
  readonly timestampSeconds: number;
  readonly signature: Uint8Array;
  readonly rawBody: Uint8Array;
}

export async function readInvestWebhook(request: Request): Promise<RawInvestWebhook> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new InvestSignalError('SIGNAL_CONTENT_TYPE_INVALID', 400);
  const sourceId = request.headers.get('x-xyra-source-id') ?? '';
  const keyId = request.headers.get('x-xyra-key-id') ?? '';
  const timestampText = request.headers.get('x-xyra-timestamp') ?? '';
  const signatureText = request.headers.get('x-xyra-signature') ?? '';
  if (!UUID.test(sourceId) || !UUID.test(keyId)) throw new InvestSignalError('SIGNAL_SOURCE_INVALID', 401);
  if (!/^\d{10}$/.test(timestampText)) throw new InvestSignalError('SIGNAL_TIMESTAMP_INVALID', 401);
  const signature = decodeBase64Url(signatureText.startsWith('v1=') ? signatureText.slice(3) : '');
  if (!signature || signature.byteLength !== 64) throw new InvestSignalError('SIGNAL_SIGNATURE_INVALID', 401);

  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_INVEST_SIGNAL_BODY_BYTES))
    throw new InvestSignalError('SIGNAL_BODY_TOO_LARGE', 413);
  if (!request.body) throw new InvestSignalError('SIGNAL_BODY_INVALID', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_INVEST_SIGNAL_BODY_BYTES) {
        await reader.cancel();
        throw new InvestSignalError('SIGNAL_BODY_TOO_LARGE', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && Number(declared) !== byteLength)
    throw new InvestSignalError('SIGNAL_CONTENT_LENGTH_MISMATCH', 400);
  const rawBody = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    rawBody.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    sourceId: sourceId.toLowerCase(),
    keyId: keyId.toLowerCase(),
    timestampSeconds: Number(timestampText),
    signature,
    rawBody,
  };
}

export function parseInvestSignalBody(rawBody: Uint8Array): InvestSignalBody {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    throw new InvestSignalError('SIGNAL_BODY_INVALID', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvestSignalError('SIGNAL_BODY_INVALID', 400);
  const row = value as Record<string, unknown>;
  const expectedKeys = [
    'protocol',
    'eventId',
    'occurredAt',
    'expiresAt',
    'algorithmId',
    'signalId',
    'symbol',
    'side',
    'quantity',
  ];
  if (Object.keys(row).length !== expectedKeys.length || expectedKeys.some((key) => !(key in row)))
    throw new InvestSignalError('SIGNAL_BODY_INVALID', 400);
  if (
    row['protocol'] !== INVEST_SIGNAL_PROTOCOL ||
    typeof row['eventId'] !== 'string' ||
    !EVENT_ID.test(row['eventId']) ||
    typeof row['occurredAt'] !== 'string' ||
    !validIsoTimestamp(row['occurredAt']) ||
    typeof row['expiresAt'] !== 'string' ||
    !validIsoTimestamp(row['expiresAt']) ||
    typeof row['algorithmId'] !== 'string' ||
    !ALGORITHM_ID.test(row['algorithmId']) ||
    typeof row['signalId'] !== 'string' ||
    !UUID.test(row['signalId']) ||
    typeof row['symbol'] !== 'string' ||
    !SYMBOL.test(row['symbol']) ||
    (row['side'] !== 'buy' && row['side'] !== 'sell') ||
    typeof row['quantity'] !== 'string' ||
    !QUANTITY.test(row['quantity']) ||
    decimalIsZero(row['quantity'])
  )
    throw new InvestSignalError('SIGNAL_BODY_INVALID', 400);
  return {
    protocol: INVEST_SIGNAL_PROTOCOL,
    eventId: row['eventId'],
    occurredAt: new Date(row['occurredAt']).toISOString(),
    expiresAt: new Date(row['expiresAt']).toISOString(),
    algorithmId: row['algorithmId'],
    signalId: row['signalId'].toLowerCase(),
    symbol: row['symbol'],
    side: row['side'],
    quantity: row['quantity'],
  };
}

export async function verifyInvestSignalSignature(
  webhook: RawInvestWebhook,
  keySource: InvestSignalKeyMaterial,
  nowMs = Date.now(),
): Promise<{ readonly body: InvestSignalBody; readonly payloadDigest: string }> {
  const body = parseInvestSignalBody(webhook.rawBody);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - webhook.timestampSeconds) > 300)
    throw new InvestSignalError('SIGNAL_TIMESTAMP_STALE', 401);
  if (
    keySource.active === false ||
    keySource.sourceId !== webhook.sourceId ||
    keySource.keyId !== webhook.keyId
  )
    throw new InvestSignalError('SIGNAL_SOURCE_INVALID', 401);
  const key = await importSigningKey(keySource);
  const prefix = new TextEncoder().encode(`${webhook.timestampSeconds}.`);
  const signed = new Uint8Array(prefix.byteLength + webhook.rawBody.byteLength);
  signed.set(prefix);
  signed.set(webhook.rawBody, prefix.byteLength);
  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      keySource.signingAlg === 'EdDSA' ? 'Ed25519' : { name: 'ECDSA', hash: 'SHA-256' },
      key,
      arrayBuffer(webhook.signature),
      arrayBuffer(signed),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw new InvestSignalError('SIGNAL_SIGNATURE_INVALID', 401);
  return { body, payloadDigest: await sha256Hex(webhook.rawBody) };
}

export function validateInvestSignalPolicy(
  verified: { readonly body: InvestSignalBody; readonly payloadDigest: string },
  source: InvestSignalSourceKey,
  nowMs = Date.now(),
): void {
  const body = verified.body;
  const occurredAt = Date.parse(body.occurredAt);
  const expiresAt = Date.parse(body.expiresAt);
  const maxAgeMs = source.maxAgeSeconds * 1000;
  const maxLifetimeMs = source.maxLifetimeSeconds * 1000;
  if (
    occurredAt > nowMs + 60_000 ||
    occurredAt < nowMs - maxAgeMs ||
    expiresAt <= nowMs ||
    expiresAt <= occurredAt ||
    expiresAt - occurredAt > maxLifetimeMs
  )
    throw new InvestSignalError('SIGNAL_LIFETIME_INVALID', 400);
  if (!source.allowedAlgorithmIds.includes(body.algorithmId))
    throw new InvestSignalError('SIGNAL_ALGORITHM_NOT_ALLOWED', 403);
  if (!source.allowedSymbols.includes(body.symbol))
    throw new InvestSignalError('SIGNAL_SYMBOL_NOT_ALLOWED', 403);
}

export async function verifyInvestSignal(
  webhook: RawInvestWebhook,
  source: InvestSignalSourceKey,
  nowMs = Date.now(),
): Promise<{ readonly body: InvestSignalBody; readonly payloadDigest: string }> {
  const verified = await verifyInvestSignalSignature(webhook, source, nowMs);
  validateInvestSignalPolicy(verified, source, nowMs);
  return verified;
}

export async function findInvestSignalVerificationKey(
  connectionString: string,
  sourceId: string,
  keyId: string,
): Promise<InvestSignalVerificationKey | null> {
  return withNeonTransaction(connectionString, {}, async (client) => {
    const result = await client.query<ResolutionDbRow>(
      `SELECT source_id::text,key_id::text,signing_alg,public_jwk,active
         FROM cloud_invest_signal_resolution
        WHERE source_id=$1 AND key_id=$2 AND active=true`,
      [sourceId, keyId],
    );
    return result.rows[0] ? mapVerificationKey(result.rows[0]) : null;
  });
}

/** Load policy only after the webhook signature has been verified against the global key tuple. */
export async function findInvestSignalPolicy(
  connectionString: string,
  sourceId: string,
  keyId: string,
): Promise<InvestSignalSourceKey | null> {
  return withNeonTransaction(
    connectionString,
    { investSignalSourceId: sourceId, investSignalKeyId: keyId },
    async (client) => {
      const result = await client.query<SourceDbRow>(
        `SELECT tenant_id::text,workspace_id::text,source_id::text,key_id::text,signing_alg,public_jwk,
                active,allowed_algorithm_ids,allowed_symbols,max_age_seconds,max_lifetime_seconds,max_events_per_minute
           FROM cloud_invest_signal_sources
          WHERE source_id=$1 AND key_id=$2 AND active=true`,
        [sourceId, keyId],
      );
      return result.rows[0] ? mapSource(result.rows[0]) : null;
    },
  );
}

export type AcceptSignalResult =
  | {
      readonly kind: 'accepted' | 'duplicate';
      readonly eventRecordId: string;
      readonly jobId: string;
      readonly receivedAt: string;
      readonly envelope: VerifiedInvestSignalEnvelope;
    }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'rate_limited' };

/** Rechecks the key under a row lock, then writes the event and Queue outbox in this transaction. */
export async function acceptInvestSignal(
  connectionString: string,
  webhook: RawInvestWebhook,
  expectedSource: InvestSignalSourceKey,
  nowMs = Date.now(),
): Promise<AcceptSignalResult> {
  return withNeonTransaction(
    connectionString,
    { tenantId: expectedSource.tenantId, workspaceId: expectedSource.workspaceId },
    (client) => acceptInvestSignalInTransaction(client, webhook, expectedSource, nowMs),
  );
}

export async function acceptInvestSignalInTransaction(
  client: NeonQueryClient,
  webhook: RawInvestWebhook,
  expectedSource: InvestSignalSourceKey,
  nowMs = Date.now(),
): Promise<AcceptSignalResult> {
  await client.query("SELECT set_config('app.invest_signal_source_id',$1,true)", [webhook.sourceId]);
  await client.query("SELECT set_config('app.invest_signal_key_id',$1,true)", [webhook.keyId]);
  // Serialize key rotations and duplicate deliveries for a source as one idempotency domain,
  // including retries that straddle a minute rate-window boundary.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `${expectedSource.tenantId}:${expectedSource.workspaceId}:${expectedSource.sourceId}`,
  ]);
  const configured = await client.query<SourceDbRow>(
    `SELECT tenant_id::text,workspace_id::text,source_id::text,key_id::text,signing_alg,public_jwk,
              allowed_algorithm_ids,allowed_symbols,max_age_seconds,max_lifetime_seconds,max_events_per_minute
         FROM cloud_invest_signal_sources
        WHERE source_id=$1 AND key_id=$2 AND tenant_id=$3 AND workspace_id=$4 AND active=true`,
    [webhook.sourceId, webhook.keyId, expectedSource.tenantId, expectedSource.workspaceId],
  );
  if (!configured.rows[0]) throw new InvestSignalError('SIGNAL_SOURCE_INACTIVE', 401);
  const source = mapSource(configured.rows[0]);
  if (!sameSourceKey(source, expectedSource)) throw new InvestSignalError('SIGNAL_SOURCE_CHANGED', 401);
  const verified = await verifyInvestSignal(webhook, source, nowMs);
  const bucket = Math.floor(nowMs / 60_000) * 60_000;
  const rate = await client.query<{ request_count: number }>(
    `INSERT INTO cloud_invest_signal_rate_windows(tenant_id,workspace_id,source_id,window_start,request_count)
       VALUES ($1,$2,$3,to_timestamp($4),1)
       ON CONFLICT (tenant_id,workspace_id,source_id,window_start)
       DO UPDATE SET request_count=cloud_invest_signal_rate_windows.request_count+1
       RETURNING request_count`,
    [source.tenantId, source.workspaceId, source.sourceId, bucket / 1000],
  );
  if ((rate.rows[0]?.request_count ?? Number.MAX_SAFE_INTEGER) > source.maxEventsPerMinute)
    return { kind: 'rate_limited' };

  const existing = await client.query<EventDbRow>(
    `SELECT id::text,encode(payload_digest,'hex') AS payload_digest,envelope,received_at::text,queue_job_id::text
         FROM cloud_invest_signal_events
        WHERE tenant_id=$1 AND workspace_id=$2 AND source_id=$3 AND event_id=$4 FOR UPDATE`,
    [source.tenantId, source.workspaceId, source.sourceId, verified.body.eventId],
  );
  if (existing.rows[0]) {
    const prior = existing.rows[0];
    if (prior.payload_digest !== verified.payloadDigest) return { kind: 'conflict' };
    const job = await readSignalJob(client, source, verified.body.eventId, verified.payloadDigest);
    if (!job) throw new InvestSignalError('SIGNAL_OUTBOX_UNAVAILABLE', 503);
    return {
      kind: 'duplicate',
      eventRecordId: prior.id,
      jobId: job,
      receivedAt: normalizeDbTimestamp(prior.received_at),
      envelope: await parseAndVerifyEnvelope(prior.envelope),
    };
  }

  const id = crypto.randomUUID();
  const created = await client.query<{ received_at: string }>('SELECT now()::text AS received_at');
  const receivedAt = normalizeDbTimestamp(created.rows[0]?.received_at ?? new Date(nowMs).toISOString());
  const envelopeInput: InvestSignalEnvelopeDigestInput = {
    ...verified.body,
    sourceId: source.sourceId,
    tenantId: source.tenantId,
    workspaceId: source.workspaceId,
    receivedAt,
    payloadDigest: verified.payloadDigest,
    verification: { signature: 'verified', keyId: source.keyId, signingAlg: source.signingAlg },
  };
  const envelope: VerifiedInvestSignalEnvelope = {
    ...envelopeInput,
    envelopeDigestVersion: INVEST_SIGNAL_ENVELOPE_DIGEST_VERSION,
    envelopeDigestAlgorithm: INVEST_SIGNAL_ENVELOPE_DIGEST_ALGORITHM,
    envelopeDigest: await investSignalEnvelopeDigest(envelopeInput),
  };
  await client.query(
    `INSERT INTO cloud_invest_signal_events
        (id,tenant_id,workspace_id,source_id,key_id,event_id,payload_digest,envelope,event_expires_at,status)
       VALUES ($1,$2,$3,$4,$5,$6,decode($7,'hex'),$8::jsonb,$9,'pending')`,
    [
      id,
      source.tenantId,
      source.workspaceId,
      source.sourceId,
      source.keyId,
      verified.body.eventId,
      verified.payloadDigest,
      JSON.stringify(envelope),
      verified.body.expiresAt,
    ],
  );
  const outboxKey = `${source.sourceId}:${verified.body.eventId}`;
  const jobId = crypto.randomUUID();
  await client.query(
    `INSERT INTO cloud_queue_jobs(id,tenant_id,workspace_id,job_type,idempotency_key,payload,status)
       VALUES ($1,$2,$3,'invest.signal.received',$4,$5::jsonb,'pending')`,
    [
      jobId,
      source.tenantId,
      source.workspaceId,
      outboxKey,
      JSON.stringify({ eventRecordId: id, payloadDigest: verified.payloadDigest }),
    ],
  );
  await client.query(
    'UPDATE cloud_invest_signal_events SET queue_job_id=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3',
    [source.tenantId, source.workspaceId, id, jobId],
  );
  return { kind: 'accepted', eventRecordId: id, jobId, receivedAt, envelope };
}

export interface SignalConsumerIdentity {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly deviceId: string;
}

export interface SignalClaimRequest {
  readonly protocol: typeof INVEST_SIGNAL_CONSUME_PROTOCOL;
  readonly idempotencyKey: string;
}

export function parseSignalClaimRequest(value: unknown): SignalClaimRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 2 ||
    row['protocol'] !== INVEST_SIGNAL_CONSUME_PROTOCOL ||
    typeof row['idempotencyKey'] !== 'string' ||
    !UUID.test(row['idempotencyKey'])
  )
    return null;
  return { protocol: INVEST_SIGNAL_CONSUME_PROTOCOL, idempotencyKey: row['idempotencyKey'].toLowerCase() };
}

export async function claimInvestSignal(
  connectionString: string,
  identity: SignalConsumerIdentity,
  input: SignalClaimRequest,
): Promise<
  | {
      status: 'claimed';
      lease: { leaseId: string; fence: number; expiresAt: string };
      signal: VerifiedInvestSignalEnvelope;
    }
  | { status: 'empty' }
> {
  return withNeonTransaction(
    connectionString,
    { tenantId: identity.tenantId, workspaceId: identity.workspaceId },
    (client) => claimInvestSignalInTransaction(client, identity, input),
  );
}

export async function claimInvestSignalInTransaction(
  client: NeonQueryClient,
  identity: SignalConsumerIdentity,
  input: SignalClaimRequest,
): Promise<
  | {
      status: 'claimed';
      lease: { leaseId: string; fence: number; expiresAt: string };
      signal: VerifiedInvestSignalEnvelope;
    }
  | { status: 'empty' }
> {
  const prior = await client.query<ClaimDbRow>(
    `SELECT c.lease_id::text,c.lease_fence,c.expires_at::text,e.status,e.envelope
         FROM cloud_invest_signal_claims c JOIN cloud_invest_signal_events e ON e.id=c.event_id
        WHERE c.tenant_id=$1 AND c.workspace_id=$2 AND c.principal_id=$3 AND c.device_id=$4 AND c.idempotency_key=$5`,
    [identity.tenantId, identity.workspaceId, identity.principalId, identity.deviceId, input.idempotencyKey],
  );
  if (prior.rows[0]) {
    const row = prior.rows[0];
    if (row.status !== 'claimed' || Date.parse(row.expires_at) <= Date.now())
      throw new InvestSignalError('SIGNAL_CLAIM_CLOSED', 409);
    return {
      status: 'claimed',
      lease: {
        leaseId: row.lease_id,
        fence: Number(row.lease_fence),
        expiresAt: normalizeDbTimestamp(row.expires_at),
      },
      signal: await parseAndVerifyEnvelope(row.envelope),
    };
  }
  const available = await client.query<ClaimableDbRow>(
    `SELECT id::text,envelope,lease_fence
         FROM cloud_invest_signal_events
        WHERE tenant_id=$1 AND workspace_id=$2 AND event_expires_at>now()
          AND (status='pending' OR (status='claimed' AND lease_expires_at<=now()))
        ORDER BY received_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
    [identity.tenantId, identity.workspaceId],
  );
  if (!available.rows[0]) return { status: 'empty' };
  const event = available.rows[0];
  const leaseId = crypto.randomUUID();
  const updated = await client.query<{ lease_fence: number; lease_expires_at: string }>(
    `UPDATE cloud_invest_signal_events SET status='claimed',claim_device_id=$3,lease_id=$4,
           lease_fence=lease_fence+1,lease_expires_at=LEAST(now()+($5::text||' milliseconds')::interval,event_expires_at)
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$6 RETURNING lease_fence,lease_expires_at::text`,
    [identity.tenantId, identity.workspaceId, identity.deviceId, leaseId, INVEST_SIGNAL_LEASE_MS, event.id],
  );
  const lease = updated.rows[0];
  if (!lease) throw new InvestSignalError('SIGNAL_CLAIM_UNAVAILABLE', 503);
  await client.query(
    `INSERT INTO cloud_invest_signal_claims
        (tenant_id,workspace_id,principal_id,device_id,idempotency_key,event_id,lease_id,lease_fence,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      identity.tenantId,
      identity.workspaceId,
      identity.principalId,
      identity.deviceId,
      input.idempotencyKey,
      event.id,
      leaseId,
      lease.lease_fence,
      lease.lease_expires_at,
    ],
  );
  return {
    status: 'claimed',
    lease: {
      leaseId,
      fence: Number(lease.lease_fence),
      expiresAt: normalizeDbTimestamp(lease.lease_expires_at),
    },
    signal: await parseAndVerifyEnvelope(event.envelope),
  };
}

export interface SignalAckRequest {
  readonly protocol: typeof INVEST_SIGNAL_CONSUME_PROTOCOL;
  readonly eventId: string;
  readonly payloadDigest: string;
  readonly envelopeDigestVersion: typeof INVEST_SIGNAL_ENVELOPE_DIGEST_VERSION;
  readonly envelopeDigestAlgorithm: typeof INVEST_SIGNAL_ENVELOPE_DIGEST_ALGORITHM;
  readonly envelopeDigest: string;
  readonly leaseId: string;
  readonly decisionId: string;
  readonly idempotencyKey: string;
}

export function parseSignalAckRequest(value: unknown): SignalAckRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = [
    'protocol',
    'eventId',
    'payloadDigest',
    'envelopeDigestVersion',
    'envelopeDigestAlgorithm',
    'envelopeDigest',
    'leaseId',
    'decisionId',
    'idempotencyKey',
  ];
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !(key in row)) ||
    row['protocol'] !== INVEST_SIGNAL_CONSUME_PROTOCOL ||
    typeof row['eventId'] !== 'string' ||
    !EVENT_ID.test(row['eventId']) ||
    typeof row['payloadDigest'] !== 'string' ||
    !DIGEST.test(row['payloadDigest']) ||
    row['envelopeDigestVersion'] !== INVEST_SIGNAL_ENVELOPE_DIGEST_VERSION ||
    row['envelopeDigestAlgorithm'] !== INVEST_SIGNAL_ENVELOPE_DIGEST_ALGORITHM ||
    typeof row['envelopeDigest'] !== 'string' ||
    !DIGEST.test(row['envelopeDigest']) ||
    typeof row['leaseId'] !== 'string' ||
    !UUID.test(row['leaseId']) ||
    typeof row['decisionId'] !== 'string' ||
    !UUID.test(row['decisionId']) ||
    typeof row['idempotencyKey'] !== 'string' ||
    !UUID.test(row['idempotencyKey'])
  )
    return null;
  return {
    protocol: INVEST_SIGNAL_CONSUME_PROTOCOL,
    eventId: row['eventId'],
    payloadDigest: row['payloadDigest'],
    envelopeDigestVersion: INVEST_SIGNAL_ENVELOPE_DIGEST_VERSION,
    envelopeDigestAlgorithm: INVEST_SIGNAL_ENVELOPE_DIGEST_ALGORITHM,
    envelopeDigest: row['envelopeDigest'],
    leaseId: row['leaseId'].toLowerCase(),
    decisionId: row['decisionId'].toLowerCase(),
    idempotencyKey: row['idempotencyKey'].toLowerCase(),
  };
}

export async function acknowledgeInvestSignal(
  connectionString: string,
  identity: SignalConsumerIdentity,
  input: SignalAckRequest,
): Promise<{
  status: 'acked';
  eventId: string;
  payloadDigest: string;
  envelopeDigestVersion: typeof INVEST_SIGNAL_ENVELOPE_DIGEST_VERSION;
  envelopeDigestAlgorithm: typeof INVEST_SIGNAL_ENVELOPE_DIGEST_ALGORITHM;
  envelopeDigest: string;
  decisionId: string;
  acknowledgedAt: string;
  replayed: boolean;
}> {
  return withNeonTransaction(
    connectionString,
    { tenantId: identity.tenantId, workspaceId: identity.workspaceId },
    (client) => acknowledgeInvestSignalInTransaction(client, identity, input),
  );
}

export async function acknowledgeInvestSignalInTransaction(
  client: NeonQueryClient,
  identity: SignalConsumerIdentity,
  input: SignalAckRequest,
): Promise<{
  status: 'acked';
  eventId: string;
  payloadDigest: string;
  envelopeDigestVersion: typeof INVEST_SIGNAL_ENVELOPE_DIGEST_VERSION;
  envelopeDigestAlgorithm: typeof INVEST_SIGNAL_ENVELOPE_DIGEST_ALGORITHM;
  envelopeDigest: string;
  decisionId: string;
  acknowledgedAt: string;
  replayed: boolean;
}> {
  const rows = await client.query<AckDbRow>(
    `SELECT id::text,encode(payload_digest,'hex') AS payload_digest,status,claim_device_id::text,lease_id::text,
              lease_fence,lease_expires_at::text,ack_decision_id::text,ack_idempotency_key::text,acked_at::text,envelope
         FROM cloud_invest_signal_events
        WHERE tenant_id=$1 AND workspace_id=$2 AND envelope->>'eventId'=$3 AND lease_id=$4 FOR UPDATE`,
    [identity.tenantId, identity.workspaceId, input.eventId, input.leaseId],
  );
  const event = rows.rows[0];
  if (!event || event.payload_digest !== input.payloadDigest || event.claim_device_id !== identity.deviceId)
    throw new InvestSignalError('SIGNAL_LEASE_INVALID', 409);
  const envelope = await parseAndVerifyEnvelope(event.envelope);
  if (
    envelope.envelopeDigestVersion !== input.envelopeDigestVersion ||
    envelope.envelopeDigestAlgorithm !== input.envelopeDigestAlgorithm ||
    envelope.envelopeDigest !== input.envelopeDigest
  )
    throw new InvestSignalError('SIGNAL_ENVELOPE_DIGEST_MISMATCH', 409);
  if (event.status === 'acked') {
    if (event.ack_decision_id !== input.decisionId || event.ack_idempotency_key !== input.idempotencyKey)
      throw new InvestSignalError('SIGNAL_ACK_IDEMPOTENCY_REUSED', 409);
    return {
      status: 'acked',
      eventId: input.eventId,
      payloadDigest: input.payloadDigest,
      envelopeDigestVersion: input.envelopeDigestVersion,
      envelopeDigestAlgorithm: input.envelopeDigestAlgorithm,
      envelopeDigest: input.envelopeDigest,
      decisionId: input.decisionId,
      acknowledgedAt: normalizeDbTimestamp(event.acked_at ?? ''),
      replayed: true,
    };
  }
  if (
    event.status !== 'claimed' ||
    !event.lease_expires_at ||
    Date.parse(event.lease_expires_at) <= Date.now()
  )
    throw new InvestSignalError('SIGNAL_LEASE_EXPIRED', 409);
  const ack = await client.query<{ acked_at: string }>(
    `UPDATE cloud_invest_signal_events SET status='acked',ack_decision_id=$5,ack_idempotency_key=$6,acked_at=now()
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND lease_id=$4 AND lease_fence=$7
        RETURNING acked_at::text`,
    [
      identity.tenantId,
      identity.workspaceId,
      event.id,
      input.leaseId,
      input.decisionId,
      input.idempotencyKey,
      event.lease_fence,
    ],
  );
  if (!ack.rows[0]) throw new InvestSignalError('SIGNAL_LEASE_STALE', 409);
  return {
    status: 'acked',
    eventId: input.eventId,
    payloadDigest: input.payloadDigest,
    envelopeDigestVersion: input.envelopeDigestVersion,
    envelopeDigestAlgorithm: input.envelopeDigestAlgorithm,
    envelopeDigest: input.envelopeDigest,
    decisionId: input.decisionId,
    acknowledgedAt: normalizeDbTimestamp(ack.rows[0].acked_at),
    replayed: false,
  };
}

export async function markInvestSignalNotificationSucceeded(
  connectionString: string,
  tenantId: string,
  workspaceId: string,
  jobId: string,
  notifiedDigest: string,
): Promise<boolean> {
  if (!DIGEST.test(notifiedDigest)) return false;
  return withNeonTransaction(connectionString, { tenantId, workspaceId }, async (client) => {
    const row = await client.query<{ job_type: string; payload: unknown; status: string }>(
      `SELECT job_type,payload,status FROM cloud_queue_jobs WHERE id=$1 FOR UPDATE`,
      [jobId],
    );
    if (!row.rows[0]) return false;
    const payload = objectValue(row.rows[0].payload);
    if (
      row.rows[0].job_type !== 'invest.signal.received' ||
      !payload ||
      typeof payload['eventRecordId'] !== 'string' ||
      !UUID.test(payload['eventRecordId']) ||
      typeof payload['payloadDigest'] !== 'string' ||
      !DIGEST.test(payload['payloadDigest']) ||
      payload['payloadDigest'] !== notifiedDigest
    )
      return false;
    const event = await client.query<{ id: string }>(
      `SELECT id::text FROM cloud_invest_signal_events
        WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND encode(payload_digest,'hex')=$4`,
      [payload['eventRecordId'], tenantId, workspaceId, payload['payloadDigest']],
    );
    if (!event.rows[0]) return false;
    await client.query(
      `UPDATE cloud_queue_jobs SET status='succeeded',locked_until=NULL,last_error_code=NULL,updated_at=now()
        WHERE id=$1 AND status IN ('pending','running')`,
      [jobId],
    );
    return true;
  });
}

function validIsoTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value))
  );
}

function decimalIsZero(value: string): boolean {
  return !/[1-9]/.test(value);
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{86}$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==';
    const binary = atob(padded);
    return Uint8Array.from(binary, (item) => item.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importSigningKey(source: InvestSignalKeyMaterial): Promise<CryptoKey> {
  const jwk = source.publicJwk as JsonWebKey & Record<string, unknown>;
  if (
    'd' in jwk ||
    (jwk.kid !== undefined && jwk.kid !== source.keyId) ||
    (jwk.use !== undefined && jwk.use !== 'sig') ||
    (jwk.alg !== undefined &&
      jwk.alg !== source.signingAlg &&
      !(source.signingAlg === 'EdDSA' && jwk.alg === 'Ed25519'))
  ) {
    throw new InvestSignalError('SIGNAL_KEY_CONFIGURATION_INVALID', 503);
  }
  const allowed =
    source.signingAlg === 'ES256'
      ? ['kty', 'crv', 'x', 'y', 'kid', 'use', 'alg', 'key_ops', 'ext']
      : ['kty', 'crv', 'x', 'kid', 'use', 'alg', 'key_ops', 'ext'];
  if (Object.keys(jwk).some((key) => !allowed.includes(key)))
    throw new InvestSignalError('SIGNAL_KEY_CONFIGURATION_INVALID', 503);
  try {
    if (
      source.signingAlg === 'ES256' &&
      jwk.kty === 'EC' &&
      jwk.crv === 'P-256' &&
      typeof jwk.x === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(jwk.x) &&
      typeof jwk.y === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(jwk.y)
    ) {
      return await crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
    }
    if (
      source.signingAlg === 'EdDSA' &&
      jwk.kty === 'OKP' &&
      jwk.crv === 'Ed25519' &&
      typeof jwk.x === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(jwk.x)
    ) {
      return await crypto.subtle.importKey(
        'jwk',
        { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
    }
  } catch {
    /* report the same fail-closed configuration error */
  }
  throw new InvestSignalError('SIGNAL_KEY_CONFIGURATION_INVALID', 503);
}

interface SourceDbRow extends Record<string, unknown> {
  tenant_id: string;
  workspace_id: string;
  source_id: string;
  key_id: string;
  signing_alg: string;
  public_jwk: unknown;
  allowed_algorithm_ids: unknown;
  allowed_symbols: unknown;
  max_age_seconds: number;
  max_lifetime_seconds: number;
  max_events_per_minute: number;
}

interface ResolutionDbRow extends Record<string, unknown> {
  source_id: string;
  key_id: string;
  signing_alg: string;
  public_jwk: unknown;
  active: boolean;
}

function mapVerificationKey(row: ResolutionDbRow): InvestSignalVerificationKey {
  const jwk = objectValue(row.public_jwk);
  if (!jwk || (row.signing_alg !== 'ES256' && row.signing_alg !== 'EdDSA') || typeof row.active !== 'boolean')
    throw new InvestSignalError('SIGNAL_KEY_CONFIGURATION_INVALID', 503);
  return {
    sourceId: row.source_id.toLowerCase(),
    keyId: row.key_id.toLowerCase(),
    signingAlg: row.signing_alg,
    publicJwk: jwk as JsonWebKey,
    active: row.active,
  };
}

function mapSource(row: SourceDbRow): InvestSignalSourceKey {
  const jwk = objectValue(row.public_jwk);
  const algorithmIds = row.allowed_algorithm_ids;
  const symbols = row.allowed_symbols;
  if (
    !jwk ||
    (row.signing_alg !== 'ES256' && row.signing_alg !== 'EdDSA') ||
    !Array.isArray(algorithmIds) ||
    !algorithmIds.every((item) => typeof item === 'string' && ALGORITHM_ID.test(item)) ||
    !Array.isArray(symbols) ||
    !symbols.every((item) => typeof item === 'string' && SYMBOL.test(item)) ||
    !Number.isSafeInteger(row.max_age_seconds) ||
    row.max_age_seconds < 30 ||
    row.max_age_seconds > 3600 ||
    !Number.isSafeInteger(row.max_lifetime_seconds) ||
    row.max_lifetime_seconds < 1 ||
    row.max_lifetime_seconds > 900 ||
    !Number.isSafeInteger(row.max_events_per_minute) ||
    row.max_events_per_minute < 1 ||
    row.max_events_per_minute > 600
  )
    throw new InvestSignalError('SIGNAL_KEY_CONFIGURATION_INVALID', 503);
  return {
    tenantId: row.tenant_id.toLowerCase(),
    workspaceId: row.workspace_id.toLowerCase(),
    sourceId: row.source_id.toLowerCase(),
    keyId: row.key_id.toLowerCase(),
    signingAlg: row.signing_alg,
    publicJwk: jwk as JsonWebKey,
    allowedAlgorithmIds: algorithmIds as string[],
    allowedSymbols: symbols as string[],
    maxAgeSeconds: row.max_age_seconds,
    maxLifetimeSeconds: row.max_lifetime_seconds,
    maxEventsPerMinute: row.max_events_per_minute,
  };
}

function sameSourceKey(left: InvestSignalSourceKey, right: InvestSignalSourceKey): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId &&
    left.sourceId === right.sourceId &&
    left.keyId === right.keyId &&
    left.signingAlg === right.signingAlg &&
    stableJson(left.publicJwk) === stableJson(right.publicJwk) &&
    JSON.stringify(left.allowedAlgorithmIds) === JSON.stringify(right.allowedAlgorithmIds) &&
    JSON.stringify(left.allowedSymbols) === JSON.stringify(right.allowedSymbols) &&
    left.maxAgeSeconds === right.maxAgeSeconds &&
    left.maxLifetimeSeconds === right.maxLifetimeSeconds &&
    left.maxEventsPerMinute === right.maxEventsPerMinute
  );
}

// PostgreSQL jsonb returns object keys in canonical order rather than insertion order.
// Compare the complete allowlist snapshot independent of that serialization detail.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', arrayBuffer(input)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return objectValue(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseEnvelope(value: unknown): VerifiedInvestSignalEnvelope {
  const parsed = objectValue(value);
  const expectedKeys = [
    'protocol',
    'eventId',
    'occurredAt',
    'expiresAt',
    'algorithmId',
    'signalId',
    'symbol',
    'side',
    'quantity',
    'sourceId',
    'tenantId',
    'workspaceId',
    'receivedAt',
    'payloadDigest',
    'verification',
    'envelopeDigestVersion',
    'envelopeDigestAlgorithm',
    'envelopeDigest',
  ];
  const verification = parsed && objectValue(parsed['verification']);
  if (
    !parsed ||
    Object.keys(parsed).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in parsed)) ||
    parsed['protocol'] !== INVEST_SIGNAL_PROTOCOL ||
    typeof parsed['eventId'] !== 'string' ||
    !EVENT_ID.test(parsed['eventId']) ||
    typeof parsed['occurredAt'] !== 'string' ||
    !validIsoTimestamp(parsed['occurredAt']) ||
    typeof parsed['expiresAt'] !== 'string' ||
    !validIsoTimestamp(parsed['expiresAt']) ||
    typeof parsed['algorithmId'] !== 'string' ||
    !ALGORITHM_ID.test(parsed['algorithmId']) ||
    typeof parsed['signalId'] !== 'string' ||
    !UUID.test(parsed['signalId']) ||
    typeof parsed['symbol'] !== 'string' ||
    !SYMBOL.test(parsed['symbol']) ||
    (parsed['side'] !== 'buy' && parsed['side'] !== 'sell') ||
    typeof parsed['quantity'] !== 'string' ||
    !QUANTITY.test(parsed['quantity']) ||
    typeof parsed['payloadDigest'] !== 'string' ||
    !DIGEST.test(parsed['payloadDigest']) ||
    typeof parsed['sourceId'] !== 'string' ||
    !UUID.test(parsed['sourceId']) ||
    typeof parsed['tenantId'] !== 'string' ||
    !UUID.test(parsed['tenantId']) ||
    typeof parsed['workspaceId'] !== 'string' ||
    !UUID.test(parsed['workspaceId']) ||
    typeof parsed['receivedAt'] !== 'string' ||
    !validIsoTimestamp(parsed['receivedAt']) ||
    !verification ||
    Object.keys(verification).length !== 3 ||
    verification['signature'] !== 'verified' ||
    typeof verification['keyId'] !== 'string' ||
    !UUID.test(verification['keyId']) ||
    (verification['signingAlg'] !== 'ES256' && verification['signingAlg'] !== 'EdDSA') ||
    parsed['envelopeDigestVersion'] !== INVEST_SIGNAL_ENVELOPE_DIGEST_VERSION ||
    parsed['envelopeDigestAlgorithm'] !== INVEST_SIGNAL_ENVELOPE_DIGEST_ALGORITHM ||
    typeof parsed['envelopeDigest'] !== 'string' ||
    !DIGEST.test(parsed['envelopeDigest'])
  )
    throw new InvestSignalError('SIGNAL_RECORD_INVALID', 503);
  return parsed as unknown as VerifiedInvestSignalEnvelope;
}

async function parseAndVerifyEnvelope(value: unknown): Promise<VerifiedInvestSignalEnvelope> {
  const envelope = parseEnvelope(value);
  if (!(await verifyInvestSignalEnvelopeDigest(envelope)))
    throw new InvestSignalError('SIGNAL_RECORD_INVALID', 503);
  return envelope;
}

function normalizeDbTimestamp(value: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new InvestSignalError('SIGNAL_RECORD_INVALID', 503);
  return new Date(millis).toISOString();
}

async function readSignalJob(
  client: NeonQueryClient,
  source: InvestSignalSourceKey,
  eventId: string,
  digest: string,
): Promise<string | null> {
  const row = await client.query<{ id: string }>(
    `SELECT id::text FROM cloud_queue_jobs
      WHERE tenant_id=$1 AND workspace_id=$2 AND job_type='invest.signal.received' AND idempotency_key=$3
        AND payload->>'payloadDigest'=$4`,
    [source.tenantId, source.workspaceId, `${source.sourceId}:${eventId}`, digest],
  );
  return row.rows[0]?.id ?? null;
}

interface EventDbRow extends Record<string, unknown> {
  id: string;
  payload_digest: string;
  envelope: unknown;
  received_at: string;
  queue_job_id: string | null;
}
interface ClaimDbRow extends Record<string, unknown> {
  lease_id: string;
  lease_fence: number;
  expires_at: string;
  status: string;
  envelope: unknown;
}
interface ClaimableDbRow extends Record<string, unknown> {
  id: string;
  envelope: unknown;
  lease_fence: number;
}
interface AckDbRow extends Record<string, unknown> {
  id: string;
  payload_digest: string;
  status: string;
  claim_device_id: string | null;
  lease_id: string;
  lease_fence: number;
  lease_expires_at: string | null;
  ack_decision_id: string | null;
  ack_idempotency_key: string | null;
  acked_at: string | null;
  envelope: unknown;
}

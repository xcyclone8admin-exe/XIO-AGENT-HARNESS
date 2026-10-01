import { describe, expect, it } from 'vitest';
import {
  CLOUD_INGESTION_V2_TEST_VECTORS as vector,
  CLOUD_INVEST_SIGNAL_ENVELOPE_DIGEST_TEST_VECTOR as signalVector,
  CloudBrainIngestionBeginRequest,
  CloudBrainIngestionFinalizationReceipt,
  CloudBlobReferenceIssueRequest,
  CloudInvestSignalEnvelopeDigestInputSchema,
  canonicalCloudIngestionJson,
  cloudBrainContentDigest,
  cloudBrainSourceVersion,
  cloudInvestSignalEnvelopeDigest,
  cloudReferenceSetDigest,
  normalizeCloudBrainContent,
} from './erasure';

describe('cloud ingestion v2 canonical contract', () => {
  it('matches the shared cross-runtime content, reference, and source-version vectors', async () => {
    expect(await cloudBrainContentDigest(vector.normalizedContent)).toBe(vector.contentDigest);
    expect(
      await cloudReferenceSetDigest({
        sourceId: vector.sourceId,
        sourceVersionId: vector.sourceVersionId,
        objectRefIds: [...vector.objectRefIds],
      }),
    ).toBe(vector.referenceSetDigest);
    expect(
      await cloudBrainSourceVersion({
        protocolVersion: 'cloud-ingest-v2',
        sourceId: vector.sourceId,
        sourceVersionId: vector.sourceVersionId,
        tenantId: vector.tenantId,
        workspaceId: vector.workspaceId,
        contentDigest: vector.contentDigest,
        objectRefIds: [...vector.objectRefIds],
        referenceStateVersion: vector.referenceStateVersion,
      }),
    ).toBe(vector.sourceVersion);
  });

  it('binds the normalized Cloud Invest claim, scope, digest, and enrolled signing key', async () => {
    const envelope = {
      protocol: 'xyra.invest.signal.v1',
      eventId: 'feed:event-1',
      occurredAt: '2026-09-30T12:00:00.000Z',
      expiresAt: '2026-09-30T12:05:00.000Z',
      algorithmId: 'momentum-v1',
      signalId: '00000000-0000-4000-8000-000000000001',
      symbol: 'XYRA',
      side: 'buy' as const,
      quantity: '2.5',
      sourceId: '00000000-0000-4000-8000-000000000002',
      tenantId: '00000000-0000-4000-8000-000000000003',
      workspaceId: '00000000-0000-4000-8000-000000000004',
      receivedAt: '2026-09-30T12:00:01.000Z',
      payloadDigest: 'a'.repeat(64),
      verification: {
        signature: 'verified' as const,
        keyId: '00000000-0000-4000-8000-000000000005',
        signingAlg: 'ES256' as const,
      },
    } as const;
    const digest = await cloudInvestSignalEnvelopeDigest(envelope);
    expect(digest).toBe(signalVector.digest);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await cloudInvestSignalEnvelopeDigest({ ...envelope, quantity: '2.50' })).not.toBe(digest);
    expect(
      await cloudInvestSignalEnvelopeDigest({ ...envelope, verification: { ...envelope.verification, signingAlg: 'EdDSA' } }),
    ).not.toBe(digest);
    expect(CloudInvestSignalEnvelopeDigestInputSchema.safeParse({ ...envelope, callerClaimed: true }).success).toBe(false);
  });

  it('rejects uppercase UUID spellings and mixed-case duplicate aliases', () => {
    expect(
      CloudBrainIngestionBeginRequest.safeParse({
        protocolVersion: 'cloud-ingest-v2',
        sourceId: 'ABCDEFAB-0000-4000-8000-000000000001',
        mode: 'text_only',
      }).success,
    ).toBe(false);
    expect(
      CloudBrainIngestionFinalizationReceipt.safeParse({
        protocolVersion: 'cloud-ingest-v2',
        status: 'finalized',
        ingestionId: vector.sourceId,
        sourceId: vector.sourceId,
        sourceVersionId: vector.sourceVersionId,
        sourceVersion: vector.sourceVersion,
        tenantId: vector.tenantId,
        workspaceId: vector.workspaceId,
        contentDigest: vector.contentDigest,
        referenceState: 'verified_nonempty',
        objectRefIds: ['abcdefab-0000-4000-8000-000000000001', 'ABCDEFAB-0000-4000-8000-000000000001'],
        referenceSetDigest: vector.referenceSetDigest,
        referenceStateVersion: vector.referenceStateVersion,
        finalizedAt: '2026-09-30T12:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('bounds tracked blob issuance and rejects caller-selected IDs', () => {
    expect(
      CloudBlobReferenceIssueRequest.safeParse({
        mode: 'PUT',
        name: 'report.pdf',
        expiresInSec: 30,
        ingestionId: vector.sourceId,
      }).success,
    ).toBe(true);
    expect(
      CloudBlobReferenceIssueRequest.safeParse({
        mode: 'PUT',
        name: 'report.pdf',
        expiresInSec: 301,
        ingestionId: vector.sourceId,
      }).success,
    ).toBe(false);
    expect(
      CloudBlobReferenceIssueRequest.safeParse({
        mode: 'PUT',
        name: '../secret',
        expiresInSec: 30,
        ingestionId: vector.sourceId,
      }).success,
    ).toBe(false);
    expect(
      CloudBlobReferenceIssueRequest.safeParse({
        mode: 'PUT',
        name: 'report.pdf',
        expiresInSec: 30,
        ingestionId: vector.sourceId,
        objectRefId: vector.sourceVersionId,
      }).success,
    ).toBe(false);
  });

  it('uses property-order-independent canonical JSON and rejects non-JSON values', () => {
    expect(canonicalCloudIngestionJson({ b: 2, a: { z: true, c: 'x' } })).toBe(
      canonicalCloudIngestionJson({ a: { c: 'x', z: true }, b: 2 }),
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalCloudIngestionJson(cyclic)).toThrow(/cycles/);
    expect(() => canonicalCloudIngestionJson({ value: undefined })).toThrow(/undefined/);
  });

  it('normalizes line endings and Unicode composition without trimming content', () => {
    expect(normalizeCloudBrainContent('Cafe\u0301\r\nline\r')).toBe('Café\nline\n');
  });
});

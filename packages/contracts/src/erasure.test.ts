import { describe, expect, it } from 'vitest';
import {
  CLOUD_INGESTION_V2_TEST_VECTORS as vector,
  CloudBrainIngestionBeginRequest,
  CloudBrainIngestionFinalizationReceipt,
  CloudBlobReferenceIssueRequest,
  canonicalCloudIngestionJson,
  cloudBrainContentDigest,
  cloudBrainSourceVersion,
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

import { canonicalJson, sha256Hex } from '@xyra/core';

/** Cloud's immutable cloud-ingest-v2 receipt binding; unknown refs never normalize to empty. */
export async function brainSourceVersionV2(input: {
  sourceId: string; sourceVersionId: string; tenantId: string; workspaceId: string; contentDigest: string;
  objectRefIds: readonly string[]; referenceStateVersion: number;
}): Promise<string> {
  if (!input.referenceStateVersion || !/^[0-9a-f]{64}$/.test(input.contentDigest)) throw new Error('SOURCE_STATE_UNAVAILABLE');
  if (input.objectRefIds.some((id) => id !== id.toLowerCase())) throw new Error('SOURCE_REFERENCE_ID_INVALID');
  const sortedIds = [...input.objectRefIds].sort(compareCodePoint);
  if (new Set(sortedIds).size !== sortedIds.length) throw new Error('SOURCE_REFERENCE_DUPLICATE');
  const hash = await sha256Hex(canonicalJson({
    protocolVersion: 'cloud-ingest-v2', sourceId: input.sourceId, sourceVersionId: input.sourceVersionId,
    tenantId: input.tenantId, workspaceId: input.workspaceId, contentDigest: input.contentDigest,
    objectRefIds: sortedIds, referenceStateVersion: input.referenceStateVersion,
  }));
  return `cloud-ingest-v2:sha256:${hash}`;
}

export async function brainReferenceSetDigest(sourceId: string, sourceVersionId: string, objectRefIds: readonly string[]): Promise<string> {
  const sortedIds = [...objectRefIds].sort(compareCodePoint);
  if (new Set(sortedIds).size !== sortedIds.length) throw new Error('SOURCE_REFERENCE_DUPLICATE');
  return sha256Hex(canonicalJson({ sourceId, sourceVersionId, objectRefIds: sortedIds }));
}

function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function erasureEvidenceDigest(value: unknown): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(value))}`;
}

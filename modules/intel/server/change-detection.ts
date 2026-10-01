/**
 * Pure, deterministic change-detection diff logic. No database access, so this is directly
 * unit-testable. Fixture/manual-input driven (XIO-REQ-INT-001): given an observed content
 * snapshot for a source and the last recorded snapshot (if any), decides whether the content
 * changed and, if so, produces a summary.
 */
export interface SnapshotLike {
  readonly id: string;
  readonly contentHash: string;
  readonly content: string;
}

export interface DiffResult {
  readonly changed: boolean;
  readonly summary: string | null;
}

/** Deterministic, dependency-free content hash (not cryptographic; good enough to detect byte-identical content). */
export function hashContent(content: string): string {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Compares a newly observed snapshot against the previous one (or none). Content is considered
 * changed when the hash differs. The summary never fabricates specifics beyond what the raw
 * content shows: it reports lengths and a truncated excerpt of the new content.
 */
export function diffSnapshots(previous: SnapshotLike | null, current: SnapshotLike): DiffResult {
  if (!previous) {
    return { changed: true, summary: `New source content observed (${current.content.length} chars): ${truncate(current.content, 240)}` };
  }
  if (previous.contentHash === current.contentHash) {
    return { changed: false, summary: null };
  }
  return {
    changed: true,
    summary: `Content changed from ${previous.content.length} to ${current.content.length} chars. New excerpt: ${truncate(current.content, 240)}`,
  };
}

import { describe, expect, it } from 'vitest';
import { diffSnapshots, hashContent } from '../server/change-detection';

describe('change-detection diff logic (pure, DB-independent)', () => {
  it('hashContent is deterministic and sensitive to content differences', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'));
    expect(hashContent('hello')).not.toBe(hashContent('world'));
  });

  it('treats a first-ever observation as changed', () => {
    const result = diffSnapshots(null, { id: 'a', contentHash: hashContent('new'), content: 'new' });
    expect(result.changed).toBe(true);
    expect(result.summary).toBeTruthy();
  });

  it('reports no change when content is identical', () => {
    const hash = hashContent('same content');
    const previous = { id: 'a', contentHash: hash, content: 'same content' };
    const current = { id: 'b', contentHash: hash, content: 'same content' };
    const result = diffSnapshots(previous, current);
    expect(result.changed).toBe(false);
    expect(result.summary).toBeNull();
  });

  it('reports a change with a summary when content differs', () => {
    const previous = { id: 'a', contentHash: hashContent('version one'), content: 'version one' };
    const current = { id: 'b', contentHash: hashContent('version two'), content: 'version two' };
    const result = diffSnapshots(previous, current);
    expect(result.changed).toBe(true);
    expect(result.summary).toContain('Content changed');
  });
});

import { describe, expect, it } from 'vitest';
import { keywordMatchScore, recencyScore, scoreRelevance } from '../server/relevance';

describe('relevance scoring (pure, DB-independent)', () => {
  it('is deterministic: the same input always yields the same score', () => {
    const input = { text: 'Acme Corp announced a new product launch', keywords: ['Acme', 'launch'], observedAt: '2026-09-29T00:00:00.000Z', now: '2026-09-30T00:00:00.000Z' };
    expect(scoreRelevance(input)).toBe(scoreRelevance({ ...input }));
    expect(scoreRelevance(input)).toBe(scoreRelevance(input));
  });

  it('scores a more keyword-relevant and more recent input higher than a less relevant one', () => {
    const now = '2026-09-30T00:00:00.000Z';
    const moreRelevant = scoreRelevance({ text: 'Acme Corp announced a funding round', keywords: ['Acme', 'funding'], observedAt: '2026-09-30T00:00:00.000Z', now });
    const lessRelevant = scoreRelevance({ text: 'An unrelated market update', keywords: ['Acme', 'funding'], observedAt: '2026-01-01T00:00:00.000Z', now });
    expect(moreRelevant).toBeGreaterThan(lessRelevant);
  });

  it('keywordMatchScore is the fraction of keywords found, case-insensitively', () => {
    expect(keywordMatchScore('Acme launched a product', ['Acme', 'launched', 'missing'])).toBeCloseTo(2 / 3, 5);
    expect(keywordMatchScore('no keywords supplied', [])).toBe(0);
  });

  it('recencyScore decays toward 0 as age increases and is 1 at zero age', () => {
    const now = '2026-09-30T00:00:00.000Z';
    expect(recencyScore(now, now)).toBeCloseTo(1, 5);
    const old = recencyScore('2020-01-01T00:00:00.000Z', now);
    expect(old).toBeGreaterThanOrEqual(0);
    expect(old).toBeLessThan(0.01);
  });
});

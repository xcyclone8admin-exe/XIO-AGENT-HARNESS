/**
 * Pure, deterministic relevance scoring (weighted recency + keyword/target match). No
 * database access, so this is directly unit-testable (XIO-REQ-INT-001).
 *
 * Score = keywordScore * KEYWORD_WEIGHT + recencyScore * RECENCY_WEIGHT, each component in
 * [0, 1], so the result is always in [0, 1]. Same input always yields the same score.
 */
export interface RelevanceInput {
  readonly text: string;
  readonly keywords: readonly string[];
  readonly observedAt: string;
  readonly now: string;
}

const KEYWORD_WEIGHT = 0.7;
const RECENCY_WEIGHT = 0.3;
/** Recency decays to ~0 after this many days; chosen so "today" scores near 1 and "a month ago" scores near 0. */
const RECENCY_HALF_LIFE_DAYS = 7;

export function keywordMatchScore(text: string, keywords: readonly string[]): number {
  if (!keywords.length) return 0;
  const haystack = text.toLowerCase();
  let matched = 0;
  for (const keyword of keywords) {
    if (keyword.trim() && haystack.includes(keyword.trim().toLowerCase())) matched += 1;
  }
  return matched / keywords.length;
}

export function recencyScore(observedAt: string, now: string): number {
  const observedMs = Date.parse(observedAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(observedMs) || Number.isNaN(nowMs)) return 0;
  const ageDays = Math.max(0, (nowMs - observedMs) / (1000 * 60 * 60 * 24));
  return Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
}

export function scoreRelevance(input: RelevanceInput): number {
  const keywordScore = keywordMatchScore(input.text, input.keywords);
  const recency = recencyScore(input.observedAt, input.now);
  const score = keywordScore * KEYWORD_WEIGHT + recency * RECENCY_WEIGHT;
  return Math.round(score * 10000) / 10000;
}

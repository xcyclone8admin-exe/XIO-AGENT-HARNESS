import { EpicState, FindingState, PromotionState, TicketState } from '../contracts';

type TransitionTable = Readonly<Record<string, readonly string[]>>;

export const EPIC_TRANSITIONS: TransitionTable = {
  draft: ['proposed', 'canceled'], proposed: ['draft', 'approved', 'canceled'], approved: ['active', 'canceled'],
  active: ['blocked', 'review', 'complete', 'canceled'], blocked: ['active', 'canceled'],
  review: ['active', 'complete', 'blocked'], complete: [], canceled: [],
};
export const TICKET_TRANSITIONS: TransitionTable = {
  ready: ['queued', 'blocked', 'canceled'], queued: ['running', 'ready', 'blocked', 'canceled'],
  running: ['blocked', 'review', 'done', 'failed', 'canceled'], blocked: ['ready', 'canceled'],
  review: ['running', 'done', 'blocked'], done: [], failed: ['ready', 'canceled'], canceled: [],
};
export const FINDING_TRANSITIONS: TransitionTable = {
  open: ['triaged'], triaged: ['accepted', 'fixed', 'waived'], accepted: ['open', 'fixed', 'waived'],
  fixed: ['verified', 'open'], verified: ['open'], waived: ['open'],
};
export const PROMOTION_TRANSITIONS: TransitionTable = {
  proposed: ['gates-passed', 'rejected'], 'gates-passed': ['approved', 'rejected'],
  approved: ['promoted', 'rejected'], promoted: ['rolled-back'], 'rolled-back': [], rejected: [],
};

function transition(schema: { parse(value: unknown): string }, table: TransitionTable, current: string, next: string): string {
  const from = schema.parse(current);
  const to = schema.parse(next);
  if (!table[from]?.includes(to)) throw new Error(`ILLEGAL_TRANSITION:${from}->${to}`);
  return to;
}

export const transitionEpic = (from: string, to: string) => transition(EpicState, EPIC_TRANSITIONS, from, to);
export const transitionTicket = (from: string, to: string) => transition(TicketState, TICKET_TRANSITIONS, from, to);
export const transitionFinding = (from: string, to: string) => transition(FindingState, FINDING_TRANSITIONS, from, to);
export const transitionPromotion = (from: string, to: string) => transition(PromotionState, PROMOTION_TRANSITIONS, from, to);

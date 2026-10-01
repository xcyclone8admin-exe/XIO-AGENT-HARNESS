import type { MissedJobPolicy } from '../contracts';

/**
 * Pure scheduling decision for a workflow that missed one or more scheduled firings (e.g. the
 * sidecar was offline). FLOW owns the policy, not a scheduler: the host's cron/trigger code calls
 * this once it knows a scheduled firing was missed, and only calls triggerRun when the result is
 * 'run'. 'skip' discards the missed firing; 'run-once' catches up with exactly one run no matter
 * how many firings were missed, and never catches up twice for the same missed window.
 */
export function decideMissedJobAction(
  policy: MissedJobPolicy,
  scheduledAt: Date,
  lastTriggeredAt: Date | null,
  now: Date,
): 'run' | 'skip' {
  if (scheduledAt.getTime() > now.getTime()) throw new Error('FLOW_SCHEDULE_NOT_YET_DUE');
  if (policy === 'skip') return 'skip';
  // run-once: catch up only if nothing has run since this firing was scheduled.
  if (lastTriggeredAt && lastTriggeredAt.getTime() >= scheduledAt.getTime()) return 'skip';
  return 'run';
}

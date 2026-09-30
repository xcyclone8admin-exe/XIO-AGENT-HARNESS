import type { RunBudget, RunCounters, RunTermination } from './contracts';

export type BudgetCheck = { readonly allowed: true } | { readonly allowed: false; readonly termination: RunTermination };

/** Deterministic, in-memory accounting for one run. Durable persistence belongs to the caller's journal. */
export class BudgetTracker {
  private counters: RunCounters = { iterations: 0, actions: 0, failures: 0, costUsd: 0 };

  constructor(
    private readonly budget: RunBudget,
    private readonly startedAtMs: number,
  ) {}

  snapshot(): RunCounters {
    return { ...this.counters };
  }

  check(nowMs: number): BudgetCheck {
    if (nowMs - this.startedAtMs >= this.budget.maxDurationMs) return { allowed: false, termination: 'TIMEOUT' };
    if (this.counters.costUsd > this.budget.maxCostUsd) return { allowed: false, termination: 'BUDGET_EXCEEDED' };
    if (this.counters.actions >= this.budget.maxActions) return { allowed: false, termination: 'BUDGET_EXCEEDED' };
    if (this.counters.failures >= this.budget.maxFailures) return { allowed: false, termination: 'BUDGET_EXCEEDED' };
    if (this.counters.iterations >= this.budget.maxIterations) return { allowed: false, termination: 'BUDGET_EXCEEDED' };
    return { allowed: true };
  }

  recordIteration(): void {
    this.counters = { ...this.counters, iterations: this.counters.iterations + 1 };
  }

  recordAction(): void {
    this.counters = { ...this.counters, actions: this.counters.actions + 1 };
  }

  recordFailure(): void {
    this.counters = { ...this.counters, failures: this.counters.failures + 1 };
  }

  recordCost(costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error('Cost must be a finite non-negative number');
    this.counters = { ...this.counters, costUsd: this.counters.costUsd + costUsd };
  }
}

/** A run-local cost breaker; daily/workspace breakers are ledger-owned integration work. */
export class CostCircuitBreaker {
  private spentUsd = 0;

  constructor(private readonly ceilingUsd: number) {
    if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0) throw new Error('Cost ceiling must be a finite non-negative number');
  }

  canSpend(costUsd: number): boolean {
    return Number.isFinite(costUsd) && costUsd >= 0 && this.spentUsd + costUsd <= this.ceilingUsd;
  }

  record(costUsd: number): void {
    if (!this.canSpend(costUsd)) throw new Error('COST_CIRCUIT_OPEN');
    this.spentUsd += costUsd;
  }

  remaining(): number {
    return this.ceilingUsd - this.spentUsd;
  }
}

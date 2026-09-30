import type { RunEvent } from './contracts';

/** Implementations write append-only events; the module/db layer owns durable storage and replay. */
export interface RunJournal {
  record(event: RunEvent): void;
  events(runId: string): readonly RunEvent[];
}

export class InMemoryRunJournal implements RunJournal {
  private readonly byRun = new Map<string, RunEvent[]>();

  record(event: RunEvent): void {
    this.byRun.set(event.runId, [...(this.byRun.get(event.runId) ?? []), event]);
  }

  events(runId: string): readonly RunEvent[] {
    return this.byRun.get(runId) ?? [];
  }
}

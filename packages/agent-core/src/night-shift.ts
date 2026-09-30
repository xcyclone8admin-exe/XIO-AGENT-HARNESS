import type { NightShiftLeash, NightShiftState } from './contracts';

export interface NightShiftRunRequest {
  readonly estimatedCostUsd: number;
  readonly capabilityIds: readonly string[];
  readonly autonomyLevel: number;
}

export type NightShiftDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/** Local leash state. Lease acquisition and cross-device coordination are deliberately WP-CLOUD-owned. */
export class NightShiftController {
  private state: NightShiftState = 'IDLE';
  private leash: NightShiftLeash | undefined;
  private runs = 0;
  private spentUsd = 0;

  configure(leash: NightShiftLeash): void {
    this.leash = leash;
    this.runs = 0;
    this.spentUsd = 0;
    this.state = 'IDLE';
  }

  begin(input: { readonly desktopRunning: boolean; readonly leaseAvailable: boolean; readonly killSwitchEngaged: boolean }): NightShiftState {
    if (input.killSwitchEngaged) return this.kill();
    if (!input.desktopRunning) {
      this.state = 'MISSED';
      return this.state;
    }
    if (!input.leaseAvailable) {
      this.state = 'WAITING_FOR_LEASE';
      return this.state;
    }
    if (!this.leash) throw new Error('NIGHT_SHIFT_NOT_CONFIGURED');
    this.state = 'RUNNING';
    return this.state;
  }

  canStart(request: NightShiftRunRequest): NightShiftDecision {
    if (this.state !== 'RUNNING') return { allowed: false, reason: `NIGHT_SHIFT_${this.state}` };
    const leash = this.leash;
    if (!leash) return { allowed: false, reason: 'NIGHT_SHIFT_NOT_CONFIGURED' };
    if (this.runs >= leash.maxRuns) return { allowed: false, reason: 'NIGHT_SHIFT_RUN_CAP' };
    if (this.spentUsd + request.estimatedCostUsd > leash.maxSpendUsd) return { allowed: false, reason: 'NIGHT_SHIFT_SPEND_CAP' };
    if (request.autonomyLevel > leash.autonomyCeiling) return { allowed: false, reason: 'NIGHT_SHIFT_AUTONOMY_CEILING' };
    if (!request.capabilityIds.every((id) => leash.allowedCapabilityIds.includes(id))) {
      return { allowed: false, reason: 'NIGHT_SHIFT_CAPABILITY_DENIED' };
    }
    return { allowed: true };
  }

  recordRun(costUsd: number): void {
    const permitted = this.canStart({ estimatedCostUsd: costUsd, capabilityIds: [], autonomyLevel: 0 });
    if (!permitted.allowed && permitted.reason !== 'NIGHT_SHIFT_CAPABILITY_DENIED') throw new Error(permitted.reason);
    this.runs += 1;
    this.spentUsd += costUsd;
  }

  complete(): NightShiftState {
    if (this.state === 'RUNNING') this.state = 'COMPLETE';
    return this.state;
  }

  kill(): NightShiftState {
    this.state = 'KILLED';
    return this.state;
  }

  currentState(): NightShiftState {
    return this.state;
  }
}

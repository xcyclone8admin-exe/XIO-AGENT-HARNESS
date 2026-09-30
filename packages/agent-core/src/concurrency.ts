export interface RunLease {
  release(): void;
}

/** Synchronous semaphores avoid queueing unbounded agent work in the sidecar. */
export class RunConcurrencyGate {
  private globalActive = 0;
  private readonly workspaceActive = new Map<string, number>();

  constructor(
    private readonly globalLimit = 6,
    private readonly workspaceLimit = 4,
  ) {
    if (!Number.isInteger(globalLimit) || globalLimit < 1) throw new Error('globalLimit must be a positive integer');
    if (!Number.isInteger(workspaceLimit) || workspaceLimit < 1) throw new Error('workspaceLimit must be a positive integer');
  }

  tryAcquire(workspaceId: string): RunLease | undefined {
    const workspaceCount = this.workspaceActive.get(workspaceId) ?? 0;
    if (this.globalActive >= this.globalLimit || workspaceCount >= this.workspaceLimit) return undefined;
    this.globalActive += 1;
    this.workspaceActive.set(workspaceId, workspaceCount + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.globalActive -= 1;
        const remaining = (this.workspaceActive.get(workspaceId) ?? 1) - 1;
        if (remaining === 0) this.workspaceActive.delete(workspaceId);
        else this.workspaceActive.set(workspaceId, remaining);
      },
    };
  }

  active(workspaceId: string): { readonly global: number; readonly workspace: number } {
    return { global: this.globalActive, workspace: this.workspaceActive.get(workspaceId) ?? 0 };
  }
}

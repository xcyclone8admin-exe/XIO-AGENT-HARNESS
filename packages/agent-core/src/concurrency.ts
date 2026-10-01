export interface RunLease {
  release(): void;
}

/** Lease identity: one holder per (workspace, job/trigger, window). */
export interface WorkspaceLeaseKey {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly window: string;
}

export interface WorkspaceLeaseHandle {
  /** Monotonically increasing fencing value; downstream authorities reject stale holders. */
  readonly token: number;
  /** Renews the TTL; false means the lease is lost and the holder must stop. */
  heartbeat(): Promise<boolean>;
  release(): Promise<void>;
}

/** Port implemented by WP-CLOUD (server authority) while a workspace syncs. */
export interface WorkspaceLeasePort {
  acquire(key: WorkspaceLeaseKey, ttlMs: number): Promise<WorkspaceLeaseHandle | undefined>;
}

/**
 * Honest local-only stub for unsynced workspaces: exclusive within this process only, with TTL
 * expiry. It makes no multi-device claim; synced workspaces must inject the cloud port.
 */
export class LocalOnlyLeasePort implements WorkspaceLeasePort {
  private readonly held = new Map<string, { readonly expiry: number; readonly token: number }>();
  private nextToken = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async acquire(key: WorkspaceLeaseKey, ttlMs: number): Promise<WorkspaceLeaseHandle | undefined> {
    const id = JSON.stringify([key.workspaceId, key.jobId, key.window]);
    const held = this.held.get(id);
    if (held !== undefined && held.expiry > this.now()) return undefined;
    const token = ++this.nextToken;
    this.held.set(id, { expiry: this.now() + ttlMs, token });
    return {
      token,
      heartbeat: async () => {
        const current = this.held.get(id);
        if (current === undefined || current.token !== token || current.expiry <= this.now()) return false;
        this.held.set(id, { expiry: this.now() + ttlMs, token });
        return true;
      },
      release: async () => {
        if (this.held.get(id)?.token === token) this.held.delete(id);
      },
    };
  }
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

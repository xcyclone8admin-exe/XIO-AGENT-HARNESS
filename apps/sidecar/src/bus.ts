import type { AnyCapability, ModuleManifest, Principal } from '@xyra/contracts';
import { decidePolicy } from '@xyra/policy';
import { canonicalJson, sha256Hex } from '@xyra/core';

export interface BusAudit {
  append(record: {
    principal: Principal;
    workspaceId: string;
    capabilityId: string;
    result: string;
    detail?: string;
  }): Promise<void>;
}

export interface BusIdempotency {
  get(key: string): Promise<{ inputHash: string; result: unknown } | undefined>;
  put(key: string, inputHash: string, result: unknown): Promise<void>;
}

export interface BusApproval {
  /** Verifies expiry, scope hash, approver authority and single use against durable state. */
  verify(
    principal: Principal,
    workspaceId: string,
    capabilityId: string,
    input: unknown,
    approvalId: string | undefined,
  ): Promise<boolean>;
}

export interface BusCall {
  readonly principal: Principal;
  readonly workspaceId: string;
  readonly capabilityId: string;
  readonly input: unknown;
  readonly idempotencyKey?: string;
  readonly approvalId?: string;
}

export class BusFault extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (input: unknown, call: BusCall) => Promise<unknown>;
interface Entry {
  readonly descriptor: AnyCapability;
  readonly manifest: ModuleManifest;
  readonly handler: Handler;
}

/** All UI, agent, workflow and MCP calls share this path. */
export class CapabilityBus {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<void>>();
  constructor(
    private readonly audit: BusAudit,
    private readonly idempotency: BusIdempotency,
    private readonly approvals: BusApproval,
    private readonly killSwitch: () => boolean,
    private readonly delegatorPermissions: (
      principal: Principal,
      workspaceId: string,
    ) => Promise<ReadonlySet<string>>,
  ) {}

  register(manifest: ModuleManifest, descriptor: AnyCapability, handler: Handler): void {
    if (descriptor.module !== manifest.id || !manifest.permissions.includes(descriptor.permission)) {
      throw new Error(`Capability ${descriptor.id} is not declared by module ${manifest.id}`);
    }
    if (this.entries.has(descriptor.id)) throw new Error(`Duplicate capability ${descriptor.id}`);
    this.entries.set(descriptor.id, { descriptor, manifest, handler });
  }

  async catalog(principal: Principal, workspaceId: string): Promise<AnyCapability[]> {
    const delegatorPermissions = await this.delegatorPermissions(principal, workspaceId);
    return [...this.entries.values()]
      .filter(
        ({ descriptor, manifest }) =>
          decidePolicy({
            principal,
            workspaceId,
            manifest,
            permission: descriptor.permission,
            kind: descriptor.kind,
            risk: descriptor.risk,
            ...(descriptor.sampleOnly === undefined ? {} : { sampleOnly: descriptor.sampleOnly }),
            ...(descriptor.approvalPolicy === undefined ? {} : { approvalPolicy: descriptor.approvalPolicy }),
            approvalVerified: true,
            delegatorPermissions,
            killSwitchEngaged: this.killSwitch(),
          }).status === 'allow',
      )
      .map(({ descriptor }) => descriptor);
  }

  async call(call: BusCall): Promise<unknown> {
    const entry = this.entries.get(call.capabilityId);
    if (!entry) throw new BusFault('CAPABILITY_NOT_FOUND', 404, 'Capability not found');
    const { descriptor, manifest, handler } = entry;
    const parsed = descriptor.input.safeParse(call.input);
    if (!parsed.success) throw new BusFault('INVALID_INPUT', 400, 'Capability input failed validation');
    const policyInput = {
      principal: call.principal,
      workspaceId: call.workspaceId,
      manifest,
      permission: descriptor.permission,
      kind: descriptor.kind,
      risk: descriptor.risk,
      ...(descriptor.sampleOnly === undefined ? {} : { sampleOnly: descriptor.sampleOnly }),
      ...(descriptor.approvalPolicy === undefined ? {} : { approvalPolicy: descriptor.approvalPolicy }),
      delegatorPermissions: await this.delegatorPermissions(call.principal, call.workspaceId),
      killSwitchEngaged: this.killSwitch(),
    };
    let decision = decidePolicy(policyInput);
    if (decision.status === 'approval_required') {
      const approved = await this.approvals.verify(
        call.principal,
        call.workspaceId,
        descriptor.id,
        parsed.data,
        call.approvalId,
      );
      if (approved) decision = decidePolicy({ ...policyInput, approvalVerified: true });
    }
    if (decision.status !== 'allow') {
      // An out-of-scope workspace has no valid tenant-scoped audit destination.
      if (call.principal.workspaces.some((w) => w.id === call.workspaceId)) {
        await this.audit.append({
          principal: call.principal,
          workspaceId: call.workspaceId,
          capabilityId: descriptor.id,
          result: decision.status,
          detail: decision.status === 'deny' ? decision.reason : decision.policy,
        });
      }
      if (decision.status === 'approval_required')
        throw new BusFault('APPROVAL_REQUIRED', 202, decision.policy);
      throw new BusFault(decision.reason, 403, 'Capability denied');
    }
    if (descriptor.kind !== 'read' && !call.idempotencyKey)
      throw new BusFault('IDEMPOTENCY_REQUIRED', 400, 'Idempotency-Key required');
    if (call.idempotencyKey && (call.idempotencyKey.length > 200 || !/^[\x21-\x7e]+$/.test(call.idempotencyKey)))
      throw new BusFault('INVALID_IDEMPOTENCY_KEY', 400, 'Invalid Idempotency-Key');
    const key = call.idempotencyKey
      ? `${call.principal.tenantId}:${call.workspaceId}:${descriptor.id}:${call.idempotencyKey}`
      : undefined;
    const invoke = async (): Promise<unknown> => {
      const inputHash = await sha256Hex(canonicalJson(parsed.data));
      if (key) {
        const previous = await this.idempotency.get(key);
        if (previous) {
          if (previous.inputHash !== inputHash)
            throw new BusFault('IDEMPOTENCY_CONFLICT', 409, 'Key reused with different input');
          return previous.result;
        }
      }
      try {
        const result = descriptor.output.parse(await handler(parsed.data, call));
        if (key) await this.idempotency.put(key, inputHash, result);
        await this.audit.append({ principal: call.principal, workspaceId: call.workspaceId,
          capabilityId: descriptor.id, result: 'succeeded' });
        return result;
      } catch (error) {
        await this.audit.append({ principal: call.principal, workspaceId: call.workspaceId,
          capabilityId: descriptor.id, result: 'failed' });
        throw error;
      }
    };
    if (!key) return invoke();
    // One trusted sidecar process serializes duplicate keys before their handlers run.
    const previous = this.inFlight.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => gate);
    this.inFlight.set(key, current);
    await previous;
    try { return await invoke(); }
    finally {
      release();
      if (this.inFlight.get(key) === current) this.inFlight.delete(key);
    }
  }
}

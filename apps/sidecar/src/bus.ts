import type { AnyCapability, ModuleManifest, Principal } from '@xyra/contracts';
import { decidePolicy } from '@xyra/policy';

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
  get(key: string): Promise<unknown | undefined>;
  put(key: string, result: unknown): Promise<void>;
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

  catalog(principal: Principal, workspaceId: string): AnyCapability[] {
    return [...this.entries.values()]
      .filter(
        ({ descriptor, manifest }) =>
          decidePolicy({
            principal,
            workspaceId,
            manifest,
            permission: descriptor.permission,
            kind: 'read',
            risk: 'low',
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
      await this.audit.append({
        principal: call.principal,
        workspaceId: call.workspaceId,
        capabilityId: descriptor.id,
        result: decision.status,
        detail: decision.status === 'deny' ? decision.reason : decision.policy,
      });
      if (decision.status === 'approval_required')
        throw new BusFault('APPROVAL_REQUIRED', 202, decision.policy);
      throw new BusFault(decision.reason, 403, 'Capability denied');
    }
    if (descriptor.kind !== 'read' && !call.idempotencyKey)
      throw new BusFault('IDEMPOTENCY_REQUIRED', 400, 'Idempotency-Key required');
    const key = call.idempotencyKey
      ? `${call.principal.tenantId}:${call.workspaceId}:${descriptor.id}:${call.idempotencyKey}`
      : undefined;
    if (key) {
      const previous = await this.idempotency.get(key);
      if (previous !== undefined) return previous;
    }
    try {
      const result = descriptor.output.parse(await handler(parsed.data, call));
      if (key) await this.idempotency.put(key, result);
      await this.audit.append({
        principal: call.principal,
        workspaceId: call.workspaceId,
        capabilityId: descriptor.id,
        result: 'succeeded',
      });
      return result;
    } catch (error) {
      await this.audit.append({
        principal: call.principal,
        workspaceId: call.workspaceId,
        capabilityId: descriptor.id,
        result: 'failed',
      });
      throw error;
    }
  }
}

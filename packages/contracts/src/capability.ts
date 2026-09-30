import { z } from 'zod';

/**
 * XIO Capability Bus descriptor (ADR-0004). Declared in a module's contracts.ts (isomorphic);
 * implemented in its server/. The same descriptor drives UI calls, agent tool schemas and MCP exposure.
 */
export const CapabilityKind = z.enum(['read', 'write', 'consequential']);
export type CapabilityKind = z.infer<typeof CapabilityKind>;
export const RiskClass = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskClass = z.infer<typeof RiskClass>;

export interface CapabilityDescriptor<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** `<module>.<resource>.<verb>`, globally unique. */
  readonly id: string;
  readonly module: string;
  readonly title: string;
  readonly description: string;
  readonly kind: CapabilityKind;
  readonly risk: RiskClass;
  /** Permission required (`module:resource:action`). */
  readonly permission: string;
  readonly input: I;
  readonly output: O;
  /** Writes must be idempotent under an Idempotency-Key. */
  readonly idempotent: boolean;
  /** Named approval policy hook evaluated by the policy engine (e.g. 'money.transfer'). */
  readonly approvalPolicy?: string;
  /** Agents may call it (subject to grants/autonomy). Default true for read, false otherwise. */
  readonly agentCallable: boolean;
  /** Allowed only inside sample workspaces (sample-data generators). */
  readonly sampleOnly?: boolean;
  /** Emits these event types on success. */
  readonly emits?: readonly string[];
  readonly cost?: { readonly class: 'free' | 'metered'; readonly unit?: string };
}

export type AnyCapability = CapabilityDescriptor<z.ZodType, z.ZodType>;
export type CapInput<C extends AnyCapability> = z.input<C['input']>;
export type CapOutput<C extends AnyCapability> = z.output<C['output']>;

const CAP_ID_RE = /^[a-z][a-z0-9-]*\.[a-z][a-zA-Z0-9-]*(\.[a-z][a-zA-Z0-9-]*)+$/;

export function defineCapability<I extends z.ZodType, O extends z.ZodType>(
  d: Omit<CapabilityDescriptor<I, O>, 'module' | 'agentCallable' | 'idempotent' | 'risk'> &
    Partial<Pick<CapabilityDescriptor<I, O>, 'agentCallable' | 'idempotent' | 'risk'>>,
): CapabilityDescriptor<I, O> {
  if (!CAP_ID_RE.test(d.id)) throw new Error(`Invalid capability id "${d.id}" (expected module.resource.verb)`);
  const module = d.id.split('.')[0] ?? '';
  if (!d.permission.startsWith(module + ':')) throw new Error(`Capability ${d.id}: permission must be in module "${module}"`);
  return {
    ...d,
    module,
    risk: d.risk ?? (d.kind === 'read' ? 'low' : d.kind === 'write' ? 'medium' : 'high'),
    idempotent: d.idempotent ?? d.kind !== 'read',
    agentCallable: d.agentCallable ?? d.kind === 'read',
  };
}

/** Wire shape of `POST /api/v1/call/:id` responses when approval is needed (202). */
export const ApprovalRequiredBody = z.object({
  code: z.literal('APPROVAL_REQUIRED'),
  approvalId: z.uuid(),
  policy: z.string(),
  reason: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type ApprovalRequiredBody = z.infer<typeof ApprovalRequiredBody>;

/** Catalog entry as listed to a principal (schemas rendered as JSON Schema for agents/MCP). */
export const CatalogEntry = z.object({
  id: z.string(),
  module: z.string(),
  title: z.string(),
  description: z.string(),
  kind: CapabilityKind,
  risk: RiskClass,
  agentCallable: z.boolean(),
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;

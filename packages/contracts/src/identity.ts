import { z } from 'zod';

export const Uuid = z.uuid();
export const IsoDateTime = z.iso.datetime({ offset: true });
/** Decimal amounts cross every boundary as strings (ADR-0010). */
export const DecimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'decimal string');

export const WORKSPACE_ROLES = ['owner', 'admin', 'manager', 'member', 'viewer', 'auditor'] as const;
export const WorkspaceRole = z.enum(WORKSPACE_ROLES);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

export const WorkspaceKind = z.enum(['standard', 'sample']);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;

/** Autonomy levels (Protocol 06 §129, REQ-AIS-001). */
export const AutonomyLevel = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;
export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  0: 'Advise only',
  1: 'Prepare actions',
  2: 'Execute low-risk actions',
  3: 'Execute within policy',
  4: 'High autonomy with hard limits',
};

export const Environment = z.enum(['development', 'test', 'staging', 'production']);
export type Environment = z.infer<typeof Environment>;

/** Who is calling. Resolved on the trusted side only — never taken from client input (Protocol 05 §44). */
export const Principal = z.object({
  kind: z.enum(['user', 'agent', 'system']),
  id: Uuid,
  tenantId: Uuid,
  /** Workspaces the principal may touch in this call, with the role held in each. */
  workspaces: z.array(z.object({ id: Uuid, role: WorkspaceRole, kind: WorkspaceKind })),
  /** Explicit extra grants (custom roles, agent profile grants). */
  grants: z.array(z.string()).default([]),
  /** For agents: the delegating user and the run. Effective permissions = grants ∩ delegator. */
  delegatedBy: Uuid.optional(),
  runId: Uuid.optional(),
  autonomy: AutonomyLevel.optional(),
  displayName: z.string().optional(),
});
export type Principal = z.infer<typeof Principal>;

export const PERMISSION_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*:[a-z][a-z0-9_]*$/;
export const Permission = z.string().regex(PERMISSION_RE, 'module:resource:action');
export type Permission = string;

/** Build `module:resource:action` permission ids from a compact spec. */
export function permissionCatalog<const M extends string, const S extends Record<string, readonly string[]>>(
  module: M,
  spec: S,
): string[] {
  return Object.entries(spec).flatMap(([res, actions]) => actions.map((a) => `${module}:${res}:${a}`));
}

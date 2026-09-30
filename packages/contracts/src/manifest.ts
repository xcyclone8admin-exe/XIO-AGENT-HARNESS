import { z } from 'zod';
import { PERMISSION_RE, WorkspaceRole } from './identity';

export const PILLARS = [
  'COMMAND',
  'BRAIN',
  'SWARM',
  'FORGE',
  'FLOW',
  'CONNECT',
  'DATA',
  'GROWTH',
  'STUDIO',
  'INTEL',
  'MONEY',
  'PLATFORM',
] as const;
export const Pillar = z.enum(PILLARS);
export type Pillar = z.infer<typeof Pillar>;

export const PILLAR_LABELS: Record<Pillar, string> = {
  COMMAND: 'Command',
  BRAIN: 'Brain',
  SWARM: 'Swarm',
  FORGE: 'Forge',
  FLOW: 'Flow',
  CONNECT: 'Connect',
  DATA: 'Data',
  GROWTH: 'Growth',
  STUDIO: 'Studio',
  INTEL: 'Intel',
  MONEY: 'Money',
  PLATFORM: 'Settings',
};

const NavPath = z
  .string()
  .regex(/^([a-z0-9-]+(\/[a-z0-9-]+)*)?$/, 'lowercase path segments, "" for module root');

export const NavEntry = z.object({
  path: NavPath,
  title: z.string().min(1),
  /** Extra words the command palette matches on. */
  keywords: z.array(z.string()).default([]),
  permission: z.string().regex(PERMISSION_RE).optional(),
  /** Hidden from the sidebar but routable (e.g. detail views). */
  hidden: z.boolean().default(false),
});
export type NavEntry = z.infer<typeof NavEntry>;

export const PaletteCommand = z.object({
  id: z.string(),
  title: z.string(),
  keywords: z.array(z.string()).default([]),
  /** Either navigate somewhere or invoke a capability (with a UI confirmation for non-read kinds). */
  navigate: z.string().optional(),
  capability: z.string().optional(),
  permission: z.string().regex(PERMISSION_RE).optional(),
});
export type PaletteCommand = z.infer<typeof PaletteCommand>;

export const WidgetDecl = z.object({
  id: z.string(),
  title: z.string(),
  size: z.enum(['s', 'm', 'l', 'xl']).default('m'),
  permission: z.string().regex(PERMISSION_RE).optional(),
});
export type WidgetDecl = z.infer<typeof WidgetDecl>;

export const DataClassification = z.enum([
  'public',
  'internal',
  'confidential',
  'confidential-financial',
  'personal',
  'secret-reference',
]);

/** Immutable baseline plus actor stamps the Worker sets itself; never device-writable. */
export const SERVER_STAMPED_FIELDS: readonly string[] = [
  'id',
  'tenant_id',
  'workspace_id',
  'created_by',
  'created_at',
];

/** The sync Worker rejects writes to server-authority and guarded fields (ADR-0003 A1). */
export const TableDecl = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    class: z.enum(['lww', 'append', 'local']),
    authority: z.enum(['server', 'synced', 'append', 'local']),
    mergeGroups: z.array(z.array(z.string().min(1)).min(2)).default([]),
    children: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
    guardedColumns: z.array(z.string().min(1)).default([]),
    /**
     * Device-writable fields for `synced`/`append` tables. Absent means the Worker
     * rejects every field change (fail closed). Never lists server-stamped fields.
     */
    allowedFields: z.array(z.string().min(1)).optional(),
    /** Column the Worker stamps with the verified principal on insert (e.g. `created_by`, `actor_id`). */
    actorField: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
    /** Permission a device change needs; absent on writable tables means any non-read-only role. */
    writePermission: z.string().min(1).optional(),
  })
  .superRefine((table, ctx) => {
    const writable = table.authority === 'synced' || table.authority === 'append';
    if (!writable && (table.allowedFields || table.actorField || table.writePermission)) {
      ctx.addIssue({
        code: 'custom',
        path: ['authority'],
        message: 'allowedFields/actorField/writePermission apply only to synced or append tables',
      });
    }
    for (const field of table.allowedFields ?? []) {
      if (SERVER_STAMPED_FIELDS.includes(field) || field === table.actorField) {
        ctx.addIssue({
          code: 'custom',
          path: ['allowedFields'],
          message: `${field} is server-stamped and cannot be device-writable`,
        });
      }
      if (table.guardedColumns.includes(field)) {
        ctx.addIssue({
          code: 'custom',
          path: ['allowedFields'],
          message: `${field} is guarded and only writable through a capability`,
        });
      }
    }
  });
export type TableDecl = z.infer<typeof TableDecl>;

export const ModuleManifest = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  pillar: Pillar,
  title: z.string(),
  description: z.string(),
  /** lucide icon name (kebab-case). */
  icon: z.string(),
  /** Sidebar order within the pillar group (lower first). */
  order: z.number().int().default(100),
  requirements: z.array(z.string()).default([]),
  permissions: z.array(z.string().regex(PERMISSION_RE)).default([]),
  nav: z.array(NavEntry).default([]),
  commands: z.array(PaletteCommand).default([]),
  widgets: z.array(WidgetDecl).default([]),
  events: z
    .object({ emits: z.array(z.string()).default([]), consumes: z.array(z.string()).default([]) })
    .default({ emits: [], consumes: [] }),
  dependsOn: z.array(z.string()).default([]),
  roleGrants: z.partialRecord(WorkspaceRole, z.array(z.string().regex(PERMISSION_RE))).default({}),
  tables: z.array(TableDecl).default([]),
  dataClassification: DataClassification.default('internal'),
  /** Source provenance for ported code (THIRD_PARTY_NOTICES). */
  portedFrom: z.array(z.string()).default([]),
});
export type ModuleManifest = z.infer<typeof ModuleManifest>;
export type ModuleManifestInput = z.input<typeof ModuleManifest>;

export function defineModule(m: ModuleManifestInput): ModuleManifest {
  const parsed = ModuleManifest.parse(m);
  for (const p of parsed.permissions) {
    if (!p.startsWith(parsed.id + ':'))
      throw new Error(`Module ${parsed.id}: permission "${p}" must be prefixed "${parsed.id}:"`);
  }
  for (const [role, permissions] of Object.entries(parsed.roleGrants)) {
    for (const permission of permissions) {
      if (!parsed.permissions.includes(permission))
        throw new Error(`Module ${parsed.id}: ${role} grant "${permission}" is undeclared`);
    }
  }
  for (const table of parsed.tables) {
    if (table.authority === 'append' && table.class !== 'append')
      throw new Error(`Module ${parsed.id}: append authority requires append class`);
    if (table.authority === 'local' && table.class !== 'local')
      throw new Error(`Module ${parsed.id}: local authority requires local class`);
  }
  const paths = new Set<string>();
  for (const n of parsed.nav) {
    if (paths.has(n.path)) throw new Error(`Module ${parsed.id}: duplicate nav path "${n.path}"`);
    paths.add(n.path);
  }
  return parsed;
}

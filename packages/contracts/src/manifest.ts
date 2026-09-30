import { z } from 'zod';
import { PERMISSION_RE } from './identity';

export const PILLARS = ['COMMAND', 'BRAIN', 'SWARM', 'FORGE', 'FLOW', 'CONNECT', 'DATA', 'GROWTH', 'STUDIO', 'INTEL', 'MONEY', 'PLATFORM'] as const;
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

const NavPath = z.string().regex(/^([a-z0-9-]+(\/[a-z0-9-]+)*)?$/, 'lowercase path segments, "" for module root');

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

export const DataClassification = z.enum(['public', 'internal', 'confidential', 'confidential-financial', 'personal', 'secret-reference']);

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
  events: z.object({ emits: z.array(z.string()).default([]), consumes: z.array(z.string()).default([]) }).default({ emits: [], consumes: [] }),
  dependsOn: z.array(z.string()).default([]),
  dataClassification: DataClassification.default('internal'),
  /** Source provenance for ported code (THIRD_PARTY_NOTICES). */
  portedFrom: z.array(z.string()).default([]),
});
export type ModuleManifest = z.infer<typeof ModuleManifest>;
export type ModuleManifestInput = z.input<typeof ModuleManifest>;

export function defineModule(m: ModuleManifestInput): ModuleManifest {
  const parsed = ModuleManifest.parse(m);
  for (const p of parsed.permissions) {
    if (!p.startsWith(parsed.id + ':')) throw new Error(`Module ${parsed.id}: permission "${p}" must be prefixed "${parsed.id}:"`);
  }
  const paths = new Set<string>();
  for (const n of parsed.nav) {
    if (paths.has(n.path)) throw new Error(`Module ${parsed.id}: duplicate nav path "${n.path}"`);
    paths.add(n.path);
  }
  return parsed;
}

import { createHash } from 'node:crypto';
import { SPEC_TEMPLATES, type SpecTemplate } from '../contracts';

export interface GoldenSpecBrief { readonly title: string; readonly requirementIds: readonly string[]; readonly objective: string }

/** Golden template rendering for deterministic preview; content must be authored/approved, never treated as final spec. */
export function renderGoldenBrief(template: SpecTemplate, brief: GoldenSpecBrief) {
  if (!SPEC_TEMPLATES.includes(template)) throw new Error(`UNKNOWN_SPEC_TEMPLATE:${template}`);
  const slug = brief.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'untitled';
  const id = `spec_${template}-${slug}`;
  const requirementIds = [...new Set(brief.requirementIds)].sort();
  const frontmatter = [
    '---', `id: ${id}`, `template: ${template}`, 'version: 1', `title: ${JSON.stringify(brief.title)}`,
    'status: draft', 'authority: user', `requirementIds: [${requirementIds.map((id) => JSON.stringify(id)).join(', ')}]`, 'dependencies: []', 'supersedes: []', '---',
  ].join('\n');
  const body = `# ${brief.title}\n\n## Objective\n${brief.objective}\n\n## Requirements\n${requirementIds.map((item) => `- ${item}`).join('\n') || '- No requirement IDs provided'}\n\n## Review state\nDraft template output; owner review required.\n`;
  return { id, template, frontmatter, body, sha256: createHash('sha256').update(`${frontmatter}\n${body}`).digest('hex') };
}

export function renderAllGoldenBriefs(brief: GoldenSpecBrief) {
  return Object.fromEntries(SPEC_TEMPLATES.map((template) => [template, renderGoldenBrief(template, brief)])) as Record<SpecTemplate, ReturnType<typeof renderGoldenBrief>>;
}

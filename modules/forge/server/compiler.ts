import { createHash } from 'node:crypto';
import { ContextCandidate, ContextManifest, SpecDocument, SPEC_TEMPLATES, type SpecTemplate } from '../contracts';

export interface SpecInput {
  readonly title: string;
  readonly requirements: readonly { readonly id: string; readonly statement: string }[];
  readonly dependencies?: readonly string[];
  readonly supersedes?: readonly string[];
  readonly createdAt?: string;
}

function stableId(template: SpecTemplate, title: string): string {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'untitled';
  return `spec_${template}-${slug}`;
}

export function compileSpecCorpus(input: SpecInput) {
  const requirements = [...input.requirements].sort((a, b) => a.id.localeCompare(b.id));
  const documents = SPEC_TEMPLATES.map((template) => {
    const id = stableId(template, input.title);
    const dependencies = [...new Set(input.dependencies ?? [])].sort();
    const supersedes = [...new Set(input.supersedes ?? [])].sort();
    const body = `# ${input.title}\n\nTemplate: ${template}\n\n## Requirements\n${requirements.map((r) => `- ${r.id}: ${r.statement}`).join('\n') || '- No requirements supplied'}\n\n## Dependencies\n${dependencies.map((d) => `- ${d}`).join('\n') || '- None declared'}\n\n## Supersedes\n${supersedes.map((d) => `- ${d}`).join('\n') || '- Nothing superseded'}\n\n## Content\nDraft required details for this ${template.replaceAll('-', ' ')} document.\n`;
    const metadata = { id, template, version: 1, title: input.title, status: 'draft', authority: 'user', dependencies, supersedes, requirementIds: requirements.map((r) => r.id) };
    const contentHash = createHash('sha256').update(JSON.stringify({ metadata, body }) ?? 'null').digest('hex');
    return SpecDocument.parse({ ...metadata, body, contentHash });
  }).sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(documents.map((doc) => [doc.id, doc]));
  for (const doc of documents) for (const dependency of doc.dependencies) {
    if (!index.has(dependency) && !input.dependencies?.includes(dependency)) throw new Error(`UNKNOWN_SPEC_DEPENDENCY:${doc.id}:${dependency}`);
  }
  return { documents, byId: index, compiledAt: input.createdAt ?? new Date().toISOString() };
}

export function compileContext(ticketId: string, candidates: readonly (typeof ContextCandidate)['_output'][], budgetTokens: number) {
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 9) throw new Error('INVALID_CONTEXT_BUDGET');
  const parsed = candidates.map((candidate) => ContextCandidate.parse(candidate));
  const requiredTypes = ['objective', 'requirement', 'architecture', 'decision', 'dependency', 'source', 'constraint', 'acceptance', 'prior-evidence'] as const;
  for (const type of requiredTypes) if (!parsed.some((item) => item.type === type)) throw new Error(`MISSING_CONTEXT_ELEMENT:${type}`);
  const authorityRank = { user: 5, contract: 4, architecture: 3, system: 2, reference: 1 } as const;
  const ranked = [...parsed].sort((a, b) =>
    Number(b.type === 'requirement') - Number(a.type === 'requirement') || authorityRank[b.authority] - authorityRank[a.authority] || b.relevance - a.relevance || a.id.localeCompare(b.id),
  );
  const mandatory = new Set(ranked.filter((item) => ['objective', 'requirement', 'acceptance'].includes(item.type)).map((item) => item.id));
  const items: typeof ranked = [];
  let usedTokens = 0;
  for (const item of ranked) {
    if (usedTokens + item.estimatedTokens > budgetTokens) {
      if (mandatory.has(item.id)) throw new Error(`MANDATORY_CONTEXT_OVER_BUDGET:${item.id}`);
      continue;
    }
    items.push(item);
    usedTokens += item.estimatedTokens;
  }
  return ContextManifest.parse({ ticketId, budgetTokens, usedTokens, items, omittedIds: ranked.filter((item) => !items.includes(item)).map((item) => item.id), compiledAt: new Date().toISOString() });
}

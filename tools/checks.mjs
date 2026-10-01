#!/usr/bin/env node
// Repository policy checks run by `npm run checks` (part of `npm run verify`).
// 1 boundaries  2 no-demo  3 notices  4 secrets  5 placeholder register  6 brand isolation
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'dist', 'coverage', '.git', 'target', 'generated', '.wrangler', 'playwright-report', 'test-results', 'spikes']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs', '.json', '.md', '.css', '.sql', '.toml', '.jsonc', '.yaml', '.yml', '.rs', '.html']);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name));
    } else if (TEXT_EXT.has(path.extname(e.name))) yield path.join(dir, e.name);
  }
}
const rel = (p) => path.relative(root, p).split(path.sep).join('/');
const files = [...walk(root)].map((p) => ({ p, r: rel(p) }));
const read = (p) => fs.readFileSync(p, 'utf8');
const failures = [];
const fail = (check, msg) => failures.push(`[${check}] ${msg}`);
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const importsOf = (src) => [...src.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3]).filter(Boolean);
const code = files.filter((f) => /\.(ts|tsx|mjs|js)$/.test(f.r));

// 1. Boundaries (ADR-0006): relative imports must not escape a module or package root.
for (const f of code) {
  const m = /^(modules|packages|apps)\/([^/]+)\//.exec(f.r);
  if (!m) continue;
  const unitRoot = path.join(root, m[1], m[2]);
  for (const spec of importsOf(read(f.p))) {
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(f.p), spec);
    if (!target.startsWith(unitRoot + path.sep) && target !== unitRoot) fail('boundaries', `${f.r} imports "${spec}" outside ${m[1]}/${m[2]}`);
  }
}

// 2. No demo data outside sample workspaces (ADR-0011).
for (const f of code) {
  const isSample = /^modules\/[^/]+\/sample\//.test(f.r) || /\.test\.tsx?$/.test(f.r) || f.r.startsWith('apps/sidecar/src/generated/');
  const allowedImporter = f.r.startsWith('modules/core/server/sample') || f.r.startsWith('packages/testing/') || f.r.startsWith('tools/');
  const src = read(f.p);
  for (const spec of importsOf(src)) {
    if ((/\/sample(\/|$)/.test(spec) || /^@xyra\/mod-[^/]+\/sample$/.test(spec)) && !isSample && !allowedImporter)
      fail('no-demo', `${f.r} imports sample data "${spec}"`);
  }
  if (!isSample && !f.r.startsWith('tools/') && /demo-status|fake[-_ ]?connected|simulated[-_ ]success/i.test(src)) fail('no-demo', `${f.r} contains a demo/fake-status marker`);
}

// 3. Notices: ported code must be covered by THIRD_PARTY_NOTICES.md.
const noticesPath = path.join(root, 'THIRD_PARTY_NOTICES.md');
const notices = fs.existsSync(noticesPath) ? read(noticesPath) : '';
if (!notices) fail('notices', 'THIRD_PARTY_NOTICES.md is missing');
for (const [marker, needle] of [['Ported from FounderOS', 'FounderOS'], ['Ported from starnet', 'starnet']]) {
  const users = code.filter((f) => read(f.p).includes(marker));
  if (users.length && !(notices.includes(needle) && notices.includes('MIT License'))) fail('notices', `${users.length} file(s) marked "${marker}" but notices lack ${needle} MIT text`);
}

// 4. Secrets scan (P02 §19). Values only; names of secrets are fine.
const SECRET_PATTERNS = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /postgres(?:ql)?:\/\/[^:\s'"]+:[^@\s'"]{6,}@[^\s'"]+neon\.tech/,
];
for (const f of files) {
  if (f.r.endsWith('.test.ts') && f.r.startsWith('packages/core/')) continue; // redaction fixtures
  const src = read(f.p);
  for (const re of SECRET_PATTERNS) if (re.test(src)) fail('secrets', `${f.r} matches ${re}`);
}

// 5. Placeholder register (P00 §70–71): TODO/FIXME in production code must reference a registered id.
const registerPath = path.join(root, 'docs', 'placeholders.md');
const register = fs.existsSync(registerPath) ? read(registerPath) : '';
for (const f of code) {
  if (/\.test\.tsx?$/.test(f.r) || f.r.startsWith('tools/')) continue;
  read(f.p)
    .split('\n')
    .forEach((line, i) => {
      // `XXX` is also a valid ISO currency code and appears in generated validators;
      // recognize it only when used as a placeholder marker, while TODO/FIXME remain broad.
      if (!/\b(TODO|FIXME)\b|\bXXX(?=\s|:|-|$)/.test(line)) return;
      const id = /PLACEHOLDER\((PH-\d{3})\)/.exec(line)?.[1];
      if (!id || !register.includes(id)) fail('placeholders', `${f.r}:${i + 1} unregistered placeholder`);
    });
}

// 6. Brand isolation (D3): the product name literal lives only in packages/brand.
for (const f of code) {
  if (f.r.startsWith('packages/brand/') || /\.test\.tsx?$/.test(f.r) || f.r.startsWith('tools/')) continue;
  if (/['"`]XYRA Agent OS['"`]/.test(read(f.p))) fail('brand', `${f.r} hard-codes the product name; import PRODUCT_NAME from @xyra/brand`);
  if (/\bstarnet\b/i.test(read(f.p)) && !/Ported from starnet/.test(read(f.p))) fail('brand', `${f.r} mentions starnet outside a port notice`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`checks: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`checks: OK (${files.length} files scanned)`);

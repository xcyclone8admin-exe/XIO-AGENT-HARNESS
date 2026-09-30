#!/usr/bin/env node
// Registered XYRA verification entry point (BUILD_CONTRACT.verification_commands).
// `xyra verify` runs this with cwd = projects/<slug>/repo, which is inside OneDrive. We must never
// install or build there, so this script materializes the exact HEAD commit into a build directory
// outside OneDrive and runs the requested step there. Output always states the commit it ran against.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STEPS = {
  install: null,
  typecheck: ['run', 'typecheck'],
  lint: ['run', 'lint'],
  test: ['run', 'test'],
  checks: ['run', 'checks'],
  'build-web': ['run', 'build:web'],
  'build-sidecar': ['run', 'build:sidecar'],
  e2e: ['run', 'e2e'],
  verify: ['run', 'verify'],
};

const step = process.argv[2];
if (!step || !(step in STEPS)) {
  console.error(`usage: node tools/xyra-verify.mjs <${Object.keys(STEPS).join('|')}>`);
  process.exit(2);
}

const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

const source = process.cwd();
const head = sh('git', ['rev-parse', 'HEAD'], source);
if (head.code !== 0) {
  console.error('not a git repository: ' + source);
  process.exit(2);
}
const sha = head.out.trim();
const dirty = sh('git', ['status', '--porcelain'], source).out.trim().length > 0;

const buildRoot = process.env.XYRA_BUILD_ROOT ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'xyra-build', 'verify');
const repoKey = crypto.createHash('sha256').update(path.resolve(source).toLowerCase()).digest('hex').slice(0, 12);
const dir = path.join(buildRoot, repoKey);
if (/onedrive/i.test(dir)) {
  console.error(`refusing to build inside OneDrive: ${dir}`);
  process.exit(2);
}

console.log(`XYRA-VERIFY step=${step} commit=${sha} source_dirty=${dirty} dir=${dir}`);
if (dirty) console.log('note: uncommitted changes in the source are NOT verified; only the commit above is.');

// Materialize HEAD as a detached worktree (created once, re-pointed each run).
fs.mkdirSync(buildRoot, { recursive: true });
if (!fs.existsSync(path.join(dir, '.git'))) {
  const r = sh('git', ['worktree', 'add', '--detach', '--force', dir, sha], source);
  if (r.code !== 0) {
    console.error(r.out);
    process.exit(1);
  }
} else {
  for (const args of [['checkout', '--detach', '--force', sha], ['clean', '-fdx', '-e', 'node_modules', '-e', '.xyra-lock']]) {
    const r = sh('git', args, dir);
    if (r.code !== 0) {
      console.error(r.out);
      process.exit(1);
    }
  }
}

// Install only when the lockfile changed (keeps each registered step inside the 5-minute cap).
const lock = path.join(dir, 'package-lock.json');
const lockHash = fs.existsSync(lock) ? crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex') : 'none';
const marker = path.join(dir, 'node_modules', '.xyra-lock');
const installed = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === lockHash;
if (step === 'install' || !installed) {
  const r = sh('npm', ['ci', '--no-audit', '--no-fund'], dir);
  process.stdout.write(r.out.split('\n').slice(-15).join('\n') + '\n');
  if (r.code !== 0) process.exit(r.code);
  fs.writeFileSync(marker, lockHash);
  if (step === 'install') {
    console.log(`XYRA-VERIFY RESULT step=install commit=${sha} exit=0`);
    process.exit(0);
  }
}

const r = sh('npm', STEPS[step], dir);
process.stdout.write(r.out);
console.log(`XYRA-VERIFY RESULT step=${step} commit=${sha} exit=${r.code}`);
process.exit(r.code);

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '..', '..');
const tauriRoot = resolve(desktopRoot, 'src-tauri');
const resourcesRoot = resolve(tauriRoot, 'resources');
const sidecarResourceRoot = resolve(resourcesRoot, 'sidecar');
const licensesResourceRoot = resolve(resourcesRoot, 'licenses');
const sidecarBundle = resolve(repositoryRoot, 'apps/sidecar/dist/main.mjs');
const packageNames = ['pglite', 'pglite-pgvector'];

function runNpm(args) {
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const commandArgs =
    process.platform === 'win32' ? ['/d', '/s', '/c', `npm ${args.join(' ')}`] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed with status ${result.status}`);
  }
}

function assertInsideTauri(path) {
  const relativePath = relative(tauriRoot, path);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(tauriRoot, relativePath) !== path
  ) {
    throw new Error('Refusing to stage outside the Tauri app resources');
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Build the current tracked sidecar source before copying any resources. A build error leaves
// Tauri packaging stopped instead of silently reusing stale output.
runNpm(['run', 'build', '-w', '@xyra/sidecar']);
runNpm(['run', 'smoke:bundle', '-w', '@xyra/sidecar']);

const bundle = await readFile(sidecarBundle);
const bundleText = bundle.toString('utf8');
for (const marker of [
  'xyra-native-bootstrap-v1',
  '/internal/native/cloud-sync/push',
  '/internal/native/invest/signals/consume',
  'xyra.invest.envelope.digest.v1',
]) {
  if (!bundleText.includes(marker)) {
    throw new Error(`Built sidecar is missing required integrated feature marker: ${marker}`);
  }
}

assertInsideTauri(sidecarResourceRoot);
assertInsideTauri(licensesResourceRoot);
await rm(sidecarResourceRoot, { recursive: true, force: true });
await rm(licensesResourceRoot, { recursive: true, force: true });
await mkdir(sidecarResourceRoot, { recursive: true });
await mkdir(licensesResourceRoot, { recursive: true });
await cp(sidecarBundle, join(sidecarResourceRoot, 'main.mjs'));

for (const packageName of packageNames) {
  const source = resolve(repositoryRoot, 'node_modules/@electric-sql', packageName);
  const destination = join(sidecarResourceRoot, 'node_modules/@electric-sql', packageName);
  assertInsideTauri(destination);
  await cp(source, destination, { recursive: true, force: true });

  const licenseTarget = resolve(licensesResourceRoot, `electric-sql-${packageName}-LICENSE`);
  assertInsideTauri(licenseTarget);
  await mkdir(dirname(licenseTarget), { recursive: true });
  await cp(resolve(source, 'LICENSE'), licenseTarget);
}

const manifest = {
  protocol: 'xyra-desktop-sidecar-stage-v1',
  sidecarSha256: sha256(bundle),
  stagedPackages: packageNames,
};
await writeFile(
  join(sidecarResourceRoot, 'stage-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);
process.stdout.write(
  `Prepared desktop package resources; sidecar SHA-256 ${manifest.sidecarSha256}\n`,
);

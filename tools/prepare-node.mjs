import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const NODE_VERSION = '24.21.0';
const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;
const NODE_ARCHIVE_SHA256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541';
const NODE_URL = `https://nodejs.org/download/release/v${NODE_VERSION}/${NODE_ARCHIVE}`;
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binaryDir = join(repoRoot, 'apps', 'desktop', 'src-tauri', 'binaries');
const binaryPath = join(binaryDir, `node-${TARGET_TRIPLE}.exe`);

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(`This desktop bundle currently supports Windows x64 only; found ${process.platform}/${process.arch}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'xyra-node-'));
const archivePath = join(scratch, NODE_ARCHIVE);
const extractPath = join(scratch, 'extract');
mkdirSync(extractPath);

try {
  const response = await fetch(NODE_URL, { redirect: 'error' });
  if (!response.ok || !response.body) {
    throw new Error(`Node download failed with HTTP ${response.status}`);
  }

  const digest = createHash('sha256');
  const hashTransform = new Transform({
    transform(chunk, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(response.body, hashTransform, createWriteStream(archivePath, { flags: 'wx' }));
  const actualArchiveSha256 = digest.digest('hex');
  if (actualArchiveSha256 !== NODE_ARCHIVE_SHA256) {
    throw new Error(`Node archive SHA-256 mismatch: expected ${NODE_ARCHIVE_SHA256}, got ${actualArchiveSha256}`);
  }

  const powershell = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:XYRA_NODE_ARCHIVE -DestinationPath $env:XYRA_NODE_EXTRACT -Force",
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, XYRA_NODE_ARCHIVE: archivePath, XYRA_NODE_EXTRACT: extractPath },
    },
  );
  if (powershell.error || powershell.status !== 0) {
    throw new Error(`Node archive extraction failed: ${powershell.error?.message ?? powershell.stderr.trim()}`);
  }

  const stagedNode = join(extractPath, `node-v${NODE_VERSION}-win-x64`, 'node.exe');
  const version = spawnSync(stagedNode, ['--version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0 || version.stdout.trim() !== `v${NODE_VERSION}`) {
    throw new Error(`Pinned Node version check failed: ${version.error?.message ?? version.stdout.trim()}`);
  }

  mkdirSync(binaryDir, { recursive: true });
  const temporaryBinary = `${binaryPath}.tmp-${process.pid}`;
  copyFileSync(stagedNode, temporaryBinary);
  renameSync(temporaryBinary, binaryPath);
  const stagedHash = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
  process.stdout.write(
    `Staged Node ${NODE_VERSION}\nArchive SHA-256: ${actualArchiveSha256}\nBinary: ${binaryPath}\nBinary size: ${statSync(binaryPath).size} bytes\nBinary SHA-256: ${stagedHash}\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

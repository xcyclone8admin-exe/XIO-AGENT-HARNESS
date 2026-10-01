import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));

const token = randomBytes(32).toString('base64url');
const nativeSyncToken = randomBytes(32).toString('base64url');
const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/main.mjs', import.meta.url))], {
  env: {
    ...process.env,
    XYRA_SIDECAR_PORT: String(port),
    XYRA_DATA_DIR: 'memory://',
    XYRA_OS_SUBJECT: 'smoke:local',
    XYRA_DISPLAY_NAME: 'Smoke test',
    XYRA_ALLOWED_ORIGINS: 'http://tauri.localhost',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
child.stdin.end(`${JSON.stringify({
  protocolVersion: 'xyra-native-bootstrap-v1',
  launchToken: token,
  nativeSyncToken,
})}\n`);
let stderr = '';
child.stderr.setEncoding('utf8').on('data', (chunk) => {
  stderr += chunk;
});
let readyTimeout;
const ready = Promise.race([
  new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (chunk.includes('sidecar ready on 127.0.0.1:')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`sidecar exited ${code}: ${stderr}`)));
  }),
  new Promise((_resolve, reject) => {
    readyTimeout = setTimeout(() => reject(new Error('sidecar startup timed out')), 15_000);
  }),
]);

try {
  await ready;
  clearTimeout(readyTimeout);
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/session`, {
    headers: { authorization: `Bearer ${token}`, origin: 'http://tauri.localhost' },
  });
  const body = await response.json();
  if (response.status !== 200 || body.workspaces?.length !== 2)
    throw new Error(`Bundled sidecar session failed: ${response.status}`);
  process.stdout.write('bundled sidecar: OK\n');
} finally {
  clearTimeout(readyTimeout);
  child.kill();
  await once(child, 'exit');
}

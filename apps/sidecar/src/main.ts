import { startLocalSidecar } from './runtime';
import { readNativeBootstrap } from './native-bootstrap';

// Remove legacy token variables before any child/runtime code can observe them.
delete process.env.XYRA_LAUNCH_TOKEN;
delete process.env.XYRA_NATIVE_SYNC_TOKEN;

/** Launched by the native host; authentication tokens arrive over the private stdin bootstrap. */
const port = Number(process.env.XYRA_SIDECAR_PORT);
const dataDir = process.env.XYRA_DATA_DIR;
const osSubject = process.env.XYRA_OS_SUBJECT;
const displayName = process.env.XYRA_DISPLAY_NAME;
const allowedOrigins = process.env.XYRA_ALLOWED_ORIGINS?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !dataDir ||
  !osSubject ||
  !displayName ||
  !allowedOrigins?.length
) {
  throw new Error('Native host must supply port, data dir, identity and allowed origins');
}

// Native sync authority arrives only over the private child-stdin pipe, never the environment.
const nativeBootstrap = process.stdin.isTTY ? undefined : await readNativeBootstrap(process.stdin);

const session = await startLocalSidecar({
  port,
  dataDir,
  osSubject,
  displayName,
  ...(nativeBootstrap
    ? { launchToken: nativeBootstrap.launchToken, nativeSyncToken: nativeBootstrap.nativeSyncToken }
    : {}),
  allowedOrigins,
});
process.stdout.write(`sidecar ready on 127.0.0.1:${session.port}\n`);
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await session.close();
  process.exit(0);
};
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});

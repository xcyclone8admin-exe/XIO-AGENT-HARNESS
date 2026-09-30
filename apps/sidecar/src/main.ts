import { startLocalSidecar } from './runtime';

/** Launched by the native host with an ephemeral token in its private environment. */
const port = Number(process.env.XYRA_SIDECAR_PORT);
const dataDir = process.env.XYRA_DATA_DIR;
const osSubject = process.env.XYRA_OS_SUBJECT;
const displayName = process.env.XYRA_DISPLAY_NAME;
const launchToken = process.env.XYRA_LAUNCH_TOKEN;
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
  !launchToken ||
  !allowedOrigins?.length
) {
  throw new Error('Native host must supply port, data dir, identity, token and allowed origins');
}

const session = await startLocalSidecar({
  port,
  dataDir,
  osSubject,
  displayName,
  launchToken,
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

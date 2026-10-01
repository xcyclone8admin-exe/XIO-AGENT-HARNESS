import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { readNativeBootstrap } from './native-bootstrap';

const TOKEN = Buffer.alloc(32, 7).toString('base64url');
const LAUNCH_TOKEN = Buffer.alloc(32, 8).toString('base64url');
const envelope = (nativeSyncToken = TOKEN) =>
  JSON.stringify({
    protocolVersion: 'xyra-native-bootstrap-v1',
    launchToken: LAUNCH_TOKEN,
    nativeSyncToken,
  });

test('native bootstrap accepts exactly one versioned 256-bit token line', async () => {
  const input = new PassThrough();
  const result = readNativeBootstrap(input);
  input.end(`${envelope()}\n`);
  await expect(result).resolves.toEqual({ launchToken: LAUNCH_TOKEN, nativeSyncToken: TOKEN });
});

test('native bootstrap rejects malformed, short, oversized and trailing input', async () => {
  for (const payload of [
    '{bad json}\n',
    `${envelope('short')}\n`,
    `${JSON.stringify({ ...JSON.parse(envelope()), nativeSyncToken: LAUNCH_TOKEN })}\n`,
    `${envelope()}\nextra`,
    `${'x'.repeat(4097)}\n`,
    `${JSON.stringify({ ...JSON.parse(envelope()), unexpected: true })}\n`,
  ]) {
    const input = new PassThrough();
    const result = readNativeBootstrap(input);
    input.end(payload);
    await expect(result).rejects.toThrow();
  }
  const trailing = new PassThrough();
  const trailingResult = readNativeBootstrap(trailing);
  trailing.write(`${envelope()}\n`);
  trailing.end('late extra data');
  await expect(trailingResult).rejects.toThrow('NATIVE_BOOTSTRAP_EXTRA_DATA');
});

test('empty stdin disables native callbacks for non-native development launches', async () => {
  const input = new PassThrough();
  const result = readNativeBootstrap(input);
  input.end();
  await expect(result).resolves.toBeUndefined();
});

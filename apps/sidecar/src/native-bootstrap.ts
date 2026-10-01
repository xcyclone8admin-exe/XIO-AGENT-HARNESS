import { Buffer } from 'node:buffer';
import type { Readable } from 'node:stream';
import { z } from 'zod';

const NativeBootstrap = z
  .strictObject({
    protocolVersion: z.literal('xyra-native-bootstrap-v1'),
    launchToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    nativeSyncToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .superRefine((value, context) => {
    for (const token of [value.launchToken, value.nativeSyncToken]) {
      const decoded = Buffer.from(token, 'base64url');
      if (decoded.byteLength !== 32 || decoded.toString('base64url') !== token) {
        context.addIssue({ code: 'custom', message: 'Bootstrap tokens must encode 256 bits' });
        break;
      }
    }
    if (value.launchToken === value.nativeSyncToken) {
      context.addIssue({ code: 'custom', message: 'Bootstrap tokens must be distinct' });
    }
  });

const MAX_BOOTSTRAP_LINE_BYTES = 4096;

/**
 * Reads the one native-only bootstrap envelope from child stdin. Empty EOF (or a TTY at the
 * caller) means an ordinary development launch with the native callback disabled.
 */
export async function readNativeBootstrap(
  input: Readable,
): Promise<{ launchToken: string; nativeSyncToken: string } | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > MAX_BOOTSTRAP_LINE_BYTES) throw new Error('NATIVE_BOOTSTRAP_TOO_LARGE');
    chunks.push(bytes);
  }
  if (total === 0) return undefined;
  const joined = Buffer.concat(chunks, total);
  const newline = joined.indexOf(0x0a);
  if (newline < 0) throw new Error('NATIVE_BOOTSTRAP_NEWLINE_REQUIRED');
  if (newline !== joined.byteLength - 1) throw new Error('NATIVE_BOOTSTRAP_EXTRA_DATA');
  const text = joined.subarray(0, newline).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('NATIVE_BOOTSTRAP_INVALID_JSON');
  }
  const result = NativeBootstrap.safeParse(parsed);
  if (!result.success) throw new Error('NATIVE_BOOTSTRAP_INVALID');
  return { launchToken: result.data.launchToken, nativeSyncToken: result.data.nativeSyncToken };
}

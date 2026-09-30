/**
 * UUIDv7 (RFC 9562): 48-bit unix ms timestamp + random. Generated client-side so ids are stable
 * across devices for sync (Protocol 05 §306) and sort by creation time. Works in Node, browsers and Workers.
 */
const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export type RandomSource = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
const defaultRandom: RandomSource = (b) => globalThis.crypto.getRandomValues(b);

let lastMs = -1;
let seq = 0;

export function uuidv7(nowMs: number = Date.now(), random: RandomSource = defaultRandom): string {
  const b = random(new Uint8Array(16));
  // Monotonic within a millisecond: a 12-bit counter in rand_a keeps ordering for bursts.
  if (nowMs <= lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) lastMs += 1;
    nowMs = lastMs;
  } else {
    lastMs = nowMs;
    seq = ((b[6] ?? 0) << 4) & 0x7ff;
  }
  const ms = BigInt(nowMs);
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = 0x70 | ((seq >> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  let s = '';
  for (let i = 0; i < 16; i++) {
    s += HEX[b[i] ?? 0];
    if (i === 3 || i === 5 || i === 7 || i === 9) s += '-';
  }
  return s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Milliseconds encoded in a UUIDv7. */
export function uuidv7Time(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

/**
 * Hybrid Logical Clock (ADR-0003). Encoded as `<ms:13 digits>-<counter:4 hex>-<node>` so plain string
 * comparison equals causal-then-node ordering. Used to stamp every field write for field-level LWW sync.
 */
export interface HlcParts {
  readonly ms: number;
  readonly counter: number;
  readonly node: string;
}

const MAX_COUNTER = 0xffff;
/** Reject remote clocks further ahead than this (clock-skew guard). */
export const MAX_DRIFT_MS = 5 * 60_000;

export function encodeHlc(p: HlcParts): string {
  if (!/^[a-z0-9]{1,32}$/.test(p.node)) throw new Error('HLC node id must be 1-32 chars [a-z0-9]');
  return `${String(p.ms).padStart(13, '0')}-${p.counter.toString(16).padStart(4, '0')}-${p.node}`;
}

export function decodeHlc(s: string): HlcParts {
  const m = /^(\d{13})-([0-9a-f]{4})-([a-z0-9]{1,32})$/.exec(s);
  if (!m) throw new Error(`Invalid HLC: ${s}`);
  return { ms: Number(m[1]), counter: parseInt(m[2] ?? '0', 16), node: m[3] ?? '' };
}

export const compareHlc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const maxHlc = (a: string | null | undefined, b: string | null | undefined): string | null =>
  a == null ? (b ?? null) : b == null ? a : a >= b ? a : b;

export class HybridClock {
  private ms = 0;
  private counter = 0;

  constructor(
    readonly node: string,
    private readonly wallClock: () => number = Date.now,
  ) {
    encodeHlc({ ms: 0, counter: 0, node }); // validates node id
  }

  /** Stamp a local event. */
  now(): string {
    const wall = this.wallClock();
    if (wall > this.ms) {
      this.ms = wall;
      this.counter = 0;
    } else {
      this.bump();
    }
    return encodeHlc({ ms: this.ms, counter: this.counter, node: this.node });
  }

  /** Merge a remote timestamp (on receive) so later local stamps sort after it. */
  receive(remote: string): string {
    const r = decodeHlc(remote);
    const wall = this.wallClock();
    if (r.ms > wall + MAX_DRIFT_MS) throw new Error('Remote HLC exceeds allowed clock drift');
    const nextMs = Math.max(wall, this.ms, r.ms);
    if (nextMs === this.ms && nextMs === r.ms) this.counter = Math.max(this.counter, r.counter);
    else if (nextMs === r.ms) this.counter = r.counter;
    else if (nextMs !== this.ms) this.counter = -1;
    this.ms = nextMs;
    this.bump();
    return encodeHlc({ ms: this.ms, counter: this.counter, node: this.node });
  }

  private bump(): void {
    if (this.counter >= MAX_COUNTER) {
      this.ms += 1;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
  }
}

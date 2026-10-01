import type { ConflictRecord, PushResponse, RowChange, SequencedChange } from '@xyra/contracts';

export type FieldWrite = RowChange['fields'][string];

export interface StoredRow {
  readonly fields: Record<string, FieldWrite>;
  readonly deletedHlc?: string;
}

export interface IdempotencyEntry {
  readonly hash: string;
  readonly response: PushResponse;
  readonly atMs: number;
}

export interface StoredConflict {
  readonly id: number;
  readonly record: ConflictRecord;
}

/** Bounded, filtered page request: rows, serialized bytes and rows examined are all capped. */
export interface PageRequest {
  readonly after: bigint;
  readonly maxRows: number;
  readonly maxBytes: number;
  readonly maxScan: number;
  readonly readable: (table: string) => boolean;
}

export interface Page<T> {
  readonly items: T[];
  /** Highest position examined (delivered or skipped as unreadable); the safe resume point. */
  readonly lastExamined: bigint;
  /** True when nothing beyond lastExamined existed at read time. */
  readonly exhausted: boolean;
}

export const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

/** Local and Neon stores may complete synchronously or asynchronously behind the same engine. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Storage port for the pure sync engine. The Worker supplies a transaction-scoped Neon adapter;
 * local engine tests use the in-memory implementation. Both compact the log the same way.
 */
export interface SyncStorePort {
  getRow(key: string): MaybePromise<StoredRow | undefined>;
  putRow(key: string, row: StoredRow): MaybePromise<void>;
  serverSeq(): MaybePromise<bigint>;
  /**
   * Appends to the ordered log and returns the new server sequence. Superseded field writes are
   * removed from earlier entries (and emptied entries dropped): replaying the compacted log from any
   * cursor still converges to the same rows, so compaction never invalidates a cursor.
   */
  appendLog(change: RowChange): MaybePromise<bigint>;
  readLogPage(request: PageRequest): MaybePromise<Page<SequencedChange>>;
  getIdempotency(key: string): MaybePromise<IdempotencyEntry | undefined>;
  putIdempotency(key: string, entry: IdempotencyEntry): MaybePromise<void>;
  pruneIdempotency(beforeMs: number): MaybePromise<void>;
  addConflict(record: ConflictRecord): MaybePromise<void>;
  readConflictPage(request: PageRequest): MaybePromise<Page<StoredConflict>>;
  /** Parent keys a live child row references; replaced wholesale on every child write. */
  setRefs(childKey: string, parentKeys: readonly string[]): MaybePromise<void>;
  hasLiveChildren(parentKey: string): MaybePromise<boolean>;
}

const rowKey = (change: RowChange): string => `${change.table}:${change.id}`;
const TOMBSTONE = '\u0000delete';

/** Field → seq of the latest log entry carrying it, per row; drives supersession compaction. */
function superseded(
  latest: Map<string, Map<string, bigint>>,
  change: RowChange,
  seq: bigint,
): { readonly strip: Map<bigint, string[]>; readonly drop: Set<bigint> } {
  const strip = new Map<bigint, string[]>();
  const drop = new Set<bigint>();
  if (change.op === 'append') return { strip, drop };
  const key = rowKey(change);
  const fields = latest.get(key) ?? new Map<string, bigint>();
  if (change.op === 'delete') {
    for (const old of fields.values()) drop.add(old);
    latest.set(key, new Map([[TOMBSTONE, seq]]));
    return { strip, drop };
  }
  for (const field of Object.keys(change.fields)) {
    const old = fields.get(field);
    if (old !== undefined) strip.set(old, [...(strip.get(old) ?? []), field]);
    fields.set(field, seq);
  }
  latest.set(key, fields);
  return { strip, drop };
}

export class MemorySyncStore implements SyncStorePort {
  private seq = 0n;
  private conflictId = 0;
  private readonly rows = new Map<string, StoredRow>();
  private readonly log = new Map<bigint, RowChange>();
  private readonly latest = new Map<string, Map<string, bigint>>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly conflicts: StoredConflict[] = [];
  private readonly refs = new Map<string, readonly string[]>();

  getRow(key: string): StoredRow | undefined {
    return this.rows.get(key);
  }
  putRow(key: string, row: StoredRow): void {
    this.rows.set(key, structuredClone(row));
  }
  serverSeq(): bigint {
    return this.seq;
  }
  appendLog(change: RowChange): bigint {
    this.seq += 1n;
    const { strip, drop } = superseded(this.latest, change, this.seq);
    for (const old of drop) this.log.delete(old);
    for (const [old, fields] of strip) {
      const entry = this.log.get(old);
      if (!entry) continue;
      const kept = Object.fromEntries(
        Object.entries(entry.fields).filter(([field]) => !fields.includes(field)),
      );
      if (Object.keys(kept).length === 0) this.log.delete(old);
      else this.log.set(old, { ...entry, fields: kept });
    }
    this.log.set(this.seq, structuredClone(change));
    return this.seq;
  }
  readLogPage(request: PageRequest): Page<SequencedChange> {
    const ordered = [...this.log.entries()]
      .filter(([seq]) => seq > request.after)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return page(
      ordered.map(([seq, change]) => ({
        position: seq,
        table: change.table,
        item: { seq: seq.toString(10), change },
      })),
      request,
    );
  }
  getIdempotency(key: string): IdempotencyEntry | undefined {
    return this.idempotency.get(key);
  }
  putIdempotency(key: string, entry: IdempotencyEntry): void {
    this.idempotency.set(key, structuredClone(entry));
  }
  pruneIdempotency(beforeMs: number): void {
    for (const [key, entry] of this.idempotency) if (entry.atMs < beforeMs) this.idempotency.delete(key);
  }
  addConflict(record: ConflictRecord): void {
    this.conflictId += 1;
    this.conflicts.push({ id: this.conflictId, record: structuredClone(record) });
  }
  readConflictPage(request: PageRequest): Page<StoredConflict> {
    return page(
      this.conflicts
        .filter((entry) => BigInt(entry.id) > request.after)
        .map((entry) => ({ position: BigInt(entry.id), table: entry.record.table, item: entry })),
      request,
    );
  }
  setRefs(childKey: string, parentKeys: readonly string[]): void {
    if (parentKeys.length === 0) this.refs.delete(childKey);
    else this.refs.set(childKey, [...parentKeys]);
  }
  hasLiveChildren(parentKey: string): boolean {
    for (const parents of this.refs.values()) if (parents.includes(parentKey)) return true;
    return false;
  }

  /** Test helper. */
  snapshot(): {
    rows: Record<string, StoredRow>;
    log: SequencedChange[];
    conflicts: ConflictRecord[];
    seq: string;
    idempotencyCount: number;
  } {
    return {
      rows: Object.fromEntries(this.rows),
      log: [...this.log.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([seq, change]) => ({ seq: seq.toString(10), change: structuredClone(change) })),
      conflicts: this.conflicts.map((entry) => entry.record),
      seq: this.seq.toString(10),
      idempotencyCount: this.idempotency.size,
    };
  }
}

/** Shared page builder for already-ordered candidates (memory store and tests). */
function page<T>(
  candidates: readonly { readonly position: bigint; readonly table: string; readonly item: T }[],
  request: PageRequest,
): Page<T> {
  const items: T[] = [];
  let bytes = 0;
  let lastExamined = request.after;
  let scanned = 0;
  for (const candidate of candidates) {
    if (items.length >= request.maxRows || scanned >= request.maxScan)
      return { items, lastExamined, exhausted: false };
    scanned += 1;
    if (request.readable(candidate.table)) {
      const size = byteLength(JSON.stringify(candidate.item)) + 128;
      // Always deliver at least one item so a single large entry can never stall a cursor.
      if (items.length > 0 && bytes + size > request.maxBytes)
        return { items, lastExamined, exhausted: false };
      bytes += size;
      items.push(candidate.item);
    }
    lastExamined = candidate.position;
  }
  return { items, lastExamined, exhausted: true };
}

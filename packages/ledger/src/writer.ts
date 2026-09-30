import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  Account,
  Asset,
  Balance,
  BalanceQuery,
  Book,
  CreateAccountInput,
  CreateBookInput,
  MinorUnits,
  PostResult,
  PostTransactionInput,
  ReverseTransactionInput,
} from './contracts';
import type { LedgerEnvironment, LedgerScope } from './contracts';
import { toUnits } from './units';

export type LedgerStoreErrorCode =
  | 'UNBALANCED'
  | 'TOO_FEW_ENTRIES'
  | 'ENVIRONMENT_MISMATCH'
  | 'CROSS_ENVIRONMENT'
  | 'CROSS_BOOK'
  | 'LIVE_TRADING_DISABLED'
  | 'UNKNOWN_ASSET'
  | 'SCALE_CONFLICT'
  | 'ALREADY_REVERSED'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT';

export class LedgerStoreError extends Error {
  constructor(
    readonly code: LedgerStoreErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'LedgerStoreError';
  }
}

interface TxContext {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

interface AccountRow {
  id: string;
  book_id: string;
  environment: LedgerEnvironment;
  code: string;
  name: string;
  type: Account['type'];
  created_at: string | Date;
}

interface BookRow {
  id: string;
  name: string;
  environment: LedgerEnvironment;
  base_asset: string;
  owner_module: Book['ownerModule'];
  purpose: Book['purpose'];
  subject_id: string | null;
  created_at: string | Date;
}

function pgMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * PGlite ledger write/read primitive. Posting, entries and the SQL balance projection share one
 * scoped transaction. Higher-level aggregation/reconciliation and capability wiring build on this.
 */
export class PGliteLedgerWriter {
  constructor(private readonly db: PGlite) {}

  private async inScope<T>(scope: LedgerScope, work: (tx: TxContext) => Promise<T>): Promise<T> {
    if (!/^[0-9a-f-]{36}$/i.test(scope.tenantId) || !/^[0-9a-f-]{36}$/i.test(scope.workspaceId)) {
      throw new LedgerStoreError('NOT_FOUND', 'Invalid ledger scope');
    }
    if (scope.hlc !== undefined && !/^\d{13}-[0-9a-f]{4}-[a-z0-9]{1,32}$/.test(scope.hlc)) {
      throw new LedgerStoreError('NOT_FOUND', 'Invalid workspace HLC');
    }
    try {
      return await this.db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE xyra_app');
        await tx.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        await tx.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await tx.query("SELECT set_config('app.hlc', $1, true)", [scope.hlc ?? '']);
        return work(tx);
      });
    } catch (error) {
      const message = pgMessage(error);
      if (/LIVE_TRADING_DISABLED/.test(message)) throw new LedgerStoreError('LIVE_TRADING_DISABLED');
      if (/UNBALANCED/.test(message)) throw new LedgerStoreError('UNBALANCED');
      if (/TOO_FEW_ENTRIES/.test(message)) throw new LedgerStoreError('TOO_FEW_ENTRIES');
      if (/CROSS_ENVIRONMENT/.test(message)) throw new LedgerStoreError('CROSS_ENVIRONMENT');
      if (/ledger_transactions_tenant_id_workspace_id_reverses_id_key|duplicate key/.test(message)) {
        if (/reverses_id/.test(message)) throw new LedgerStoreError('ALREADY_REVERSED');
        throw new LedgerStoreError('IDEMPOTENCY_CONFLICT');
      }
      throw error;
    }
  }

  async ensureAssets(scope: LedgerScope, actorId: string, assets: readonly Asset[]): Promise<void> {
    await this.inScope(scope, async (tx) => {
      for (const input of assets) {
        const asset = Asset.parse(input);
        const existing = await tx.query<{ scale: number; kind: string; name: string }>(
          `SELECT scale, kind, name FROM ledger_assets WHERE tenant_id=$1 AND workspace_id=$2 AND code=$3`,
          [scope.tenantId, scope.workspaceId, asset.code],
        );
        if (existing.rows[0]) {
          const row = existing.rows[0];
          if (row.scale !== asset.scale) throw new LedgerStoreError('SCALE_CONFLICT');
          if (row.kind !== asset.kind || row.name !== asset.name)
            throw new LedgerStoreError('SCALE_CONFLICT', 'Registered asset metadata is immutable');
          continue;
        }
        await tx.query(
          `INSERT INTO ledger_assets(id,tenant_id,workspace_id,code,scale,kind,name,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            scope.tenantId,
            scope.workspaceId,
            asset.code,
            asset.scale,
            asset.kind,
            asset.name,
            actorId,
          ],
        );
      }
    });
  }

  async assets(scope: LedgerScope): Promise<Asset[]> {
    return this.inScope(scope, async (tx) => {
      const { rows } = await tx.query<Asset & Record<string, unknown>>(
        `SELECT code,scale,kind,name FROM ledger_assets WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY code`,
        [scope.tenantId, scope.workspaceId],
      );
      return rows.map((row) => Asset.parse(row));
    });
  }

  async createBook(scope: LedgerScope, actorId: string, value: CreateBookInput): Promise<Book> {
    const input = CreateBookInput.parse(value);
    return this.inScope(scope, async (tx) => {
      const asset = await tx.query(
        'SELECT 1 FROM ledger_assets WHERE tenant_id=$1 AND workspace_id=$2 AND code=$3',
        [scope.tenantId, scope.workspaceId, input.baseAsset],
      );
      if (!asset.rows.length) throw new LedgerStoreError('UNKNOWN_ASSET');
      const id = input.id ?? randomUUID();
      const { rows } = await tx.query<BookRow & Record<string, unknown>>(
        `INSERT INTO ledger_books(id,tenant_id,workspace_id,name,environment,base_asset,owner_module,purpose,subject_id,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id,name,environment,base_asset,owner_module,purpose,subject_id,created_at`,
        [
          id,
          scope.tenantId,
          scope.workspaceId,
          input.name,
          input.environment,
          input.baseAsset,
          input.ownerModule,
          input.purpose,
          input.subjectId,
          actorId,
        ],
      );
      return Book.parse(this.bookOut(rows[0]));
    });
  }

  async books(
    scope: LedgerScope,
    filter: { environment?: Book['environment']; ownerModule?: Book['ownerModule'] } = {},
  ): Promise<Book[]> {
    return this.inScope(scope, async (tx) => {
      const { rows } = await tx.query<BookRow & Record<string, unknown>>(
        `SELECT id,name,environment,base_asset,owner_module,purpose,subject_id,created_at
         FROM ledger_books WHERE tenant_id=$1 AND workspace_id=$2 AND deleted_hlc IS NULL
           AND ($3::text IS NULL OR environment=$3) AND ($4::text IS NULL OR owner_module=$4)
         ORDER BY name,id`,
        [scope.tenantId, scope.workspaceId, filter.environment ?? null, filter.ownerModule ?? null],
      );
      return rows.map((row) => Book.parse(this.bookOut(row)));
    });
  }

  async createAccount(scope: LedgerScope, actorId: string, value: CreateAccountInput): Promise<Account> {
    const input = CreateAccountInput.parse(value);
    return this.inScope(scope, async (tx) => {
      const book = await tx.query<{ environment: Account['environment'] }>(
        `SELECT environment FROM ledger_books WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND deleted_hlc IS NULL`,
        [scope.tenantId, scope.workspaceId, input.bookId],
      );
      const environment = book.rows[0]?.environment;
      if (!environment) throw new LedgerStoreError('NOT_FOUND', 'Ledger book not found');
      const id = input.id ?? randomUUID();
      const { rows } = await tx.query<AccountRow & Record<string, unknown>>(
        `INSERT INTO ledger_accounts(id,tenant_id,workspace_id,book_id,environment,code,name,type,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id,book_id,environment,code,name,type,created_at`,
        [
          id,
          scope.tenantId,
          scope.workspaceId,
          input.bookId,
          environment,
          input.code,
          input.name,
          input.type,
          actorId,
        ],
      );
      return Account.parse(this.accountOut(rows[0]));
    });
  }

  async accounts(scope: LedgerScope, bookId: string): Promise<Account[]> {
    return this.inScope(scope, async (tx) => {
      const { rows } = await tx.query<AccountRow & Record<string, unknown>>(
        `SELECT id,book_id,environment,code,name,type,created_at FROM ledger_accounts
         WHERE tenant_id=$1 AND workspace_id=$2 AND book_id=$3 AND deleted_hlc IS NULL ORDER BY code,id`,
        [scope.tenantId, scope.workspaceId, bookId],
      );
      return rows.map((row) => Account.parse(this.accountOut(row)));
    });
  }

  async post(scope: LedgerScope, actorId: string, value: PostTransactionInput): Promise<PostResult> {
    return this.postWithReverse(scope, actorId, value, null);
  }

  private async postWithReverse(
    scope: LedgerScope,
    actorId: string,
    value: PostTransactionInput,
    reversesId: string | null,
  ): Promise<PostResult> {
    const input = PostTransactionInput.parse(value);
    if (input.environment === 'live') throw new LedgerStoreError('LIVE_TRADING_DISABLED');
    const totals = new Map<string, bigint>();
    for (const entry of input.entries) {
      const current = totals.get(entry.asset) ?? 0n;
      totals.set(entry.asset, current + toUnits(entry.units));
    }
    if ([...totals.values()].some((units) => units !== 0n)) throw new LedgerStoreError('UNBALANCED');

    return this.inScope(scope, async (tx) => {
      const prior = await tx.query<Record<string, unknown>>(
        `SELECT id,book_id,environment,effective_date::text,description,source,correlation_id,reverses_id
         FROM ledger_transactions WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
        [scope.tenantId, scope.workspaceId, input.id],
      );
      if (prior.rows[0]) {
        const priorEntries = await tx.query<Record<string, unknown>>(
          `SELECT account_id,asset,units::text,memo,external_ref FROM ledger_entries
           WHERE tenant_id=$1 AND workspace_id=$2 AND transaction_id=$3 ORDER BY line_no`,
          [scope.tenantId, scope.workspaceId, input.id],
        );
        const sameHeader =
          prior.rows[0]['book_id'] === input.bookId &&
          prior.rows[0]['environment'] === input.environment &&
          prior.rows[0]['effective_date'] === input.effectiveDate &&
          prior.rows[0]['description'] === input.description &&
          prior.rows[0]['source'] === input.source &&
          prior.rows[0]['correlation_id'] === (input.correlationId ?? null) &&
          prior.rows[0]['reverses_id'] === reversesId;
        const sameEntries =
          priorEntries.rows.length === input.entries.length &&
          priorEntries.rows.every((row, index) => {
            const expected = input.entries[index];
            return (
              !!expected &&
              row['account_id'] === expected.accountId &&
              row['asset'] === expected.asset &&
              String(row['units']) === expected.units &&
              row['memo'] === (expected.memo ?? null) &&
              row['external_ref'] === (expected.externalRef ?? null)
            );
          });
        if (!sameHeader || !sameEntries) throw new LedgerStoreError('IDEMPOTENCY_CONFLICT');
        return PostResult.parse({ status: 'exists', transactionId: input.id, discrepancyId: null });
      }

      const book = await tx.query<{ environment: string }>(
        `SELECT environment FROM ledger_books WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND deleted_hlc IS NULL`,
        [scope.tenantId, scope.workspaceId, input.bookId],
      );
      if (!book.rows[0]) throw new LedgerStoreError('NOT_FOUND', 'Ledger book not found');
      if (book.rows[0].environment !== input.environment) throw new LedgerStoreError('ENVIRONMENT_MISMATCH');

      for (const entry of input.entries) {
        const account = await tx.query(
          `SELECT 1 FROM ledger_accounts WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
             AND book_id=$4 AND environment=$5 AND deleted_hlc IS NULL`,
          [scope.tenantId, scope.workspaceId, entry.accountId, input.bookId, input.environment],
        );
        if (!account.rows.length) throw new LedgerStoreError('CROSS_BOOK');
        const asset = await tx.query(
          'SELECT 1 FROM ledger_assets WHERE tenant_id=$1 AND workspace_id=$2 AND code=$3',
          [scope.tenantId, scope.workspaceId, entry.asset],
        );
        if (!asset.rows.length) throw new LedgerStoreError('UNKNOWN_ASSET');
      }

      const seenRefs = new Set<string>();
      for (const entry of input.entries) {
        if (!entry.externalRef) continue;
        const key = `${entry.accountId}\u0000${entry.externalRef}`;
        if (!seenRefs.has(key)) {
          seenRefs.add(key);
          const duplicate = await tx.query<Record<string, unknown>>(
            `SELECT id FROM ledger_entries WHERE tenant_id=$1 AND workspace_id=$2 AND account_id=$3 AND external_ref=$4`,
            [scope.tenantId, scope.workspaceId, entry.accountId, entry.externalRef],
          );
          if (!duplicate.rows.length) continue;
        }
        const discrepancyId = randomUUID();
        await tx.query(
          `INSERT INTO ledger_discrepancies(id,tenant_id,workspace_id,kind,status,environment,book_id,
             account_id,asset,expected_units,recorded_units,external_ref,detail)
           VALUES ($1,$2,$3,'duplicate_import','open',$4,$5,$6,$7,$8,$9,$10,'Duplicate external reference rejected')`,
          [
            discrepancyId,
            scope.tenantId,
            scope.workspaceId,
            input.environment,
            input.bookId,
            entry.accountId,
            entry.asset,
            entry.units,
            entry.units,
            entry.externalRef,
          ],
        );
        return PostResult.parse({ status: 'duplicate', transactionId: input.id, discrepancyId });
      }

      await tx.query(
        `INSERT INTO ledger_transactions(id,tenant_id,workspace_id,book_id,environment,effective_date,
           description,source,correlation_id,reverses_id,posted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          input.id,
          scope.tenantId,
          scope.workspaceId,
          input.bookId,
          input.environment,
          input.effectiveDate,
          input.description,
          input.source,
          input.correlationId ?? null,
          reversesId,
          actorId,
        ],
      );
      for (const [index, entry] of input.entries.entries()) {
        await tx.query(
          `INSERT INTO ledger_entries(id,tenant_id,workspace_id,transaction_id,line_no,book_id,environment,
             account_id,asset,units,memo,external_ref,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11,$12,$13)`,
          [
            randomUUID(),
            scope.tenantId,
            scope.workspaceId,
            input.id,
            index + 1,
            input.bookId,
            input.environment,
            entry.accountId,
            entry.asset,
            entry.units,
            entry.memo ?? null,
            entry.externalRef ?? null,
            actorId,
          ],
        );
      }
      return PostResult.parse({ status: 'posted', transactionId: input.id, discrepancyId: null });
    });
  }

  async reverse(scope: LedgerScope, actorId: string, value: ReverseTransactionInput): Promise<PostResult> {
    const input = ReverseTransactionInput.parse(value);
    const original = await this.inScope(scope, async (tx) => {
      const header = await tx.query<Record<string, unknown>>(
        `SELECT book_id,environment,effective_date::text,description,source,correlation_id
         FROM ledger_transactions WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
        [scope.tenantId, scope.workspaceId, input.transactionId],
      );
      if (!header.rows[0]) throw new LedgerStoreError('NOT_FOUND', 'Transaction not found');
      const entries = await tx.query<Record<string, unknown>>(
        `SELECT account_id,asset,units::text FROM ledger_entries
         WHERE tenant_id=$1 AND workspace_id=$2 AND transaction_id=$3 ORDER BY line_no`,
        [scope.tenantId, scope.workspaceId, input.transactionId],
      );
      return { header: header.rows[0], entries: entries.rows };
    });
    try {
      return await this.postWithReverse(
        scope,
        actorId,
        {
          id: input.id,
          bookId: String(original.header['book_id']),
          environment: original.header['environment'] as PostTransactionInput['environment'],
          effectiveDate: input.effectiveDate,
          description: input.reason,
          source: String(original.header['source']),
          correlationId: (original.header['correlation_id'] as string | null) ?? undefined,
          entries: original.entries.map((entry) => ({
            accountId: String(entry['account_id']),
            asset: String(entry['asset']),
            units: (-toUnits(String(entry['units']))).toString(),
          })),
        },
        input.transactionId,
      );
    } catch (error) {
      if (error instanceof LedgerStoreError && error.code === 'IDEMPOTENCY_CONFLICT') throw error;
      const message = pgMessage(error);
      if (/reverses_id|ALREADY_REVERSED/.test(message)) throw new LedgerStoreError('ALREADY_REVERSED');
      throw error;
    }
  }

  async balances(scope: LedgerScope, value: BalanceQuery): Promise<Balance[]> {
    const query = BalanceQuery.parse(value);
    return this.inScope(scope, async (tx) => {
      const accountIds = query.accountIds?.length ? query.accountIds : null;
      if (query.accountIds?.length === 0) return [];
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT b.book_id,b.environment,b.account_id,a.code AS account_code,a.name AS account_name,
           a.type AS account_type,b.asset,asst.scale,b.units::text AS units,b.entry_count
         FROM ledger_balances b
         JOIN ledger_accounts a ON a.tenant_id=b.tenant_id AND a.workspace_id=b.workspace_id AND a.id=b.account_id
         JOIN ledger_assets asst ON asst.tenant_id=b.tenant_id AND asst.workspace_id=b.workspace_id AND asst.code=b.asset
         WHERE b.tenant_id=$1 AND b.workspace_id=$2 AND b.environment=$3
           AND ($4::uuid IS NULL OR b.book_id=$4)
           AND ($5::uuid[] IS NULL OR b.account_id=ANY($5))
           AND ($6::text IS NULL OR b.asset=$6)
         ORDER BY a.code,b.asset`,
        [
          scope.tenantId,
          scope.workspaceId,
          query.environment,
          query.bookId ?? null,
          accountIds,
          query.asset ?? null,
        ],
      );
      return rows.map((row) =>
        Balance.parse({
          bookId: row['book_id'],
          environment: row['environment'],
          accountId: row['account_id'],
          accountCode: row['account_code'],
          accountName: row['account_name'],
          accountType: row['account_type'],
          asset: row['asset'],
          scale: row['scale'],
          units: String(row['units']),
          entryCount: row['entry_count'],
        }),
      );
    });
  }

  private bookOut(row: BookRow | undefined): unknown {
    if (!row) throw new LedgerStoreError('NOT_FOUND');
    return {
      id: row.id,
      name: row.name,
      environment: row.environment,
      baseAsset: row.base_asset,
      ownerModule: row.owner_module,
      purpose: row.purpose,
      subjectId: row.subject_id,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }

  private accountOut(row: AccountRow | undefined): unknown {
    if (!row) throw new LedgerStoreError('NOT_FOUND');
    return {
      id: row.id,
      bookId: row.book_id,
      environment: row.environment,
      code: row.code,
      name: row.name,
      type: row.type,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }
}

export function validatePostingUnits(input: PostTransactionInput): void {
  const parsed = PostTransactionInput.parse(input);
  if (parsed.environment === 'live') throw new LedgerStoreError('LIVE_TRADING_DISABLED');
  const totals = new Map<string, bigint>();
  for (const entry of parsed.entries) {
    totals.set(entry.asset, (totals.get(entry.asset) ?? 0n) + toUnits(entry.units));
  }
  if ([...totals.values()].some((units) => units !== 0n)) throw new LedgerStoreError('UNBALANCED');
  for (const entry of parsed.entries) MinorUnits.parse(entry.units);
}

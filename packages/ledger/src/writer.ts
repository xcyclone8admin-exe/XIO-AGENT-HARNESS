import { createHash, randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { LocalScopedStore } from '@xyra/db';
import {
  Account,
  Asset,
  Balance,
  BalanceQuery,
  Book,
  Discrepancy,
  DiscrepancyQuery,
  Transaction,
  TransactionPage,
  TransactionQuery,
  TrialBalance,
  TrialBalanceQuery,
  TotalsQuery,
  TypeTotals,
  ReconcileInput,
  ReconciliationRun,
  AssignDiscrepancyInput,
  ResolveDiscrepancyInput,
  CreateAccountInput,
  CreateBookInput,
  MinorUnits,
  PostResult,
  PostTransactionInput,
  ReverseTransactionInput,
} from './contracts';
import type {
  LedgerApi,
  LedgerEnvironment,
  LedgerScope,
  PaperTradeLedgerApi,
  PaperTradeTransaction,
  TrialBalance as TrialBalanceType,
} from './contracts';
import { toUnits } from './units';

export type LedgerStoreErrorCode =
  | 'UNBALANCED'
  | 'TOO_FEW_ENTRIES'
  | 'ENVIRONMENT_MISMATCH'
  | 'CROSS_ENVIRONMENT'
  | 'CROSS_BOOK'
  | 'LIVE_TRADING_DISABLED'
  | 'PAPER_ONLY'
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
export class PGliteLedgerWriter implements LedgerApi, PaperTradeLedgerApi {
  private readonly scoped: LocalScopedStore;
  constructor(private readonly db: PGlite) {
    this.scoped = new LocalScopedStore(db);
  }

  private async inScope<T>(scope: LedgerScope, work: (tx: TxContext) => Promise<T>): Promise<T> {
    if (!/^[0-9a-f-]{36}$/i.test(scope.tenantId) || !/^[0-9a-f-]{36}$/i.test(scope.workspaceId)) {
      throw new LedgerStoreError('NOT_FOUND', 'Invalid ledger scope');
    }
    if (scope.hlc !== undefined && !/^\d{13}-[0-9a-f]{4}-[a-z0-9]{1,32}$/.test(scope.hlc)) {
      throw new LedgerStoreError('NOT_FOUND', 'Invalid workspace HLC');
    }
    if (scope.hlc !== undefined && Number(scope.hlc.slice(0, 13)) > Date.now() + 60_000) {
      throw new LedgerStoreError('NOT_FOUND', 'Workspace HLC is too far in the future');
    }
    try {
      return await this.scoped.withServerScope(scope, 'money_ledger', scope.hlc, (tx) =>
        work({ query: tx.query }),
      );
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

  /**
   * Execute Invest's domain writes and ledger posting in one capability-scoped transaction.
   * The `invest_paper_execution` role receives only declared Invest rows, ledger read tables,
   * ledger append tables and the local balance projection.
   */
  async withPaperTradeTransaction<T>(
    scope: LedgerScope,
    work: (transaction: PaperTradeTransaction) => Promise<T>,
  ): Promise<T> {
    if (!/^[0-9a-f-]{36}$/i.test(scope.tenantId) || !/^[0-9a-f-]{36}$/i.test(scope.workspaceId)) {
      throw new LedgerStoreError('NOT_FOUND', 'Invalid ledger scope');
    }
    try {
      return await this.scoped.withServerScope(
        scope,
        'invest_paper_execution',
        scope.hlc,
        async (scopedTx) => {
          const tx: TxContext = { query: (sql, params) => scopedTx.query(sql, params) };
          const transaction: PaperTradeTransaction = {
            query: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) =>
              scopedTx.query<T>(sql, params),
            post: async (actorId, value) => {
              const input = PostTransactionInput.parse(value);
              if (input.environment !== 'paper') throw new LedgerStoreError('PAPER_ONLY');
              if (input.entries.some((entry) => entry.externalRef !== undefined)) {
                throw new LedgerStoreError(
                  'IDEMPOTENCY_CONFLICT',
                  'Paper trade posting uses correlationId, not import externalRef',
                );
              }
              return this.postInTransaction(tx, scope, actorId, input, null);
            },
          };
          return work(transaction);
        },
      );
    } catch (error) {
      const message = pgMessage(error);
      if (/LIVE_TRADING_DISABLED/.test(message)) throw new LedgerStoreError('LIVE_TRADING_DISABLED');
      if (/PAPER_ONLY/.test(message)) throw new LedgerStoreError('PAPER_ONLY');
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
    return this.inScope(scope, (tx) => this.postInTransaction(tx, scope, actorId, value, reversesId));
  }

  private async postInTransaction(
    tx: TxContext,
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

    {
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
    }
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

  async transactions(scope: LedgerScope, value: TransactionQuery): Promise<TransactionPage> {
    const query = TransactionQuery.parse(value);
    if (query.from && query.to && query.from > query.to)
      throw new LedgerStoreError('NOT_FOUND', 'Invalid date range');
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    return this.inScope(scope, async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT t.id,t.book_id,t.environment,t.effective_date::text,t.description,t.source,t.correlation_id,
           t.reverses_id,r.id AS reversed_by_id,t.posted_by,t.posted_at
         FROM ledger_transactions t LEFT JOIN ledger_transactions r
           ON r.tenant_id=t.tenant_id AND r.workspace_id=t.workspace_id AND r.reverses_id=t.id
         WHERE t.tenant_id=$1 AND t.workspace_id=$2 AND t.environment=$3
           AND ($4::uuid IS NULL OR t.book_id=$4) AND ($5::uuid IS NULL OR t.correlation_id=$5)
           AND ($6::date IS NULL OR t.effective_date >= $6) AND ($7::date IS NULL OR t.effective_date <= $7)
           AND ($8::uuid IS NULL OR EXISTS (SELECT 1 FROM ledger_entries e WHERE e.tenant_id=t.tenant_id
             AND e.workspace_id=t.workspace_id AND e.transaction_id=t.id AND e.account_id=$8))
           AND ($9::date IS NULL OR (t.effective_date,t.id) < ($9::date,$10::uuid))
         ORDER BY t.effective_date DESC,t.id DESC LIMIT $11`,
        [
          scope.tenantId,
          scope.workspaceId,
          query.environment,
          query.bookId ?? null,
          query.correlationId ?? null,
          query.from ?? null,
          query.to ?? null,
          query.accountId ?? null,
          cursor?.date ?? null,
          cursor?.id ?? null,
          query.limit + 1,
        ],
      );
      const hasMore = rows.length > query.limit;
      const pageRows = rows.slice(0, query.limit);
      const items = [];
      for (const row of pageRows) {
        const entryResult = await tx.query<Record<string, unknown>>(
          `SELECT id,transaction_id,line_no,account_id,asset,units::text,memo,external_ref FROM ledger_entries
           WHERE tenant_id=$1 AND workspace_id=$2 AND transaction_id=$3 ORDER BY line_no`,
          [scope.tenantId, scope.workspaceId, row['id']],
        );
        items.push(
          Transaction.parse({
            id: row['id'],
            bookId: row['book_id'],
            environment: row['environment'],
            effectiveDate: row['effective_date'],
            description: row['description'],
            source: row['source'],
            correlationId: row['correlation_id'],
            reversesId: row['reverses_id'],
            reversedById: row['reversed_by_id'],
            postedBy: row['posted_by'],
            postedAt: this.iso(row['posted_at']),
            entries: entryResult.rows.map((entry) => ({
              id: entry['id'],
              transactionId: entry['transaction_id'],
              lineNo: entry['line_no'],
              accountId: entry['account_id'],
              asset: entry['asset'],
              units: String(entry['units']),
              memo: entry['memo'],
              externalRef: entry['external_ref'],
            })),
          }),
        );
      }
      const last = pageRows.at(-1);
      const nextCursor =
        hasMore && last ? this.encodeCursor(String(last['effective_date']), String(last['id'])) : null;
      return TransactionPage.parse({ items, nextCursor });
    });
  }

  async trialBalance(scope: LedgerScope, value: TrialBalanceQuery): Promise<TrialBalanceType> {
    const query = TrialBalanceQuery.parse(value);
    return this.inScope(scope, async (tx) => {
      const book = await tx.query(
        `SELECT 1 FROM ledger_books WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND environment=$4`,
        [scope.tenantId, scope.workspaceId, query.bookId, query.environment],
      );
      if (!book.rows.length) throw new LedgerStoreError('NOT_FOUND', 'Ledger book not found');
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT a.id AS account_id,a.code AS account_code,a.name AS account_name,a.type AS account_type,
          asst.code AS asset,asst.scale,COALESCE(sum(e.units),0)::text AS units
         FROM ledger_accounts a JOIN ledger_assets asst ON asst.tenant_id=a.tenant_id AND asst.workspace_id=a.workspace_id
         LEFT JOIN ledger_entries e ON e.tenant_id=a.tenant_id AND e.workspace_id=a.workspace_id AND e.account_id=a.id
           AND e.book_id=a.book_id AND e.environment=a.environment AND e.asset=asst.code
         WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND a.book_id=$3 AND a.environment=$4 AND a.deleted_hlc IS NULL
         GROUP BY a.id,a.code,a.name,a.type,asst.code,asst.scale ORDER BY a.code,asst.code`,
        [scope.tenantId, scope.workspaceId, query.bookId, query.environment],
      );
      const byAsset = new Map<string, { scale: number; debit: bigint; credit: bigint }>();
      const mapped = rows.map((r) => {
        const units = BigInt(String(r['units']));
        const agg = byAsset.get(String(r['asset'])) ?? { scale: Number(r['scale']), debit: 0n, credit: 0n };
        if (units > 0n) agg.debit += units;
        else agg.credit += -units;
        byAsset.set(String(r['asset']), agg);
        return {
          accountId: r['account_id'],
          accountCode: r['account_code'],
          accountName: r['account_name'],
          accountType: r['account_type'],
          asset: r['asset'],
          scale: r['scale'],
          debit: (units > 0n ? units : 0n).toString(),
          credit: (units < 0n ? -units : 0n).toString(),
        };
      });
      return TrialBalance.parse({
        environment: query.environment,
        bookId: query.bookId,
        rows: mapped,
        totals: [...byAsset].map(([asset, x]) => ({
          asset,
          scale: x.scale,
          debit: x.debit.toString(),
          credit: x.credit.toString(),
          balanced: x.debit === x.credit,
        })),
      });
    });
  }

  async totals(scope: LedgerScope, value: TotalsQuery): Promise<TypeTotals> {
    const query = TotalsQuery.parse(value);
    return this.inScope(scope, async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT a.type,asst.scale,COALESCE(sum(e.units),0)::text AS units,count(DISTINCT b.id)::int AS book_count
         FROM ledger_books b JOIN ledger_accounts a ON a.tenant_id=b.tenant_id AND a.workspace_id=b.workspace_id
           AND a.book_id=b.id AND a.environment=b.environment AND a.deleted_hlc IS NULL
         JOIN ledger_assets asst ON asst.tenant_id=b.tenant_id AND asst.workspace_id=b.workspace_id AND asst.code=$5
         LEFT JOIN ledger_entries e ON e.tenant_id=a.tenant_id AND e.workspace_id=a.workspace_id AND e.account_id=a.id AND e.asset=$5
         WHERE b.tenant_id=$1 AND b.workspace_id=$2 AND b.environment=$3 AND b.deleted_hlc IS NULL
           AND ($4::uuid[] IS NULL OR b.id=ANY($4)) AND ($6::text IS NULL OR b.owner_module=$6)
         GROUP BY a.type,asst.scale ORDER BY a.type`,
        [
          scope.tenantId,
          scope.workspaceId,
          query.environment,
          query.bookIds?.length ? query.bookIds : null,
          query.asset,
          query.ownerModule ?? null,
        ],
      );
      const bookCount = await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ledger_books b
         WHERE b.tenant_id=$1 AND b.workspace_id=$2 AND b.environment=$3 AND b.deleted_hlc IS NULL
           AND ($4::uuid[] IS NULL OR b.id=ANY($4)) AND ($5::text IS NULL OR b.owner_module=$5)
           AND EXISTS (SELECT 1 FROM ledger_assets a WHERE a.tenant_id=b.tenant_id AND a.workspace_id=b.workspace_id AND a.code=$6)`,
        [
          scope.tenantId,
          scope.workspaceId,
          query.environment,
          query.bookIds?.length ? query.bookIds : null,
          query.ownerModule ?? null,
          query.asset,
        ],
      );
      const byType = Object.fromEntries(rows.map((r) => [String(r['type']), String(r['units'])]));
      for (const type of ['asset', 'liability', 'equity', 'income', 'expense']) byType[type] ??= '0';
      return TypeTotals.parse({
        environment: query.environment,
        asset: query.asset,
        scale: rows[0]?.['scale'] ?? 0,
        byType,
        bookCount: bookCount.rows[0]?.count ?? 0,
      });
    });
  }

  async reconcile(scope: LedgerScope, actorId: string, value: ReconcileInput): Promise<ReconciliationRun> {
    const input = ReconcileInput.parse(value);
    return this.inScope(scope, async (tx) => {
      const filter = [scope.tenantId, scope.workspaceId, input.environment, input.bookId ?? null];
      const mismatches = await tx.query<Record<string, unknown>>(
        `WITH truth AS (SELECT e.book_id,e.environment,e.account_id,e.asset,sum(e.units)::text AS units,count(*)::int AS entry_count
          FROM ledger_entries e WHERE e.tenant_id=$1 AND e.workspace_id=$2 AND e.environment=$3
            AND ($4::uuid IS NULL OR e.book_id=$4) GROUP BY e.book_id,e.environment,e.account_id,e.asset),
         all_keys AS (SELECT book_id,environment,account_id,asset FROM truth UNION
          SELECT book_id,environment,account_id,asset FROM ledger_balances WHERE tenant_id=$1 AND workspace_id=$2
            AND environment=$3 AND ($4::uuid IS NULL OR book_id=$4))
         SELECT k.book_id,k.environment,k.account_id,k.asset,t.units AS expected_units,b.units::text AS recorded_units,
           t.entry_count,b.entry_count AS recorded_count,
           CASE WHEN t.account_id IS NULL THEN 'orphan_balance' WHEN b.account_id IS NULL THEN 'missing_balance'
             ELSE 'balance_mismatch' END AS kind
         FROM all_keys k LEFT JOIN truth t USING(book_id,environment,account_id,asset)
          LEFT JOIN ledger_balances b ON b.tenant_id=$1 AND b.workspace_id=$2 AND b.book_id=k.book_id
            AND b.environment=k.environment AND b.account_id=k.account_id AND b.asset=k.asset
         WHERE t.account_id IS NULL OR b.account_id IS NULL OR t.units<>b.units::text OR t.entry_count<>b.entry_count
         ORDER BY k.book_id,k.account_id,k.asset`,
        filter,
      );
      const watermark = await tx.query<{ entry_count: number; latest_entry: string | null }>(
        `SELECT count(*)::int AS entry_count,max(created_at)::text AS latest_entry FROM ledger_entries
         WHERE tenant_id=$1 AND workspace_id=$2 AND environment=$3 AND ($4::uuid IS NULL OR book_id=$4)`,
        filter,
      );
      const payload = JSON.stringify([
        scope.tenantId,
        scope.workspaceId,
        input.environment,
        input.bookId ?? null,
        watermark.rows[0]?.entry_count ?? 0,
        watermark.rows[0]?.latest_entry ?? null,
      ]);
      const runKey = createHash('sha256').update(payload).digest('hex');
      const prior = await tx.query<Record<string, unknown>>(
        `SELECT id,environment,book_id,run_key,checked_balances,discrepancy_count,status,started_at FROM ledger_reconciliation_runs
         WHERE tenant_id=$1 AND workspace_id=$2 AND environment=$3 AND book_id IS NOT DISTINCT FROM $4 AND run_key=$5`,
        [scope.tenantId, scope.workspaceId, input.environment, input.bookId ?? null, runKey],
      );
      if (prior.rows[0]) return this.runOut(prior.rows[0], true);
      const id = randomUUID();
      const status = mismatches.rows.length ? 'discrepancies' : 'clean';
      const checked = await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM (
          SELECT e.book_id,e.account_id,e.asset FROM ledger_entries e WHERE e.tenant_id=$1 AND e.workspace_id=$2
            AND e.environment=$3 AND ($4::uuid IS NULL OR e.book_id=$4) GROUP BY e.book_id,e.account_id,e.asset
          UNION SELECT b.book_id,b.account_id,b.asset FROM ledger_balances b WHERE b.tenant_id=$1 AND b.workspace_id=$2
            AND b.environment=$3 AND ($4::uuid IS NULL OR b.book_id=$4)) keys`,
        filter,
      );
      await tx.query(
        `INSERT INTO ledger_reconciliation_runs(id,tenant_id,workspace_id,environment,book_id,run_key,
        checked_balances,discrepancy_count,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          scope.tenantId,
          scope.workspaceId,
          input.environment,
          input.bookId ?? null,
          runKey,
          checked.rows[0]?.count ?? 0,
          mismatches.rows.length,
          status,
          actorId,
        ],
      );
      for (const m of mismatches.rows)
        await tx.query(
          `INSERT INTO ledger_discrepancies(id,tenant_id,workspace_id,run_id,kind,status,environment,book_id,account_id,asset,
          expected_units,recorded_units,detail) VALUES($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10,$11,$12)`,
          [
            randomUUID(),
            scope.tenantId,
            scope.workspaceId,
            id,
            m['kind'],
            input.environment,
            m['book_id'],
            m['account_id'],
            m['asset'],
            m['expected_units'],
            m['recorded_units'],
            'Balance projection differs from immutable ledger entries',
          ],
        );
      return ReconciliationRun.parse({
        id,
        environment: input.environment,
        bookId: input.bookId ?? null,
        runKey,
        checkedBalances: checked.rows[0]?.count ?? 0,
        discrepancyCount: mismatches.rows.length,
        status,
        startedAt: new Date().toISOString(),
        reused: false,
      });
    });
  }

  async discrepancies(scope: LedgerScope, value: DiscrepancyQuery): Promise<Discrepancy[]> {
    const query = DiscrepancyQuery.parse(value);
    const result = await this.scoped.query<Record<string, unknown>>(
      scope,
      `SELECT id,run_id,kind,status,owner_id,environment,book_id,account_id,asset,expected_units::text,recorded_units::text,
         external_ref,detail,resolution,created_at,resolved_at FROM ledger_discrepancies
       WHERE tenant_id=$1 AND workspace_id=$2 AND environment=$3 AND ($4::text IS NULL OR status=$4)
         AND ($5::uuid IS NULL OR book_id=$5) ORDER BY created_at DESC,id`,
      [scope.tenantId, scope.workspaceId, query.environment, query.status ?? null, query.bookId ?? null],
    );
    return result.rows.map((r) => this.discrepancyOut(r));
  }

  async assignDiscrepancy(
    scope: LedgerScope,
    actorId: string,
    value: AssignDiscrepancyInput,
  ): Promise<Discrepancy> {
    const input = AssignDiscrepancyInput.parse(value);
    return this.inScope(scope, async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE ledger_discrepancies SET owner_id=$4,status='assigned',updated_at=now()
         WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND status<>'resolved'
         RETURNING id,run_id,kind,status,owner_id,environment,book_id,account_id,asset,expected_units::text,recorded_units::text,
           external_ref,detail,resolution,created_at,resolved_at`,
        [scope.tenantId, scope.workspaceId, input.discrepancyId, input.ownerId],
      );
      if (!rows[0]) throw new LedgerStoreError('NOT_FOUND', 'Open discrepancy not found');
      return this.discrepancyOut(rows[0]);
    });
  }

  async resolveDiscrepancy(
    scope: LedgerScope,
    actorId: string,
    value: ResolveDiscrepancyInput,
  ): Promise<Discrepancy> {
    const input = ResolveDiscrepancyInput.parse(value);
    return this.inScope(scope, async (tx) => {
      const before = await tx.query<Record<string, unknown>>(
        `SELECT id,book_id,environment,account_id,asset FROM ledger_discrepancies
         WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND status<>'resolved'`,
        [scope.tenantId, scope.workspaceId, input.discrepancyId],
      );
      const d = before.rows[0];
      if (!d) throw new LedgerStoreError('NOT_FOUND', 'Open discrepancy not found');
      if (input.rebuildProjection && d['account_id'] && d['asset']) {
        await tx.query(
          `INSERT INTO ledger_balances(tenant_id,workspace_id,book_id,environment,account_id,asset,units,entry_count,as_of_hlc)
          SELECT $1,$2,$5,$6,$3,$4,COALESCE(sum(units),0),count(*)::int,$7
          FROM ledger_entries WHERE tenant_id=$1 AND workspace_id=$2 AND account_id=$3 AND asset=$4
          ON CONFLICT(tenant_id,workspace_id,account_id,asset) DO UPDATE SET
            units=EXCLUDED.units,entry_count=EXCLUDED.entry_count,as_of_hlc=GREATEST(ledger_balances.as_of_hlc,EXCLUDED.as_of_hlc)`,
          [
            scope.tenantId,
            scope.workspaceId,
            d['account_id'],
            d['asset'],
            d['book_id'],
            d['environment'],
            scope.hlc ?? '',
          ],
        );
      }
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE ledger_discrepancies SET status='resolved',resolution=$4,resolved_at=now(),updated_at=now()
         WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
         RETURNING id,run_id,kind,status,owner_id,environment,book_id,account_id,asset,expected_units::text,recorded_units::text,
           external_ref,detail,resolution,created_at,resolved_at`,
        [scope.tenantId, scope.workspaceId, input.discrepancyId, input.resolution],
      );
      if (!rows[0]) throw new LedgerStoreError('NOT_FOUND', 'Discrepancy not found');
      return this.discrepancyOut(rows[0]);
    });
  }

  private encodeCursor(date: string, id: string): string {
    return Buffer.from(JSON.stringify({ date, id }), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string): { date: string; id: string } {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        date?: unknown;
        id?: unknown;
      };
      if (
        typeof decoded.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(decoded.date) ||
        typeof decoded.id !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(decoded.id)
      )
        throw new Error('bad cursor');
      return { date: decoded.date, id: decoded.id };
    } catch {
      throw new LedgerStoreError('NOT_FOUND', 'Invalid transaction cursor');
    }
  }

  private iso(value: unknown): string {
    return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  }

  private runOut(row: Record<string, unknown>, reused: boolean): ReconciliationRun {
    return ReconciliationRun.parse({
      id: row['id'],
      environment: row['environment'],
      bookId: row['book_id'],
      runKey: row['run_key'],
      checkedBalances: row['checked_balances'],
      discrepancyCount: row['discrepancy_count'],
      status: row['status'],
      startedAt: this.iso(row['started_at']),
      reused,
    });
  }

  private discrepancyOut(row: Record<string, unknown>): Discrepancy {
    return Discrepancy.parse({
      id: row['id'],
      runId: row['run_id'],
      kind: row['kind'],
      status: row['status'],
      ownerId: row['owner_id'],
      environment: row['environment'],
      bookId: row['book_id'],
      accountId: row['account_id'],
      asset: row['asset'],
      expectedUnits: row['expected_units'] === null ? null : String(row['expected_units']),
      recordedUnits: row['recorded_units'] === null ? null : String(row['recorded_units']),
      externalRef: row['external_ref'],
      detail: row['detail'],
      resolution: row['resolution'],
      createdAt: this.iso(row['created_at']),
      resolvedAt: row['resolved_at'] === null ? null : this.iso(row['resolved_at']),
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

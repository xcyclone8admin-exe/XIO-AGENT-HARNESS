/**
 * @xyra/ledger public contract (ADR-0010 + Amendment 1, ADR-0003 A1 §E). FROZEN at LEDGER_CONTRACT_VERSION:
 * money, invest, studio and corporate code against these shapes. Additive changes bump the minor version;
 * existing public shapes and referenced SQL objects change additively only (ADR-0016).
 *
 * Money rules that hold everywhere in this contract:
 * - Every asset has an integer `scale` (USD 2, JPY 0, BTC 8, ETH 18, equities 6).
 * - Amounts are bigint minor units in TypeScript, `numeric(38,0)` in SQL and base-10 strings on the wire.
 *   No float ever represents money or quantity.
 * - Entries are signed: positive = debit, negative = credit. A transaction balances when, per asset,
 *   the signed units of its entries sum to zero.
 * - Books are partitioned by environment (actual | paper | live). A transaction lives in exactly one book,
 *   so it never spans environments; a deferred constraint trigger re-checks this in the database.
 * - Every aggregate takes a REQUIRED `environment` argument. There is no default.
 * - `live` books exist in the schema but refuse postings while LIVE_TRADING_DISABLED holds.
 */
import { defineCapability, type ModuleManifestInput } from '@xyra/contracts';
import { z } from 'zod';

export const LEDGER_CONTRACT_VERSION = '1.2.0';

// ---------------------------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------------------------

export const LEDGER_ENVIRONMENTS = ['actual', 'paper', 'live'] as const;
export const LedgerEnvironment = z.enum(LEDGER_ENVIRONMENTS);
export type LedgerEnvironment = z.infer<typeof LedgerEnvironment>;

/** Signed bigint minor units serialized as a base-10 string; fits numeric(38,0). */
export const MinorUnits = z
  .string()
  .regex(/^(0|-?[1-9]\d{0,37})$/, 'canonical integer minor units, at most 38 digits');
export type MinorUnits = z.infer<typeof MinorUnits>;
/** Non-zero minor units (an entry of zero carries no information and is rejected). */
export const NonZeroMinorUnits = MinorUnits.refine((v) => v !== '0', 'entry units must be non-zero');

/** Upper-case code: ISO-4217 currency, crypto ticker, or an instrument code such as `EQ:AAPL`. */
export const AssetCode = z.string().regex(/^[A-Z0-9][A-Z0-9._:-]{0,31}$/, 'asset code');
export type AssetCode = z.infer<typeof AssetCode>;
export const AssetKind = z.enum(['fiat', 'crypto', 'security', 'unit']);
export type AssetKind = z.infer<typeof AssetKind>;
export const MAX_ASSET_SCALE = 18;

export const Asset = z.object({
  code: AssetCode,
  /** Number of decimal places one minor unit represents; immutable once an asset is registered. */
  scale: z.int().min(0).max(MAX_ASSET_SCALE),
  kind: AssetKind,
  name: z.string().trim().min(1).max(120),
});
export type Asset = z.infer<typeof Asset>;

/** Equities and fund units use 6 decimal places so fractional shares stay exact. */
export const SECURITY_SCALE = 6;

export const BUILTIN_ASSETS: readonly Asset[] = Object.freeze([
  { code: 'USD', scale: 2, kind: 'fiat', name: 'US dollar' },
  { code: 'EUR', scale: 2, kind: 'fiat', name: 'Euro' },
  { code: 'GBP', scale: 2, kind: 'fiat', name: 'Pound sterling' },
  { code: 'CAD', scale: 2, kind: 'fiat', name: 'Canadian dollar' },
  { code: 'AUD', scale: 2, kind: 'fiat', name: 'Australian dollar' },
  { code: 'CHF', scale: 2, kind: 'fiat', name: 'Swiss franc' },
  { code: 'JPY', scale: 0, kind: 'fiat', name: 'Japanese yen' },
  { code: 'BTC', scale: 8, kind: 'crypto', name: 'Bitcoin' },
  { code: 'ETH', scale: 18, kind: 'crypto', name: 'Ether' },
  { code: 'SOL', scale: 9, kind: 'crypto', name: 'Solana' },
] satisfies Asset[]);

const Uuid = z.uuid();
const IsoDate = z.iso.date();
const IsoTimestamp = z.iso.datetime({ offset: true });
const ModuleId = z.string().regex(/^[a-z][a-z0-9-]*$/);

// ---------------------------------------------------------------------------------------------
// Books and accounts
// ---------------------------------------------------------------------------------------------

export const LEDGER_OWNER_MODULES = ['money', 'invest', 'studio', 'corporate'] as const;
export const LedgerOwnerModule = z.enum(LEDGER_OWNER_MODULES);
export type LedgerOwnerModule = z.infer<typeof LedgerOwnerModule>;

export const BookPurpose = z.enum(['business', 'fund', 'portfolio', 'production', 'entity']);
export type BookPurpose = z.infer<typeof BookPurpose>;

export const Book = z.object({
  id: Uuid,
  name: z.string(),
  environment: LedgerEnvironment,
  baseAsset: AssetCode,
  ownerModule: LedgerOwnerModule,
  purpose: BookPurpose,
  /** Optional domain record the book belongs to (a money business, invest fund, studio production…). */
  subjectId: Uuid.nullable(),
  createdAt: IsoTimestamp,
});
export type Book = z.infer<typeof Book>;

export const CreateBookInput = z.object({
  id: Uuid.optional(),
  name: z.string().trim().min(1).max(200),
  /** Required: a book's environment is fixed at creation and can never change. */
  environment: LedgerEnvironment,
  baseAsset: AssetCode,
  ownerModule: LedgerOwnerModule,
  purpose: BookPurpose,
  subjectId: Uuid.nullable().default(null),
});
export type CreateBookInput = z.input<typeof CreateBookInput>;

export const AccountType = z.enum(['asset', 'liability', 'equity', 'income', 'expense']);
export type AccountType = z.infer<typeof AccountType>;
/** Debit-normal types report positive balances as debits; credit-normal types flip the sign for display. */
export const DEBIT_NORMAL: ReadonlySet<AccountType> = new Set<AccountType>(['asset', 'expense']);

export const AccountCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, 'account code');

export const Account = z.object({
  id: Uuid,
  bookId: Uuid,
  environment: LedgerEnvironment,
  code: AccountCode,
  name: z.string(),
  type: AccountType,
  createdAt: IsoTimestamp,
});
export type Account = z.infer<typeof Account>;

export const CreateAccountInput = z.object({
  id: Uuid.optional(),
  bookId: Uuid,
  code: AccountCode,
  name: z.string().trim().min(1).max(200),
  type: AccountType,
});
export type CreateAccountInput = z.input<typeof CreateAccountInput>;

// ---------------------------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------------------------

export const EntryInput = z.object({
  accountId: Uuid,
  asset: AssetCode,
  /** Signed minor units at the asset's scale: positive debit, negative credit. */
  units: NonZeroMinorUnits,
  memo: z.string().max(500).optional(),
  /** Natural key from an import (bank line id, statement hash). Unique per account (ADR-0003 A1 §E). */
  externalRef: z.string().min(1).max(200).optional(),
});
export type EntryInput = z.input<typeof EntryInput>;

export const PostTransactionInput = z.object({
  /** Client-generated UUIDv7. Replaying the same id is idempotent and returns `exists`. */
  id: Uuid,
  bookId: Uuid,
  /** Required and must equal the book's environment. */
  environment: LedgerEnvironment,
  effectiveDate: IsoDate,
  description: z.string().trim().min(1).max(500),
  /** Module that produced the posting (money, invest, studio, corporate). */
  source: ModuleId,
  /** Groups related postings (an invoice and its payment, an order and its fills). */
  correlationId: Uuid.optional(),
  // The sync unit has one transaction row plus these entries (500-row wire limit).
  entries: z.array(EntryInput).min(2).max(499),
});
export type PostTransactionInput = z.input<typeof PostTransactionInput>;

export const ReverseTransactionInput = z.object({
  /** Id of the new reversing transaction (client-generated, idempotent). */
  id: Uuid,
  transactionId: Uuid,
  effectiveDate: IsoDate,
  reason: z.string().trim().min(1).max(500),
});
export type ReverseTransactionInput = z.input<typeof ReverseTransactionInput>;

export const PostStatus = z.enum(['posted', 'exists', 'duplicate']);
export type PostStatus = z.infer<typeof PostStatus>;
export const PostResult = z.object({
  /** `exists`: same transaction id replayed. `duplicate`: an external ref was already posted; see discrepancy. */
  status: PostStatus,
  transactionId: Uuid,
  discrepancyId: Uuid.nullable(),
});
export type PostResult = z.infer<typeof PostResult>;

export const Entry = z.object({
  id: Uuid,
  transactionId: Uuid,
  lineNo: z.int().min(1),
  accountId: Uuid,
  asset: AssetCode,
  units: MinorUnits,
  memo: z.string().nullable(),
  externalRef: z.string().nullable(),
});
export type Entry = z.infer<typeof Entry>;

export const Transaction = z.object({
  id: Uuid,
  bookId: Uuid,
  environment: LedgerEnvironment,
  effectiveDate: IsoDate,
  description: z.string(),
  source: ModuleId,
  correlationId: Uuid.nullable(),
  reversesId: Uuid.nullable(),
  reversedById: Uuid.nullable(),
  postedBy: Uuid,
  postedAt: IsoTimestamp,
  entries: z.array(Entry),
});
export type Transaction = z.infer<typeof Transaction>;

export const TransactionQuery = z.object({
  environment: LedgerEnvironment,
  bookId: Uuid.optional(),
  accountId: Uuid.optional(),
  correlationId: Uuid.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  limit: z.int().min(1).max(500).default(100),
  /** Opaque cursor from a previous page. */
  cursor: z.string().max(200).optional(),
});
export type TransactionQuery = z.input<typeof TransactionQuery>;
export const TransactionPage = z.object({ items: z.array(Transaction), nextCursor: z.string().nullable() });
export type TransactionPage = z.infer<typeof TransactionPage>;

// ---------------------------------------------------------------------------------------------
// Balances and aggregates (environment is always required)
// ---------------------------------------------------------------------------------------------

export const BalanceQuery = z.object({
  environment: LedgerEnvironment,
  bookId: Uuid.optional(),
  accountIds: z.array(Uuid).max(500).optional(),
  asset: AssetCode.optional(),
});
export type BalanceQuery = z.input<typeof BalanceQuery>;

export const Balance = z.object({
  bookId: Uuid,
  environment: LedgerEnvironment,
  accountId: Uuid,
  accountCode: AccountCode,
  accountName: z.string(),
  accountType: AccountType,
  asset: AssetCode,
  scale: z.int(),
  /** Signed units (debit positive). */
  units: MinorUnits,
  entryCount: z.int(),
});
export type Balance = z.infer<typeof Balance>;

export const TrialBalanceQuery = z.object({ environment: LedgerEnvironment, bookId: Uuid });
export type TrialBalanceQuery = z.input<typeof TrialBalanceQuery>;
export const TrialBalance = z.object({
  environment: LedgerEnvironment,
  bookId: Uuid,
  rows: z.array(
    z.object({
      accountId: Uuid,
      accountCode: AccountCode,
      accountName: z.string(),
      accountType: AccountType,
      asset: AssetCode,
      scale: z.int(),
      debit: MinorUnits,
      credit: MinorUnits,
    }),
  ),
  totals: z.array(
    z.object({
      asset: AssetCode,
      scale: z.int(),
      debit: MinorUnits,
      credit: MinorUnits,
      balanced: z.boolean(),
    }),
  ),
});
export type TrialBalance = z.infer<typeof TrialBalance>;

/** Consolidation input: totals per account type across books of ONE environment. */
export const TotalsQuery = z.object({
  environment: LedgerEnvironment,
  bookIds: z.array(Uuid).max(500).optional(),
  ownerModule: LedgerOwnerModule.optional(),
  asset: AssetCode,
});
export type TotalsQuery = z.input<typeof TotalsQuery>;
export const TypeTotals = z.object({
  environment: LedgerEnvironment,
  asset: AssetCode,
  scale: z.int(),
  /** Signed, debit positive, per account type. */
  byType: z.record(AccountType, MinorUnits),
  bookCount: z.int(),
});
export type TypeTotals = z.infer<typeof TypeTotals>;

// ---------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------

export const ReconcileInput = z.object({ environment: LedgerEnvironment, bookId: Uuid.optional() });
export type ReconcileInput = z.input<typeof ReconcileInput>;

export const ReconciliationRun = z.object({
  id: Uuid,
  environment: LedgerEnvironment,
  bookId: Uuid.nullable(),
  /** Deterministic key over (scope, environment, book, entry watermark): re-running on unchanged data reuses it. */
  runKey: z.string(),
  checkedBalances: z.int(),
  discrepancyCount: z.int(),
  status: z.enum(['clean', 'discrepancies']),
  startedAt: IsoTimestamp,
  /** True when an identical run already existed and nothing new was written. */
  reused: z.boolean(),
});
export type ReconciliationRun = z.infer<typeof ReconciliationRun>;

export const DiscrepancyKind = z.enum([
  'balance_mismatch',
  'missing_balance',
  'orphan_balance',
  'duplicate_import',
]);
export type DiscrepancyKind = z.infer<typeof DiscrepancyKind>;
export const DiscrepancyStatus = z.enum(['open', 'assigned', 'resolved']);
export type DiscrepancyStatus = z.infer<typeof DiscrepancyStatus>;

export const Discrepancy = z.object({
  id: Uuid,
  runId: Uuid.nullable(),
  kind: DiscrepancyKind,
  status: DiscrepancyStatus,
  ownerId: Uuid.nullable(),
  environment: LedgerEnvironment,
  bookId: Uuid,
  accountId: Uuid.nullable(),
  asset: AssetCode.nullable(),
  /** Units recomputed from entries (the truth). */
  expectedUnits: MinorUnits.nullable(),
  /** Units found in the balances projection or on the rejected import. */
  recordedUnits: MinorUnits.nullable(),
  externalRef: z.string().nullable(),
  detail: z.string(),
  resolution: z.string().nullable(),
  createdAt: IsoTimestamp,
  resolvedAt: IsoTimestamp.nullable(),
});
export type Discrepancy = z.infer<typeof Discrepancy>;

export const DiscrepancyQuery = z.object({
  environment: LedgerEnvironment,
  status: DiscrepancyStatus.optional(),
  bookId: Uuid.optional(),
});
export type DiscrepancyQuery = z.input<typeof DiscrepancyQuery>;

export const AssignDiscrepancyInput = z.object({ discrepancyId: Uuid, ownerId: Uuid });
export type AssignDiscrepancyInput = z.input<typeof AssignDiscrepancyInput>;
export const ResolveDiscrepancyInput = z.object({
  discrepancyId: Uuid,
  resolution: z.string().trim().min(1).max(1000),
  /** Rebuild the balances projection for the affected account from entries before resolving. */
  rebuildProjection: z.boolean().default(false),
});
export type ResolveDiscrepancyInput = z.input<typeof ResolveDiscrepancyInput>;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export const LEDGER_ERROR_CODES = [
  'UNBALANCED',
  'TOO_FEW_ENTRIES',
  'ENVIRONMENT_MISMATCH',
  'CROSS_ENVIRONMENT',
  'CROSS_BOOK',
  'LIVE_TRADING_DISABLED',
  'UNKNOWN_ASSET',
  'SCALE_CONFLICT',
  'UNITS_OUT_OF_RANGE',
  'ALREADY_REVERSED',
  'NOT_FOUND',
  'ENVIRONMENT_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
] as const;
export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

// ---------------------------------------------------------------------------------------------
// Engine API (implemented by LedgerStore; money/invest/studio/corporate server code depends on this)
// ---------------------------------------------------------------------------------------------

export interface LedgerScope {
  readonly tenantId: string;
  readonly workspaceId: string;
  /** Trusted local HLC applied to the same posting transaction and its balance watermark. */
  readonly hlc?: string;
}

export interface LedgerApi {
  /** Registers assets for the workspace (idempotent). A registered scale can never change. */
  ensureAssets(scope: LedgerScope, actorId: string, assets: readonly Asset[]): Promise<void>;
  assets(scope: LedgerScope): Promise<Asset[]>;
  createBook(scope: LedgerScope, actorId: string, input: CreateBookInput): Promise<Book>;
  books(
    scope: LedgerScope,
    filter?: { environment?: LedgerEnvironment; ownerModule?: LedgerOwnerModule },
  ): Promise<Book[]>;
  createAccount(scope: LedgerScope, actorId: string, input: CreateAccountInput): Promise<Account>;
  accounts(scope: LedgerScope, bookId: string): Promise<Account[]>;
  /** Engine check + one atomic database transaction; the deferred trigger re-checks balance at commit. */
  post(scope: LedgerScope, actorId: string, input: PostTransactionInput): Promise<PostResult>;
  /** Corrections are reversing transactions; a transaction can be reversed once. */
  reverse(scope: LedgerScope, actorId: string, input: ReverseTransactionInput): Promise<PostResult>;
  transactions(scope: LedgerScope, query: TransactionQuery): Promise<TransactionPage>;
  balances(scope: LedgerScope, query: BalanceQuery): Promise<Balance[]>;
  trialBalance(scope: LedgerScope, query: TrialBalanceQuery): Promise<TrialBalance>;
  totals(scope: LedgerScope, query: TotalsQuery): Promise<TypeTotals>;
  /** Idempotent: recomputes balances from entries and records differences as discrepancies. */
  reconcile(scope: LedgerScope, actorId: string, input: ReconcileInput): Promise<ReconciliationRun>;
  discrepancies(scope: LedgerScope, query: DiscrepancyQuery): Promise<Discrepancy[]>;
  assignDiscrepancy(scope: LedgerScope, actorId: string, input: AssignDiscrepancyInput): Promise<Discrepancy>;
  resolveDiscrepancy(
    scope: LedgerScope,
    actorId: string,
    input: ResolveDiscrepancyInput,
  ): Promise<Discrepancy>;
}

// ---------------------------------------------------------------------------------------------
// Table declarations (ADR-0006 A1). The money module manifest includes these verbatim; its
// migrations create them. Other modules use LedgerApi / capabilities for operations and may declare
// scoped SQL foreign keys to the keys in LEDGER_REFERENCE_KEYS, with dependsOn: ['money'].
// ---------------------------------------------------------------------------------------------

type TableDeclInput = NonNullable<ModuleManifestInput['tables']>[number];

/** Scoped targets for dependent modules. Never reference a bare id without tenant/workspace. */
export const LEDGER_REFERENCE_KEYS = Object.freeze({
  ledger_assets: ['tenant_id', 'workspace_id', 'code'],
  ledger_books: ['tenant_id', 'workspace_id', 'id'],
  ledger_accounts: ['tenant_id', 'workspace_id', 'id'],
  ledger_transactions: ['tenant_id', 'workspace_id', 'id'],
  ledger_entries: ['tenant_id', 'workspace_id', 'id'],
} as const);

const unitsColumn = {
  type: 'numeric',
  scale: 0,
  min: '-99999999999999999999999999999999999999',
  max: '99999999999999999999999999999999999999',
} as const;

export const LEDGER_TABLES: readonly TableDeclInput[] = Object.freeze([
  {
    // Assets are immutable once registered: a scale never changes under existing entries.
    name: 'ledger_assets',
    class: 'append',
    authority: 'append',
    actorField: 'created_by',
    receivedAtField: 'created_at',
    readPermission: 'money:ledger:read',
    writePermission: 'money:ledger:admin',
    allowedFields: ['code', 'scale', 'kind', 'name'],
    columns: {
      code: { type: 'text', requiredOnInsert: true, minLength: 1, maxLength: 32 },
      scale: { type: 'integer', requiredOnInsert: true, min: '0', max: '18' },
      kind: { type: 'text', requiredOnInsert: true, enum: ['fiat', 'crypto', 'security', 'unit'] },
      name: { type: 'text', requiredOnInsert: true, minLength: 1, maxLength: 120 },
      created_by: { type: 'uuid', requiredOnInsert: true },
      created_at: { type: 'timestamptz' },
    },
  },
  {
    name: 'ledger_books',
    class: 'lww',
    authority: 'synced',
    guardedColumns: ['environment', 'owner_module', 'base_asset'],
    actorField: 'created_by',
    receivedAtField: 'created_at',
    readPermission: 'money:ledger:read',
    writePermission: 'money:ledger:admin',
    allowedFields: ['name', 'purpose', 'subject_id'],
    columns: {
      name: { type: 'text', requiredOnInsert: true, minLength: 1, maxLength: 200 },
      environment: { type: 'text', requiredOnInsert: true, enum: [...LEDGER_ENVIRONMENTS] },
      base_asset: { type: 'text', requiredOnInsert: true, minLength: 1, maxLength: 32 },
      owner_module: { type: 'text', requiredOnInsert: true, enum: [...LEDGER_OWNER_MODULES] },
      purpose: {
        type: 'text',
        requiredOnInsert: true,
        enum: ['business', 'fund', 'portfolio', 'production', 'entity'],
      },
      subject_id: { type: 'uuid', nullable: true },
      created_by: { type: 'uuid', requiredOnInsert: true },
      created_at: { type: 'timestamptz' },
    },
  },
  {
    name: 'ledger_accounts',
    class: 'lww',
    authority: 'synced',
    guardedColumns: ['book_id', 'environment', 'type'],
    actorField: 'created_by',
    receivedAtField: 'created_at',
    readPermission: 'money:ledger:read',
    writePermission: 'money:ledger:admin',
    allowedFields: ['code', 'name'],
    columns: {
      book_id: { type: 'uuid', requiredOnInsert: true, references: { table: 'ledger_books' } },
      environment: { type: 'text', requiredOnInsert: true, enum: [...LEDGER_ENVIRONMENTS] },
      type: {
        type: 'text',
        requiredOnInsert: true,
        enum: ['asset', 'liability', 'equity', 'income', 'expense'],
      },
      code: { type: 'text', requiredOnInsert: true, minLength: 1, maxLength: 64 },
      name: { type: 'text', requiredOnInsert: true, minLength: 1, maxLength: 200 },
      created_by: { type: 'uuid', requiredOnInsert: true },
      created_at: { type: 'timestamptz' },
    },
  },
  {
    // One transaction and all its entries form one atomic sync unit (LEDGER_SYNC_UNITS).
    name: 'ledger_transactions',
    class: 'append',
    authority: 'append',
    actorField: 'posted_by',
    receivedAtField: 'posted_at',
    readPermission: 'money:ledger:read',
    writePermission: 'money:ledger:post',
    allowedFields: [
      'book_id',
      'environment',
      'effective_date',
      'description',
      'source',
      'correlation_id',
      'reverses_id',
    ],
    columns: {
      book_id: { type: 'uuid', requiredOnInsert: true, references: { table: 'ledger_books' } },
      environment: { type: 'text', requiredOnInsert: true, enum: [...LEDGER_ENVIRONMENTS] },
      effective_date: { type: 'date', requiredOnInsert: true },
      description: { type: 'text', requiredOnInsert: true, minLength: 1, maxLength: 500 },
      source: { type: 'text', requiredOnInsert: true },
      correlation_id: { type: 'uuid', nullable: true },
      reverses_id: { type: 'uuid', nullable: true, references: { table: 'ledger_transactions' } },
      posted_by: { type: 'uuid', requiredOnInsert: true },
      posted_at: { type: 'timestamptz' },
    },
  },
  {
    name: 'ledger_entries',
    class: 'append',
    authority: 'append',
    actorField: 'created_by',
    receivedAtField: 'created_at',
    readPermission: 'money:ledger:read',
    writePermission: 'money:ledger:post',
    allowedFields: [
      'transaction_id',
      'line_no',
      'book_id',
      'environment',
      'account_id',
      'asset',
      'units',
      'memo',
      'external_ref',
    ],
    columns: {
      transaction_id: { type: 'uuid', requiredOnInsert: true, references: { table: 'ledger_transactions' } },
      line_no: { type: 'integer', requiredOnInsert: true, min: '1', max: '499' },
      book_id: { type: 'uuid', requiredOnInsert: true, references: { table: 'ledger_books' } },
      environment: { type: 'text', requiredOnInsert: true, enum: [...LEDGER_ENVIRONMENTS] },
      account_id: { type: 'uuid', requiredOnInsert: true, references: { table: 'ledger_accounts' } },
      asset: { type: 'text', requiredOnInsert: true, minLength: 1, maxLength: 32 },
      units: { ...unitsColumn, requiredOnInsert: true },
      memo: { type: 'text', nullable: true, maxLength: 500 },
      external_ref: { type: 'text', nullable: true, minLength: 1, maxLength: 200 },
      created_by: { type: 'uuid', requiredOnInsert: true },
      created_at: { type: 'timestamptz' },
    },
  },
  // Projection maintained in the posting transaction on every store; never synced (recomputed per side).
  { name: 'ledger_balances', class: 'local', authority: 'local', readPermission: 'money:ledger:read' },
  {
    name: 'ledger_reconciliation_runs',
    class: 'append',
    authority: 'server',
    readPermission: 'money:ledger:read',
  },
  {
    name: 'ledger_discrepancies',
    class: 'lww',
    authority: 'server',
    guardedColumns: ['status', 'owner_id'],
    readPermission: 'money:ledger:read',
  },
] satisfies TableDeclInput[]);

/** ADR-0003 A1 §E: a transaction row and its entries are pushed and applied as one unit. */
export const LEDGER_SYNC_UNITS = Object.freeze([
  { root: 'ledger_transactions', members: [{ table: 'ledger_entries', foreignKey: 'transaction_id' }] },
] as const);

/** Natural keys the sync layer deduplicates on; a duplicate becomes a discrepancy, never a second posting. */
export const LEDGER_NATURAL_KEYS = Object.freeze([
  { table: 'ledger_entries', columns: ['account_id', 'external_ref'] },
] as const);

// ---------------------------------------------------------------------------------------------
// Capabilities (hosted by the money module; ids and permissions are therefore `money.*`)
// ---------------------------------------------------------------------------------------------

export const LEDGER_PERMISSIONS = [
  'money:ledger:read',
  'money:ledger:post',
  'money:ledger:admin',
  'money:ledger:reconcile',
] as const;

export const ledgerCapabilities = {
  ensureAssets: defineCapability({
    id: 'money.ledger.ensure-assets',
    title: 'Register ledger assets',
    description: 'Register workspace assets and their immutable decimal scales',
    kind: 'write',
    permission: 'money:ledger:admin',
    input: z.object({ assets: z.array(Asset).min(1).max(100) }),
    output: z.void(),
  }),
  assets: defineCapability({
    id: 'money.ledger.assets',
    title: 'Ledger assets',
    description: 'List the assets and scales registered in this workspace',
    kind: 'read',
    permission: 'money:ledger:read',
    input: z.object({}),
    output: z.array(Asset),
  }),
  books: defineCapability({
    id: 'money.ledger.books',
    title: 'Ledger books',
    description: 'List books, optionally filtered by environment or owning module',
    kind: 'read',
    permission: 'money:ledger:read',
    input: z.object({ environment: LedgerEnvironment.optional(), ownerModule: LedgerOwnerModule.optional() }),
    output: z.array(Book),
  }),
  createBook: defineCapability({
    id: 'money.ledger.create-book',
    title: 'Create book',
    description: 'Create a ledger book in a fixed environment',
    kind: 'write',
    permission: 'money:ledger:admin',
    input: CreateBookInput,
    output: Book,
  }),
  accounts: defineCapability({
    id: 'money.ledger.accounts',
    title: 'Ledger accounts',
    description: 'List the chart of accounts of one book',
    kind: 'read',
    permission: 'money:ledger:read',
    input: z.object({ bookId: Uuid }),
    output: z.array(Account),
  }),
  createAccount: defineCapability({
    id: 'money.ledger.create-account',
    title: 'Create account',
    description: 'Add an account to a book',
    kind: 'write',
    permission: 'money:ledger:admin',
    input: CreateAccountInput,
    output: Account,
  }),
  post: defineCapability({
    id: 'money.ledger.post',
    title: 'Post transaction',
    description: 'Post a balanced double-entry transaction to one book',
    kind: 'write',
    permission: 'money:ledger:post',
    input: PostTransactionInput,
    output: PostResult,
    emits: ['money.transaction.posted'],
  }),
  reverse: defineCapability({
    id: 'money.ledger.reverse',
    title: 'Reverse transaction',
    description: 'Correct a posting with a reversing transaction',
    kind: 'write',
    permission: 'money:ledger:post',
    input: ReverseTransactionInput,
    output: PostResult,
    emits: ['money.transaction.posted'],
  }),
  transactions: defineCapability({
    id: 'money.ledger.transactions',
    title: 'Ledger transactions',
    description: 'Explore postings of one environment',
    kind: 'read',
    permission: 'money:ledger:read',
    input: TransactionQuery,
    output: TransactionPage,
  }),
  balances: defineCapability({
    id: 'money.ledger.balances',
    title: 'Ledger balances',
    description: 'Account balances of one environment',
    kind: 'read',
    permission: 'money:ledger:read',
    input: BalanceQuery,
    output: z.array(Balance),
  }),
  trialBalance: defineCapability({
    id: 'money.ledger.trial-balance',
    title: 'Trial balance',
    description: 'Debits and credits per account and asset for one book',
    kind: 'read',
    permission: 'money:ledger:read',
    input: TrialBalanceQuery,
    output: TrialBalance,
  }),
  totals: defineCapability({
    id: 'money.ledger.totals',
    title: 'Ledger totals',
    description: 'Totals per account type across books of one environment',
    kind: 'read',
    permission: 'money:ledger:read',
    input: TotalsQuery,
    output: TypeTotals,
  }),
  reconcile: defineCapability({
    id: 'money.ledger.reconcile',
    title: 'Reconcile ledger',
    description: 'Recompute balances from entries and record discrepancies',
    kind: 'write',
    permission: 'money:ledger:reconcile',
    input: ReconcileInput,
    output: ReconciliationRun,
    agentCallable: true,
  }),
  discrepancies: defineCapability({
    id: 'money.ledger.discrepancies',
    title: 'Discrepancies',
    description: 'The reconciliation discrepancy queue',
    kind: 'read',
    permission: 'money:ledger:read',
    input: DiscrepancyQuery,
    output: z.array(Discrepancy),
  }),
  assignDiscrepancy: defineCapability({
    id: 'money.ledger.assign-discrepancy',
    title: 'Assign discrepancy',
    description: 'Give a discrepancy an owner',
    kind: 'write',
    permission: 'money:ledger:reconcile',
    input: AssignDiscrepancyInput,
    output: Discrepancy,
  }),
  resolveDiscrepancy: defineCapability({
    id: 'money.ledger.resolve-discrepancy',
    title: 'Resolve discrepancy',
    description: 'Close a discrepancy with a written resolution',
    kind: 'write',
    permission: 'money:ledger:reconcile',
    input: ResolveDiscrepancyInput,
    output: Discrepancy,
  }),
} as const;

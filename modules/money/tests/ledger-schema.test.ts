import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyPGliteMigrations, migration, prepareLocalAppRole } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { randomUUID } from 'node:crypto';
import { PGliteLedgerWriter } from '@xyra/ledger';
import moneyManifest from '../manifest';

function loadMigrations(directory: URL, module: string) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) =>
      migration(`${module}/${name.slice(0, -4)}`, readFileSync(new URL(name, directory), 'utf8')),
    );
}

const TA = '019a0000-0000-7000-8000-000000000001';
const TB = '019a0000-0000-7000-8000-000000000002';
const WA = '019a0000-0000-7000-8000-000000000011';
const WB = '019a0000-0000-7000-8000-000000000012';
const ACTOR_A = '019a0000-0000-7000-8000-000000000021';
const ACTOR_B = '019a0000-0000-7000-8000-000000000022';
const ASSET_A = '019a0000-0000-7000-8000-000000000031';
const ASSET_B = '019a0000-0000-7000-8000-000000000032';
const BOOK_A = '019a0000-0000-7000-8000-000000000041';
const BOOK_B = '019a0000-0000-7000-8000-000000000042';
const ACCT_A1 = '019a0000-0000-7000-8000-000000000051';
const ACCT_A2 = '019a0000-0000-7000-8000-000000000052';
const ACCT_B = '019a0000-0000-7000-8000-000000000053';
const TX_A = '019a0000-0000-7000-8000-000000000061';
const TX_B = '019a0000-0000-7000-8000-000000000062';
const ENTRY_A1 = '019a0000-0000-7000-8000-000000000071';
const ENTRY_A2 = '019a0000-0000-7000-8000-000000000072';
const ENTRY_B1 = '019a0000-0000-7000-8000-000000000073';
const ENTRY_B2 = '019a0000-0000-7000-8000-000000000074';

let db: PGlite;

beforeAll(async () => {
  db = await openLocalStore();
  const platform = loadMigrations(new URL('../../../packages/db/migrations/', import.meta.url), 'platform');
  const money = loadMigrations(new URL('../migrations/', import.meta.url), 'money');
  await applyPGliteMigrations(db, [...platform, ...money]);
  await prepareLocalAppRole(db, moneyManifest.tables);
  await db.transaction(async (tx) =>
    tx.exec(`
    INSERT INTO tenants(id, name) VALUES ('${TA}', 'A'), ('${TB}', 'B');
    INSERT INTO workspaces(id, tenant_id, name) VALUES ('${WA}', '${TA}', 'A'), ('${WB}', '${TB}', 'B');
    INSERT INTO users(id, tenant_id, display_name) VALUES
      ('${ACTOR_A}', '${TA}', 'A'), ('${ACTOR_B}', '${TB}', 'B');
    INSERT INTO ledger_assets(id, tenant_id, workspace_id, code, scale, kind, name, created_by)
      VALUES ('${ASSET_A}', '${TA}', '${WA}', 'USD', 2, 'fiat', 'US dollar', '${ACTOR_A}'),
             ('${ASSET_B}', '${TB}', '${WB}', 'USD', 2, 'fiat', 'US dollar', '${ACTOR_B}');
    INSERT INTO ledger_books(id, tenant_id, workspace_id, name, environment, base_asset, owner_module, purpose, created_by)
      VALUES ('${BOOK_A}', '${TA}', '${WA}', 'A book', 'actual', 'USD', 'money', 'business', '${ACTOR_A}'),
             ('${BOOK_B}', '${TB}', '${WB}', 'B book', 'actual', 'USD', 'money', 'business', '${ACTOR_B}');
    INSERT INTO ledger_accounts(id, tenant_id, workspace_id, book_id, environment, code, name, type, created_by)
      VALUES ('${ACCT_A1}', '${TA}', '${WA}', '${BOOK_A}', 'actual', 'cash', 'Cash', 'asset', '${ACTOR_A}'),
             ('${ACCT_A2}', '${TA}', '${WA}', '${BOOK_A}', 'actual', 'equity', 'Equity', 'equity', '${ACTOR_A}'),
             ('${ACCT_B}', '${TB}', '${WB}', '${BOOK_B}', 'actual', 'cash', 'Cash', 'asset', '${ACTOR_B}');
    INSERT INTO ledger_transactions(id, tenant_id, workspace_id, book_id, environment, effective_date, description, source, posted_by)
      VALUES ('${TX_A}', '${TA}', '${WA}', '${BOOK_A}', 'actual', '2026-09-30', 'A posting', 'money', '${ACTOR_A}'),
             ('${TX_B}', '${TB}', '${WB}', '${BOOK_B}', 'actual', '2026-09-30', 'B posting', 'money', '${ACTOR_B}');
    INSERT INTO ledger_entries(id, tenant_id, workspace_id, transaction_id, line_no, book_id, environment, account_id, asset, units, created_by)
      VALUES ('${ENTRY_A1}', '${TA}', '${WA}', '${TX_A}', 1, '${BOOK_A}', 'actual', '${ACCT_A1}', 'USD', 100, '${ACTOR_A}'),
             ('${ENTRY_A2}', '${TA}', '${WA}', '${TX_A}', 2, '${BOOK_A}', 'actual', '${ACCT_A2}', 'USD', -100, '${ACTOR_A}'),
             ('${ENTRY_B1}', '${TB}', '${WB}', '${TX_B}', 1, '${BOOK_B}', 'actual', '${ACCT_B}', 'USD', 200, '${ACTOR_B}'),
             ('${ENTRY_B2}', '${TB}', '${WB}', '${TX_B}', 2, '${BOOK_B}', 'actual', '${ACCT_B}', 'USD', -200, '${ACTOR_B}');
  `),
  );
}, 60_000);

afterAll(async () => {
  await db?.close();
});

test('fresh ordered migrations match every declared ledger sync column and FK', async () => {
  for (const table of moneyManifest.tables) {
    if (!table.columns) continue;
    const { rows } = await db.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
      [table.name],
    );
    const columns = new Map(rows.map((row) => [row.column_name, row]));
    for (const [columnName, spec] of Object.entries(table.columns)) {
      const column = columns.get(columnName);
      expect(column, `${table.name}.${columnName} exists`).toBeDefined();
      if (!column) continue;
      const type = column.data_type === 'timestamp with time zone' ? 'timestamptz' : column.data_type;
      expect(type, `${table.name}.${columnName} type`).toBe(spec.type);
      expect(column.is_nullable === 'YES', `${table.name}.${columnName} nullability`).toBe(spec.nullable);
      expect(
        column.is_nullable === 'NO' && column.column_default === null,
        `${table.name}.${columnName} requiredOnInsert`,
      ).toBe(spec.requiredOnInsert);
      if (spec.references) {
        const fk = await db.query(
          `SELECT 1 FROM information_schema.key_column_usage k
           JOIN information_schema.referential_constraints r
             ON r.constraint_name=k.constraint_name AND r.constraint_schema=k.constraint_schema
           JOIN information_schema.table_constraints t
             ON t.constraint_name=r.unique_constraint_name AND t.constraint_schema=r.unique_constraint_schema
           WHERE k.table_name=$1 AND k.column_name=$2 AND t.table_name=$3`,
          [table.name, columnName, spec.references.table],
        );
        expect(
          fk.rows.length,
          `${table.name}.${columnName} has FK to ${spec.references.table}`,
        ).toBeGreaterThan(0);
      }
    }
  }
});

test('deferred database checks reject unbalanced transactions atomically', async () => {
  const unbalancedId = '019a0000-0000-7000-8000-000000000081';
  await expect(
    db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO ledger_transactions(id,tenant_id,workspace_id,book_id,environment,effective_date,description,source,posted_by)
         VALUES ($1,$2,$3,$4,'actual','2026-09-30','Unbalanced','money',$5)`,
        [unbalancedId, TA, WA, BOOK_A, ACTOR_A],
      );
      await tx.query(
        `INSERT INTO ledger_entries(id,tenant_id,workspace_id,transaction_id,line_no,book_id,environment,account_id,asset,units,created_by)
         VALUES ($1,$2,$3,$4,1,$5,'actual',$6,'USD',100,$7), ($8,$2,$3,$4,2,$5,'actual',$9,'USD',-99,$7)`,
        [
          '019a0000-0000-7000-8000-000000000082',
          TA,
          WA,
          unbalancedId,
          BOOK_A,
          ACCT_A1,
          ACTOR_A,
          '019a0000-0000-7000-8000-000000000083',
          ACCT_A2,
        ],
      );
    }),
  ).rejects.toThrow(/UNBALANCED/);
  const absent = await db.query('SELECT 1 FROM ledger_transactions WHERE id=$1', [unbalancedId]);
  expect(absent.rows).toHaveLength(0);
});

test('live execution is disabled and immutable entries require reversing rows', async () => {
  const liveId = '019a0000-0000-7000-8000-000000000091';
  await expect(
    db.query(
      `INSERT INTO ledger_transactions(id,tenant_id,workspace_id,book_id,environment,effective_date,description,source,posted_by)
       VALUES ($1,$2,$3,$4,'live','2026-09-30','Live','invest',$5)`,
      [liveId, TA, WA, BOOK_A, ACTOR_A],
    ),
  ).rejects.toThrow(/LIVE_TRADING_DISABLED/);
  await expect(db.query("UPDATE ledger_entries SET memo='rewrite' WHERE id=$1", [ENTRY_A1])).rejects.toThrow(
    /append-only/,
  );
});

test('composite constraints reject cross-scope parents and cross-environment account entries', async () => {
  const foreignBookAccount = '019a0000-0000-7000-8000-000000000101';
  await expect(
    db.query(
      `INSERT INTO ledger_accounts(id,tenant_id,workspace_id,book_id,environment,code,name,type,created_by)
       VALUES ($1,$2,$3,$4,'actual','foreign','Foreign','asset',$5)`,
      [foreignBookAccount, TA, WA, BOOK_B, ACTOR_A],
    ),
  ).rejects.toThrow(/foreign key/i);

  const paperId = '019a0000-0000-7000-8000-000000000102';
  await expect(
    db.query(
      `INSERT INTO ledger_transactions(id,tenant_id,workspace_id,book_id,environment,effective_date,description,source,posted_by)
       VALUES ($1,$2,$3,$4,'paper','2026-09-30','Wrong environment','invest',$5)`,
      [paperId, TA, WA, BOOK_A, ACTOR_A],
    ),
  ).rejects.toThrow(/foreign key/i);
});

test('the app role has no DELETE grant and RLS hides every other tenant ledger row', async () => {
  const tables = moneyManifest.tables;
  for (const table of tables) {
    const grant = await db.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('xyra_app', $1, 'DELETE') AS allowed",
      [table.name],
    );
    expect(grant.rows[0]?.allowed, `${table.name} DELETE`).toBe(false);
  }

  await db.exec('SET ROLE xyra_app');
  try {
    await db.query("SELECT set_config('app.tenant_id',$1,false)", [TA]);
    await db.query("SELECT set_config('app.workspace_id',$1,false)", [WA]);
    for (const table of tables) {
      const { rows } = await db.query<Record<string, unknown>>(`SELECT * FROM "${table.name}"`);
      expect(
        rows.every((row) => row['tenant_id'] === TA),
        table.name,
      ).toBe(true);
    }
    const balances = await db.query<{ units: string; entry_count: number }>(
      `SELECT units::text, entry_count FROM ledger_balances WHERE book_id=$1 AND account_id=$2 AND asset='USD'`,
      [BOOK_A, ACCT_A1],
    );
    expect(balances.rows).toEqual([{ units: '100', entry_count: 1 }]);
  } finally {
    await db.exec('RESET ROLE');
  }
});

test('the ledger writer commits balanced postings, advances HLC balances and reverses append-only', async () => {
  const writer = new PGliteLedgerWriter(db);
  const scope = { tenantId: TA, workspaceId: WA, hlc: '1790800000000-0001-devicea' };
  const book = await writer.createBook(scope, ACTOR_A, {
    name: 'Writer book',
    environment: 'paper',
    baseAsset: 'USD',
    ownerModule: 'invest',
    purpose: 'portfolio',
  });
  const cash = await writer.createAccount(scope, ACTOR_A, {
    bookId: book.id,
    code: 'cash',
    name: 'Cash',
    type: 'asset',
  });
  const equity = await writer.createAccount(scope, ACTOR_A, {
    bookId: book.id,
    code: 'equity',
    name: 'Equity',
    type: 'equity',
  });
  const id = randomUUID();
  const posting = {
    id,
    bookId: book.id,
    environment: 'paper' as const,
    effectiveDate: '2026-09-30',
    description: 'Opening contribution',
    source: 'invest',
    entries: [
      { accountId: cash.id, asset: 'USD', units: '2500', externalRef: 'bank-line-001' },
      { accountId: equity.id, asset: 'USD', units: '-2500' },
    ],
  };
  expect((await writer.post(scope, ACTOR_A, posting)).status).toBe('posted');
  expect((await writer.post(scope, ACTOR_A, posting)).status).toBe('exists');
  await expect(
    writer.post(scope, ACTOR_A, { ...posting, description: 'Conflicting replay' }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const beforeReverse = await writer.balances(scope, { environment: 'paper', bookId: book.id });
  expect(beforeReverse.find((row) => row.accountId === cash.id)?.units).toBe('2500');
  const projection = await db.query<{ as_of_hlc: string }>(
    'SELECT as_of_hlc FROM ledger_balances WHERE tenant_id=$1 AND workspace_id=$2 AND account_id=$3 AND asset=$4',
    [TA, WA, cash.id, 'USD'],
  );
  expect(projection.rows[0]?.as_of_hlc).toBe(scope.hlc);

  const reversalId = randomUUID();
  const reversed = await writer.reverse(scope, ACTOR_A, {
    id: reversalId,
    transactionId: id,
    effectiveDate: '2026-09-30',
    reason: 'Incorrect opening amount',
  });
  expect(reversed.status).toBe('posted');
  expect(
    (await writer.balances(scope, { environment: 'paper', bookId: book.id })).find(
      (row) => row.accountId === cash.id,
    )?.units,
  ).toBe('0');
  const original = await db.query<{ reverses_id: string | null }>(
    'SELECT reverses_id FROM ledger_transactions WHERE id=$1',
    [reversalId],
  );
  expect(original.rows[0]?.reverses_id).toBe(id);
  await expect(
    db.query("UPDATE ledger_entries SET memo='rewrite' WHERE transaction_id=$1", [id]),
  ).rejects.toThrow(/append-only/);
  await expect(
    writer.reverse(scope, ACTOR_A, {
      id: randomUUID(),
      transactionId: id,
      effectiveDate: '2026-09-30',
      reason: 'Second reversal',
    }),
  ).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });

  const duplicate = await writer.post(scope, ACTOR_A, {
    ...posting,
    id: randomUUID(),
    description: 'Repeated imported line',
    entries: [
      { accountId: cash.id, asset: 'USD', units: '100', externalRef: 'bank-line-001' },
      { accountId: equity.id, asset: 'USD', units: '-100' },
    ],
  });
  expect(duplicate.status).toBe('duplicate');
  expect(duplicate.discrepancyId).toBeTruthy();
  const absent = await db.query('SELECT 1 FROM ledger_transactions WHERE id=$1', [duplicate.transactionId]);
  expect(absent.rows).toHaveLength(0);
});

test('posting rejects live environments and per-asset imbalance before database writes', async () => {
  const writer = new PGliteLedgerWriter(db);
  const scope = { tenantId: TA, workspaceId: WA };
  const common = {
    id: randomUUID(),
    bookId: BOOK_A,
    effectiveDate: '2026-09-30',
    description: 'Invalid',
    source: 'money',
    entries: [
      { accountId: ACCT_A1, asset: 'USD', units: '100' },
      { accountId: ACCT_A2, asset: 'USD', units: '-99' },
    ],
  };
  await expect(writer.post(scope, ACTOR_A, { ...common, environment: 'actual' })).rejects.toMatchObject({
    code: 'UNBALANCED',
  });
  await expect(
    writer.post(scope, ACTOR_A, { ...common, id: randomUUID(), environment: 'live' }),
  ).rejects.toMatchObject({ code: 'LIVE_TRADING_DISABLED' });
});

test('ledger query, aggregate, reconciliation, and discrepancy APIs return contract shapes', async () => {
  const writer = new PGliteLedgerWriter(db);
  const scope = { tenantId: TA, workspaceId: WA, hlc: '1790800001000-0001-devicea' };
  await writer.post(scope, ACTOR_A, {
    id: randomUUID(), bookId: BOOK_A, environment: 'actual', effectiveDate: '2026-09-30',
    description: 'Second fixture posting', source: 'money',
    entries: [{ accountId: ACCT_A1, asset: 'USD', units: '1' }, { accountId: ACCT_A2, asset: 'USD', units: '-1' }],
  });
  const page1 = await writer.transactions(scope, { environment: 'actual', bookId: BOOK_A, limit: 1 });
  expect(page1.items).toHaveLength(1);
  expect(page1.items[0]?.entries).toHaveLength(2);
  expect(page1.nextCursor).toBeTruthy();
  const page2 = await writer.transactions(scope, { environment: 'actual', bookId: BOOK_A, limit: 1, cursor: page1.nextCursor! });
  expect(page2.items).toHaveLength(1);
  expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
  expect(page2.nextCursor).toBeNull();

  const trial = await writer.trialBalance(scope, { environment: 'actual', bookId: BOOK_A });
  expect(trial.rows.map((row) => row.debit)).toEqual(['101', '0']);
  expect(trial.totals).toEqual([{ asset: 'USD', scale: 2, debit: '101', credit: '101', balanced: true }]);
  const totals = await writer.totals(scope, { environment: 'actual', asset: 'USD' });
  expect(totals.byType).toMatchObject({ asset: '101', equity: '-101' });

  const run = await writer.reconcile(scope, ACTOR_A, { environment: 'actual', bookId: BOOK_A });
  expect(run.status).toBe('clean');
  expect(run.discrepancyCount).toBe(0);
  const repeated = await writer.reconcile(scope, ACTOR_A, { environment: 'actual', bookId: BOOK_A });
  expect(repeated.id).toBe(run.id);
  expect(repeated.reused).toBe(true);

  const paperBook = await writer.createBook(scope, ACTOR_A, {
    name: 'Discrepancy test', environment: 'paper', baseAsset: 'USD', ownerModule: 'money', purpose: 'business',
  });
  const cash = await writer.createAccount(scope, ACTOR_A, { bookId: paperBook.id, code: 'cash', name: 'Cash', type: 'asset' });
  const equity = await writer.createAccount(scope, ACTOR_A, { bookId: paperBook.id, code: 'equity', name: 'Equity', type: 'equity' });
  const firstId = randomUUID();
  const importPosting = {
    id: firstId, bookId: paperBook.id, environment: 'paper' as const, effectiveDate: '2026-09-30',
    description: 'Imported line', source: 'money',
    entries: [{ accountId: cash.id, asset: 'USD', units: '10', externalRef: 'discrepancy-ref' },
      { accountId: equity.id, asset: 'USD', units: '-10' }],
  };
  await writer.post(scope, ACTOR_A, importPosting);
  const duplicate = await writer.post(scope, ACTOR_A, { ...importPosting, id: randomUUID() });
  expect(duplicate.status).toBe('duplicate');
  const open = await writer.discrepancies(scope, { environment: 'paper', status: 'open', bookId: paperBook.id });
  expect(open).toHaveLength(1);
  const assigned = await writer.assignDiscrepancy(scope, ACTOR_A, { discrepancyId: open[0]!.id, ownerId: ACTOR_A });
  expect(assigned.status).toBe('assigned');
  const resolved = await writer.resolveDiscrepancy(scope, ACTOR_A, {
    discrepancyId: open[0]!.id, resolution: 'Verified duplicate import',
  });
  expect(resolved.status).toBe('resolved');
  expect((await writer.discrepancies(scope, { environment: 'paper', status: 'resolved' }))).toHaveLength(1);
});

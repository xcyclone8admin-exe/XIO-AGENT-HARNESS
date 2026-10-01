import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyPGliteMigrations, migration, prepareLocalAppRole } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { LEDGER_TABLES } from './contracts';
import { PGliteLedgerWriter } from './writer';

const TENANT_A = '019a0000-0000-7000-8000-000000000001';
const TENANT_B = '019a0000-0000-7000-8000-000000000002';
const WORKSPACE_A = '019a0000-0000-7000-8000-000000000011';
const WORKSPACE_B = '019a0000-0000-7000-8000-000000000012';
const ACTOR_A = '019a0000-0000-7000-8000-000000000021';
const ACTOR_B = '019a0000-0000-7000-8000-000000000022';
const BOOK_ID = '019a0000-0000-7000-8000-000000000031';
let db: PGlite;
let writer: PGliteLedgerWriter;
let cashAccountId: string;
let securityAccountId: string;

function migrations(directory: URL, prefix: string) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) =>
      migration(`${prefix}/${name.slice(0, -4)}`, readFileSync(new URL(name, directory), 'utf8')),
    );
}

const scopedFillTable = `
  CREATE TABLE invest_fills (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    fill_key text NOT NULL,
    UNIQUE (tenant_id, workspace_id, fill_key),
    FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id,id)
  );
  ALTER TABLE invest_fills ENABLE ROW LEVEL SECURITY;
  ALTER TABLE invest_fills FORCE ROW LEVEL SECURITY;
  CREATE POLICY invest_fills_scope ON invest_fills
    USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
       AND workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
       AND workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
`;

beforeAll(async () => {
  db = await openLocalStore();
  const platform = migrations(new URL('../../db/migrations/', import.meta.url), 'platform');
  const ledger = migrations(new URL('../../../modules/money/migrations/', import.meta.url), 'money');
  await applyPGliteMigrations(db, [...platform, ...ledger]);
  await db.exec(scopedFillTable);
  await prepareLocalAppRole(db, [
    ...LEDGER_TABLES.map((table) => ({
      name: table.name,
      class: table.class,
      serverWriteCapabilities: table.serverWriteCapabilities ?? [],
      serverReadCapabilities: table.serverReadCapabilities ?? [],
      serverInsertCapabilities: table.serverInsertCapabilities ?? [],
    })),
    {
      name: 'invest_fills',
      class: 'append',
      authority: 'append',
      serverWriteCapabilities: ['invest_paper_execution'],
    },
  ]);
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2),($3,$4)', [TENANT_A, 'A', TENANT_B, 'B']);
  await db.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3),($4,$5,$6)', [
    WORKSPACE_A,
    TENANT_A,
    'A',
    WORKSPACE_B,
    TENANT_B,
    'B',
  ]);
  await db.query('INSERT INTO users(id,tenant_id,display_name) VALUES ($1,$2,$3),($4,$5,$6)', [
    ACTOR_A,
    TENANT_A,
    'A',
    ACTOR_B,
    TENANT_B,
    'B',
  ]);
  writer = new PGliteLedgerWriter(db);
  const scope = { tenantId: TENANT_A, workspaceId: WORKSPACE_A };
  await writer.ensureAssets(scope, ACTOR_A, [{ code: 'USD', scale: 2, kind: 'fiat', name: 'US dollar' }]);
  await writer.createBook(scope, ACTOR_A, {
    id: BOOK_ID,
    name: 'Paper portfolio',
    environment: 'paper',
    baseAsset: 'USD',
    ownerModule: 'invest',
    purpose: 'portfolio',
  });
  const cash = await writer.createAccount(scope, ACTOR_A, {
    bookId: BOOK_ID,
    code: 'cash',
    name: 'Cash',
    type: 'asset',
  });
  const security = await writer.createAccount(scope, ACTOR_A, {
    bookId: BOOK_ID,
    code: 'security',
    name: 'Security position',
    type: 'asset',
  });
  cashAccountId = cash.id;
  securityAccountId = security.id;
}, 60_000);

afterAll(async () => {
  await db?.close();
});

function posting(id: string) {
  return {
    id,
    bookId: BOOK_ID,
    environment: 'paper' as const,
    effectiveDate: '2026-09-30',
    description: 'Paper fill',
    source: 'invest',
    correlationId: id,
    entries: [
      { accountId: cashAccountId, asset: 'USD', units: '125' },
      { accountId: securityAccountId, asset: 'USD', units: '-125' },
    ],
  };
}

test('paper fill and double-entry posting commit together with the balance projection', async () => {
  const fillId = '019a0000-0000-7000-8000-000000000051';
  const txId = '019a0000-0000-7000-8000-000000000061';
  const result = await writer.withPaperTradeTransaction(
    { tenantId: TENANT_A, workspaceId: WORKSPACE_A },
    async (tx) => {
      await tx.query('INSERT INTO invest_fills(id,tenant_id,workspace_id,fill_key) VALUES ($1,$2,$3,$4)', [
        fillId,
        TENANT_A,
        WORKSPACE_A,
        'fill-001',
      ]);
      return tx.post(ACTOR_A, posting(txId));
    },
  );
  expect(result.status).toBe('posted');
  const committed = await db.query<{ fills: number; entries: number; tx: number }>(
    `SELECT
       (SELECT count(*)::int FROM invest_fills WHERE id=$1) AS fills,
       (SELECT count(*)::int FROM ledger_entries WHERE transaction_id=$2) AS entries,
       (SELECT count(*)::int FROM ledger_transactions WHERE id=$2) AS tx`,
    [fillId, txId],
  );
  expect(committed.rows[0]).toEqual({ fills: 1, entries: 2, tx: 1 });
  const projection = await db.query<{ account_id: string; units: string }>(
    `SELECT account_id, units::text FROM ledger_balances WHERE tenant_id=$1 AND workspace_id=$2 AND book_id=$3
       AND environment='paper' ORDER BY account_id`,
    [TENANT_A, WORKSPACE_A, BOOK_ID],
  );
  expect(Object.fromEntries(projection.rows.map((row) => [row.account_id, row.units]))).toEqual({
    [cashAccountId]: '125',
    [securityAccountId]: '-125',
  });
});

test('paper transaction rolls back fill, ledger entries, and projection together on failure', async () => {
  const fillId = '019a0000-0000-7000-8000-000000000052';
  const txId = '019a0000-0000-7000-8000-000000000062';
  await expect(
    writer.withPaperTradeTransaction({ tenantId: TENANT_A, workspaceId: WORKSPACE_A }, async (tx) => {
      await tx.query('INSERT INTO invest_fills(id,tenant_id,workspace_id,fill_key) VALUES ($1,$2,$3,$4)', [
        fillId,
        TENANT_A,
        WORKSPACE_A,
        'fill-002',
      ]);
      await tx.post(ACTOR_A, posting(txId));
      throw new Error('simulate failure after ledger projection');
    }),
  ).rejects.toThrow('simulate failure');
  const rolledBack = await db.query<{ fills: number; entries: number; tx: number; balances: number }>(
    `SELECT
       (SELECT count(*)::int FROM invest_fills WHERE id=$1) AS fills,
       (SELECT count(*)::int FROM ledger_entries WHERE transaction_id=$2) AS entries,
       (SELECT count(*)::int FROM ledger_transactions WHERE id=$2) AS tx,
       (SELECT count(*)::int FROM ledger_balances WHERE tenant_id=$3 AND workspace_id=$4 AND book_id=$5) AS balances`,
    [fillId, txId, TENANT_A, WORKSPACE_A, BOOK_ID],
  );
  expect(rolledBack.rows[0]).toEqual({ fills: 0, entries: 0, tx: 0, balances: 2 });
});

test('paper transaction rejects live/actual posting and cross-tenant fill writes', async () => {
  const scope = { tenantId: TENANT_A, workspaceId: WORKSPACE_A };
  await expect(
    writer.withPaperTradeTransaction(scope, (tx) =>
      tx.post(ACTOR_A, {
        ...posting('019a0000-0000-7000-8000-000000000063'),
        environment: 'actual',
      }),
    ),
  ).rejects.toMatchObject({ code: 'PAPER_ONLY' });
  await expect(
    writer.withPaperTradeTransaction(scope, (tx) =>
      tx.query('INSERT INTO invest_fills(id,tenant_id,workspace_id,fill_key) VALUES ($1,$2,$3,$4)', [
        '019a0000-0000-7000-8000-000000000053',
        TENANT_B,
        WORKSPACE_B,
        'forbidden',
      ]),
    ),
  ).rejects.toThrow();
});

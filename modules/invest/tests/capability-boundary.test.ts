import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import type { PGlite } from '@electric-sql/pglite';
import investManifest from '../manifest';

function load(directory: URL, module: string) {
  return readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()
    .map((name) => migration(`${module}/${name.slice(0, -4)}`, readFileSync(new URL(name, directory), 'utf8')));
}

const tenant = '019a0000-0000-7000-8000-000000000501';
const workspace = '019a0000-0000-7000-8000-000000000502';
const user = '019a0000-0000-7000-8000-000000000503';
let db: PGlite;
let scoped: LocalScopedStore;

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, [
    ...load(new URL('../../../packages/db/migrations/', import.meta.url), 'platform'),
    ...load(new URL('../../money/migrations/', import.meta.url), 'money'),
    ...load(new URL('../../invest/migrations/', import.meta.url), 'invest'),
    ...load(new URL('../../swarm/migrations/', import.meta.url), 'swarm'),
  ]);
  await prepareLocalAppRole(db, [
    ...investManifest.tables,
    { name: 'ledger_entries', class: 'append', authority: 'server', serverWriteCapabilities: ['money_ledger'] },
    { name: 'swarm_night_shift', class: 'local', authority: 'local' },
  ]);
  await db.exec(`INSERT INTO tenants(id,name) VALUES ('${tenant}','Invest test');
    INSERT INTO workspaces(id,tenant_id,name) VALUES ('${workspace}','${tenant}','Invest test');
    INSERT INTO users(id,tenant_id,display_name) VALUES ('${user}','${tenant}','Invest test');`);
  scoped = new LocalScopedStore(db);
}, 60_000);

afterAll(async () => { await db?.close(); });

test('xyra_cap_money_ledger cannot update same-workspace local SWARM night-shift settings', async () => {
  await db.exec(`INSERT INTO swarm_night_shift(tenant_id,workspace_id,max_runs,max_spend_usd)
    VALUES ('${tenant}','${workspace}',1,1)`);
  await expect(scoped.withServerScope({ tenantId: tenant, workspaceId: workspace }, 'money_ledger', undefined, (tx) =>
    tx.query(`UPDATE swarm_night_shift SET max_runs=99 WHERE tenant_id=$1 AND workspace_id=$2`, [tenant, workspace]),
  )).rejects.toThrow(/permission denied/);
});

test('xyra_app cannot insert into Invest server-authority orders', async () => {
  await expect(scoped.query({ tenantId: tenant, workspaceId: workspace },
    `INSERT INTO invest_orders(id,tenant_id,workspace_id,portfolio_id,instrument_id,mandate_id,risk_decision_id,side,order_type,quantity_units,status,idempotency_key,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,'buy','market',1,'proposed','x',$8)`,
    ['019a0000-0000-7000-8000-000000000505', tenant, workspace, user, user, user, user, user]),
  ).rejects.toThrow(/permission denied/);
});

test('Invest input and source contain no Live execution selector or broker endpoint path', () => {
  const risk = readFileSync(new URL('../server/risk.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, string> };
  expect(risk).toContain("environment: z.literal('paper').default('paper')");
  expect(risk).not.toMatch(/fetch\s*\(|https?:\/\/[^\s'"`]+|LIVE_TRADING|liveBroker|brokerAdapter/i);
  expect(Object.keys(packageJson.exports).some((key) => /live|broker/i.test(key))).toBe(false);
});

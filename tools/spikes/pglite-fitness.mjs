#!/usr/bin/env node
// PGlite fitness spike (ARC-002, ARC-023). Prints a JSON verdict per check. Run: node tools/spikes/pglite-fitness.mjs
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = {};
const check = async (name, fn) => {
  try {
    results[name] = { ok: true, detail: await fn() };
  } catch (e) {
    results[name] = { ok: false, detail: String(e?.message ?? e) };
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-spike-'));
const db = await PGlite.create(dir, { extensions: { vector } });

await check('version', async () => (await db.query('select version() v')).rows[0].v);
await check('session_user', async () => (await db.query('select session_user s, current_user c')).rows[0]);

await check('setup', async () => {
  await db.exec(`
    create extension if not exists vector;
    create role xyra_app nologin;
    create table t (id int primary key, tenant_id uuid not null, body text);
    alter table t enable row level security; alter table t force row level security;
    create or replace function app_tenant() returns uuid language sql stable as
      $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;
    create policy iso on t using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
    grant select, insert, update, delete on t to xyra_app;
    insert into t values (1, '00000000-0000-0000-0000-000000000001', 'a'), (2, '00000000-0000-0000-0000-000000000002', 'b');
  `);
  return 'ok';
});

await check('rls_enforced_under_set_role', async () => {
  await db.exec(`set role xyra_app; select set_config('app.tenant_id','00000000-0000-0000-0000-000000000001', false);`);
  const r = (await db.query('select id from t order by id')).rows.map((x) => x.id);
  return { visible: r, expected: [1] };
});

await check('rls_fail_closed_without_context', async () => {
  await db.exec(`select set_config('app.tenant_id','', false);`);
  const r = (await db.query('select count(*)::int n from t')).rows[0].n;
  return { visibleRows: r, expected: 0 };
});

await check('role_escape_via_reset_role', async () => {
  // ARC-002: can SQL running as xyra_app escape back to the session superuser?
  await db.exec('reset role');
  const r = (await db.query('select current_user c')).rows[0].c;
  return { currentUserAfterReset: r, escaped: r !== 'xyra_app' };
});

await check('login_role_session_user', async () => {
  // Can PGlite open a session AS a non-superuser (so there is nothing to reset to)?
  await db.exec(`create role xyra_login login; grant xyra_app to xyra_login;`);
  const db2 = await PGlite.create(dir + '-copy-unused', { username: 'xyra_login' }).catch((e) => ({ err: String(e.message) }));
  if (db2.err) return { supported: false, error: db2.err };
  const r = await db2.query('select session_user s').catch((e) => ({ rows: [{ s: 'ERR ' + e.message }] }));
  await db2.close?.();
  return { supported: true, sessionUser: r.rows[0].s };
});

await check('deferred_constraint_trigger', async () => {
  await db.exec(`
    create table je (tx int, amount numeric(38,0));
    create or replace function check_bal() returns trigger language plpgsql as $$
      begin if (select coalesce(sum(amount),0) from je where tx = new.tx) <> 0 then raise exception 'unbalanced %', new.tx; end if; return null; end $$;
    create constraint trigger bal after insert on je deferrable initially deferred for each row execute function check_bal();
  `);
  await db.transaction(async (tx) => {
    await tx.query('insert into je values (1, 100)');
    await tx.query('insert into je values (1, -100)');
  });
  let rejected = false;
  try {
    await db.transaction(async (tx) => {
      await tx.query('insert into je values (2, 100)');
    });
  } catch {
    rejected = true;
  }
  return { balancedCommitted: true, unbalancedRejected: rejected };
});

await check('append_only_trigger', async () => {
  await db.exec(`
    create table ae (id int primary key, v text);
    create or replace function deny_mut() returns trigger language plpgsql as $$ begin raise exception 'append-only'; end $$;
    create trigger ae_no_upd before update or delete on ae for each row execute function deny_mut();
    insert into ae values (1,'x');`);
  let blocked = false;
  try {
    await db.exec(`update ae set v='y' where id=1`);
  } catch {
    blocked = true;
  }
  return { updateBlocked: blocked };
});

await check('vector_version_and_hnsw', async () => {
  const v = (await db.query(`select extversion from pg_extension where extname='vector'`)).rows[0]?.extversion;
  await db.exec(`create table emb (id int, e vector(3)); insert into emb values (1,'[1,0,0]'),(2,'[0,1,0]');
    create index on emb using hnsw (e vector_cosine_ops);`);
  const top = (await db.query(`select id from emb order by e <=> '[1,0.1,0]' limit 1`)).rows[0].id;
  let halfvec = false;
  try {
    await db.exec(`create table hv (e halfvec(3))`);
    halfvec = true;
  } catch {}
  return { vectorVersion: v, nearest: top, halfvec };
});

await check('advisory_lock', async () => (await db.query('select pg_try_advisory_lock(42) l')).rows[0].l);

await check('statement_timeout', async () => {
  await db.exec(`set statement_timeout = '50ms'`);
  try {
    await db.query('select pg_sleep(1)');
    return { enforced: false };
  } catch (e) {
    return { enforced: true, error: String(e.message).slice(0, 60) };
  } finally {
    await db.exec(`set statement_timeout = 0`);
  }
});

await db.close();

await check('worker_thread', async () => {
  const code = `
    const { parentPort } = require('node:worker_threads');
    import('@electric-sql/pglite').then(async ({ PGlite }) => {
      const db = await PGlite.create();
      const r = await db.query('select 41+1 n');
      parentPort.postMessage(r.rows[0].n);
    }).catch(e => parentPort.postMessage('ERR ' + e.message));`;
  return await new Promise((res, rej) => {
    const w = new Worker(code, { eval: true });
    w.once('message', (m) => (w.terminate(), res({ result: m })));
    w.once('error', rej);
  });
});

await check('durability_reopen', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-dur-'));
  const a = await PGlite.create(d);
  await a.exec('create table k (v int); insert into k values (7);');
  await a.close();
  const b = await PGlite.create(d);
  const v = (await b.query('select v from k')).rows[0].v;
  await b.close();
  return { reopenedValue: v, note: 'kill -9 / power-loss durability needs a separate crash test (ARC-023)' };
});

console.log(JSON.stringify(results, null, 1));

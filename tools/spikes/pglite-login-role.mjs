import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-login-'));
const a = await PGlite.create(d);
await a.exec(`create role xyra_app nologin; create role xyra_login login; grant xyra_app to xyra_login;
  alter role xyra_login set role xyra_app;
  create table t (id int, tenant uuid); alter table t enable row level security; alter table t force row level security;
  create policy p on t using (tenant = nullif(current_setting('app.tenant_id', true),'')::uuid);
  grant select on t to xyra_app; insert into t values (1, gen_random_uuid());`);
await a.close();
const out = {};
try {
  const b = await PGlite.create(d, { username: 'xyra_login' });
  out.sessionUser = (await b.query('select session_user s, current_user c')).rows[0];
  out.rowsNoCtx = (await b.query('select count(*)::int n from t')).rows[0].n;
  for (const esc of ['reset role', 'set role postgres', 'set session authorization postgres']) {
    try { await b.exec(esc); out[esc] = (await b.query('select current_user c')).rows[0].c; } catch (e) { out[esc] = 'BLOCKED: ' + e.message.slice(0, 70); }
  }
  try { await b.exec('create table evil(x int)'); out.ddl = 'allowed'; } catch (e) { out.ddl = 'BLOCKED: ' + e.message.slice(0,60); }
  await b.close();
} catch (e) { out.error = e.message; }
console.log(JSON.stringify(out, null, 1));

import { Pool } from '@neondatabase/serverless';

const [tenantA, workspaceA, tenantB, workspaceB] = process.argv.slice(2);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  if (![tenantA, workspaceA, tenantB, workspaceB].every((value) => value && uuid.test(value)))
    throw new Error('TWO_DISPOSABLE_SCOPES_REQUIRED');
  if (tenantA === tenantB || workspaceA === workspaceB) throw new Error('SCOPES_MUST_BE_DISTINCT');
  const url = process.env.NEON_DATABASE_URL;
  if (!url) throw new Error('RUNTIME_BINDING_MISSING');
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    const identity = await client.query(
      `SELECT current_user,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user`,
    );
    const role = identity.rows[0];
    if (!role || role.current_user !== 'xyra_cloud_runtime_app' || role.rolsuper || role.rolbypassrls)
      throw new Error('RUNTIME_ROLE_NOT_RESTRICTED');

    await client.query('BEGIN');
    try {
      // Missing tenant/workspace context must expose no canonical rows.
      await client.query("SELECT set_config('app.tenant_id','',true),set_config('app.workspace_id','',true)");
      const missingScope = await client.query('SELECT count(*)::int AS count FROM cloud_sync_rows');
      if (missingScope.rows[0]?.count !== 0) throw new Error('MISSING_SCOPE_LEAK');

      // Verify both disposable workspace fixtures and seed one row per tenant as the actual
      // runtime login. All rows are rolled back with this transaction.
      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [tenantB, workspaceB]);
      const fixtureB = await client.query(
        'SELECT 1 FROM workspaces WHERE tenant_id=$1 AND id=$2',
        [tenantB, workspaceB],
      );
      if (fixtureB.rows.length !== 1) throw new Error('TENANT_B_FIXTURE_MISSING');
      await client.query(
        `INSERT INTO cloud_sync_rows(tenant_id,workspace_id,table_name,row_id,fields)
         VALUES ($1,$2,'ops_projects','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','{"probe":true}'::jsonb)`,
        [tenantB, workspaceB],
      );

      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [tenantA, workspaceA]);
      const fixtureA = await client.query(
        'SELECT 1 FROM workspaces WHERE tenant_id=$1 AND id=$2',
        [tenantA, workspaceA],
      );
      if (fixtureA.rows.length !== 1) throw new Error('TENANT_A_FIXTURE_MISSING');
      // Insert one disposable row in A through the actual runtime login.
      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [tenantA, workspaceA]);
      const rowId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      await client.query(
        `INSERT INTO cloud_sync_rows(tenant_id,workspace_id,table_name,row_id,fields)
         VALUES ($1,$2,'ops_projects',$3,'{"probe":true}'::jsonb)
         ON CONFLICT (tenant_id,workspace_id,table_name,row_id) DO UPDATE SET fields=EXCLUDED.fields`,
        [tenantA, workspaceA, rowId],
      );
      const own = await client.query(
        'SELECT 1 FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2 AND row_id=$3',
        [tenantA, workspaceA, rowId],
      );
      if (own.rows.length !== 1) throw new Error('OWN_SCOPE_NOT_VISIBLE');
      const hidden = await client.query(
        'SELECT 1 FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2',
        [tenantB, workspaceB],
      );
      if (hidden.rows.length !== 0) throw new Error('CROSS_TENANT_READ_LEAK');

      await client.query('SAVEPOINT cross_tenant_write');
      let denied = false;
      try {
        await client.query(
          `INSERT INTO cloud_sync_rows(tenant_id,workspace_id,table_name,row_id,fields)
           VALUES ($1,$2,'ops_projects','ffffffff-ffff-4fff-8fff-ffffffffffff','{"probe":true}'::jsonb)`,
          [tenantB, workspaceB],
        );
      } catch {
        denied = true;
        await client.query('ROLLBACK TO SAVEPOINT cross_tenant_write');
      }
      if (!denied) throw new Error('CROSS_TENANT_WRITE_ACCEPTED');
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    process.stdout.write(`${JSON.stringify({ status: 'PASS', checks: ['restricted-role', 'missing-scope', 'own-scope', 'cross-tenant-read', 'cross-tenant-write'], rolledBack: true })}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  const code = typeof error?.message === 'string' && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'RLS_PROBE_FAILED';
  console.error(JSON.stringify({ status: 'FAIL', code }));
  process.exitCode = 1;
});

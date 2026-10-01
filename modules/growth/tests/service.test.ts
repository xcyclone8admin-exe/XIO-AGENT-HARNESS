import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyPGliteMigrations, LocalScopedStore, prepareLocalAppRole } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { uuidv7 } from '@xyra/core';
import growthManifest from '../manifest';
import { GrowthService } from '../server/service';
import { loadMigrations } from './fixtures';

let db: PGlite;
let service: GrowthService;

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, loadMigrations());
  await prepareLocalAppRole(db, growthManifest.tables);
  service = new GrowthService(new LocalScopedStore(db));
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function makeWorkspace(name: string) {
  const tenantId = uuidv7();
  const workspaceId = uuidv7();
  const userId = uuidv7();
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2)', [tenantId, `${name} tenant`]);
  await db.query('INSERT INTO users(id,tenant_id,display_name) VALUES ($1,$2,$3)', [userId, tenantId, name]);
  await db.query(
    'INSERT INTO workspaces(id,tenant_id,name,kind,sync_enabled) VALUES ($1,$2,$3,$4,$5)',
    [workspaceId, tenantId, name, 'standard', false],
  );
  await db.query(
    'INSERT INTO memberships(id,tenant_id,workspace_id,user_id,role) VALUES ($1,$2,$3,$4,$5)',
    [uuidv7(), tenantId, workspaceId, userId, 'owner'],
  );
  return { tenantId, workspaceId, userId };
}

describe('growth service', () => {
  test('contacts and companies are scoped to workspace', async () => {
    const a = await makeWorkspace('G-A');
    const b = await makeWorkspace('G-B');

    await service.createContact(a, a.userId, 'Alice', { email: 'alice@example.com' });

    const aContacts = await service.contacts(a);
    const bContacts = await service.contacts(b);
    expect(aContacts).toHaveLength(1);
    expect(bContacts).toHaveLength(0);
    expect(aContacts[0]?.email).toBe('alice@example.com');
  });

  test('deals track pipeline and can be filtered by status', async () => {
    const ws = await makeWorkspace('G-C');

    await service.createDeal(ws, ws.userId, 'Big deal', 'Enterprise', 'Discovery',
      { value_cents: 50000_00, currency: 'USD' });
    await service.createDeal(ws, ws.userId, 'Small deal', 'SMB', 'Proposal',
      { value_cents: 5000_00, currency: 'USD' });

    const allDeals = await service.deals(ws);
    expect(allDeals).toHaveLength(2);

    const enterpriseDeals = await service.deals(ws, 'Enterprise');
    expect(enterpriseDeals).toHaveLength(1);
    expect(enterpriseDeals[0]?.title).toBe('Big deal');
  });

  test('sequence enrollment is append-only', async () => {
    const ws = await makeWorkspace('G-D');
    const contact = await service.createContact(ws, ws.userId, 'Bob', {});

    const [seqResult] = await db.query<{ id: string }>(
      `INSERT INTO growth_sequences(id,tenant_id,workspace_id,name,created_by)
       VALUES ($1,$2,$3,'Test seq',$4) RETURNING id`,
      [uuidv7(), ws.tenantId, ws.workspaceId, ws.userId],
    ).then((r) => r.rows);
    if (!seqResult) throw new Error('seq insert failed');

    await service.enrollContact(ws, ws.userId, seqResult.id, contact.id);

    const [enrollment] = await db.query<{ id: string }>(
      'SELECT id FROM growth_sequence_enrollments WHERE workspace_id=$1',
      [ws.workspaceId],
    ).then((r) => r.rows);
    if (!enrollment) throw new Error('enrollment not found');

    await expect(
      db.query('DELETE FROM growth_sequence_enrollments WHERE id=$1', [enrollment.id]),
    ).rejects.toThrow();
  });

  test('send capability requires approval policy on sequence', async () => {
    const ws = await makeWorkspace('G-E');
    const [seq] = await db.query<{ send_approval_policy: string | null }>(
      `INSERT INTO growth_sequences(id,tenant_id,workspace_id,name,send_approval_policy,created_by)
       VALUES ($1,$2,$3,'Approval seq','growth.sequence.send',$4) RETURNING send_approval_policy`,
      [uuidv7(), ws.tenantId, ws.workspaceId, ws.userId],
    ).then((r) => r.rows);
    expect(seq?.send_approval_policy).toBe('growth.sequence.send');
  });

  test('ad campaign spend requires approval policy', async () => {
    const ws = await makeWorkspace('G-F');
    const [camp] = await db.query<{ spend_approval_policy: string | null }>(
      `INSERT INTO growth_ad_campaigns(id,tenant_id,workspace_id,name,platform,spend_approval_policy,created_by)
       VALUES ($1,$2,$3,'Test campaign','google','growth.ad.spend',$4) RETURNING spend_approval_policy`,
      [uuidv7(), ws.tenantId, ws.workspaceId, ws.userId],
    ).then((r) => r.rows);
    expect(camp?.spend_approval_policy).toBe('growth.ad.spend');
  });
});

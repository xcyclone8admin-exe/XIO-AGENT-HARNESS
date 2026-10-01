import { afterAll, beforeAll, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { uuidv7 } from '@xyra/core';
import { hashApprovalInput } from '@xyra/contracts';
import { applyPGliteMigrations, LocalScopedStore, prepareLocalAppRole } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { BrainService } from '@xyra/mod-brain/server';
import { brainCapabilities } from '@xyra/mod-brain/contracts';
import { bootstrapLocalIdentity } from '@xyra/mod-core/server';
import { MANIFESTS } from './generated/modules';
import { MIGRATIONS } from './generated/migrations';
import { CapabilityBus } from './bus';
import type { BusFault } from './bus';
import { DurableBusApproval, DurableBusAudit, DurableBusIdempotency } from './durable';
import { registerBrainCapabilities } from './brain';

let db: PGlite;

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, MIGRATIONS);
  await prepareLocalAppRole(db, MANIFESTS.flatMap((manifest) => manifest.tables));
}, 60_000);

afterAll(async () => {
  await db?.close();
});

test('CapabilityBus supplies trusted scope and only a durable exact-input approval proof', async () => {
  const principal = await bootstrapLocalIdentity(db, 'os:brain-approval-owner', 'Owner');
  const workspaceId = principal.workspaces.find((workspace) => workspace.kind === 'standard')!.id;
  const reviewerId = uuidv7();
  await db.query('INSERT INTO users(id,tenant_id,display_name,os_subject) VALUES ($1,$2,$3,$4)',
    [reviewerId, principal.tenantId, 'Reviewer', 'os:brain-approval-reviewer']);
  await db.query(`INSERT INTO memberships(id,tenant_id,workspace_id,user_id,role)
    VALUES ($1,$2,$3,$4,'admin')`, [uuidv7(), principal.tenantId, workspaceId, reviewerId]);

  const scoped = new LocalScopedStore(db);
  const bus = new CapabilityBus(
    new DurableBusAudit(scoped),
    new DurableBusIdempotency(scoped),
    new DurableBusApproval(scoped),
    () => false,
    async () => new Set(),
  );
  registerBrainCapabilities(bus, new BrainService(scoped));

  const source = await bus.call({
    principal,
    workspaceId,
    capabilityId: brainCapabilities.ingest.id,
    input: {
      source: { sourceType: 'document', title: 'Approved erase fixture', trustLevel: 'user', retention: 'workspace' },
      content: 'Disposable content for the approval integration test.',
      contentType: 'text/plain',
    },
    idempotencyKey: 'brain-source-ingest-approval-test',
  }) as { sourceId: string };
  const erasureInput = { sourceId: source.sourceId };
  const approvalId = uuidv7();
  const inputHash = await hashApprovalInput(erasureInput);
  await db.query(`INSERT INTO approval_requests(id,tenant_id,workspace_id,capability_id,input_hash,requested_by,reason,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval '1 hour')`, [
    approvalId, principal.tenantId, workspaceId, brainCapabilities.requestErasure.id,
    inputHash, principal.id, 'approved source-erasure test',
  ]);
  await db.query(`INSERT INTO approval_decisions(id,tenant_id,workspace_id,request_id,decided_by,decision,reason)
    VALUES ($1,$2,$3,$4,$5,'approved','independent active workspace admin')`, [
    uuidv7(), principal.tenantId, workspaceId, approvalId, reviewerId,
  ]);

  const result = await bus.call({
    principal,
    workspaceId,
    capabilityId: brainCapabilities.requestErasure.id,
    input: erasureInput,
    approvalId,
    idempotencyKey: 'brain-source-erase-approval-test',
  });
  expect(result).toMatchObject({ sourceId: source.sourceId, status: 'waiting_cloud', completionReceipt: null });

  await expect(bus.call({
    principal,
    workspaceId,
    capabilityId: brainCapabilities.requestErasure.id,
    input: { sourceId: uuidv7() },
    approvalId,
    idempotencyKey: 'brain-source-erase-changed-input',
  })).rejects.toMatchObject<Partial<BusFault>>({ code: 'APPROVAL_REQUIRED' });

  // Corrupt durable replay data must fail closed as an unavailable approval, not throw JSON.parse.
  await db.query(`UPDATE capability_idempotency SET result=$2::jsonb WHERE key=$1`, [
    `approval-use:${approvalId}`, JSON.stringify('{'),
  ]);
  await expect(bus.call({
    principal,
    workspaceId,
    capabilityId: brainCapabilities.requestErasure.id,
    input: erasureInput,
    approvalId,
    idempotencyKey: 'brain-source-erase-corrupt-replay',
  })).rejects.toMatchObject<Partial<BusFault>>({ code: 'APPROVAL_REQUIRED' });

  const erasures = await scoped.query<{ id: string } & Record<string, unknown>>(
    { tenantId: principal.tenantId, workspaceId },
    'SELECT id FROM brain_source_erasures WHERE source_id=$1',
    [source.sourceId],
  );
  expect(erasures.rows).toHaveLength(1);
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { applyPGliteMigrations, migration } from '@xyra/db';
import {
  CLOUD_INVEST_SIGNAL_ENVELOPE_DIGEST_TEST_VECTOR,
  cloudBrainContentDigest,
  cloudBrainSourceVersion,
  cloudInvestSignalEnvelopeDigest,
  cloudReferenceSetDigest,
} from '@xyra/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessContext } from './access';
import type { NeonQueryClient } from './neon';
import { lockWorkspaceSequence, NeonSyncStore } from './neon-sync-store';
import { SyncAuthorityEngine, hashRequest, parseSyncPush } from './sync';
import { drainSyncOutbox } from './sync-outbox';
import {
  INVEST_SIGNAL_CONSUME_PROTOCOL,
  INVEST_SIGNAL_PROTOCOL,
  acceptInvestSignalInTransaction,
  acknowledgeInvestSignalInTransaction,
  claimInvestSignalInTransaction,
  investSignalEnvelopeDigest,
  verifyInvestSignalEnvelopeDigest,
  type InvestSignalBody,
  type InvestSignalSourceKey,
  type RawInvestWebhook,
} from './invest-signals';
import {
  acknowledgeLocalErasurePurge,
  claimLocalErasurePurge,
  currentBrainIngestionSnapshot,
  eraseCloudBrainSourceRows,
  hasErasureFence,
  LocalPurgeAckRequest,
  sourceVersionDigest,
} from './erasures';

const sql = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const investSignalDigestVector = CLOUD_INVEST_SIGNAL_ENVELOPE_DIGEST_TEST_VECTOR;

describe('Cloud Invest envelope digest contract parity', () => {
  it('matches the shared fixed vector', async () => {
    expect(await cloudInvestSignalEnvelopeDigest(investSignalDigestVector.input)).toBe(
      investSignalDigestVector.digest,
    );
    expect(await investSignalEnvelopeDigest(investSignalDigestVector.input)).toBe(
      investSignalDigestVector.digest,
    );
  });
});

const migrations = [
  migration('platform/0001_platform', sql('../../../packages/db/migrations/0001_platform.sql')),
  migration('platform/0002_modules', sql('../../../packages/db/migrations/0002_modules.sql')),
  migration('platform/0003_swarm', sql('../../../packages/db/migrations/0003_swarm.sql')),
  migration('platform/0004_receipt_time', sql('../../../packages/db/migrations/0004_receipt_time.sql')),
  migration('core/0001_cloud_auth', sql('../../../modules/core/migrations/0001_cloud_auth.sql')),
  migration('core/0002_cloud_sync', sql('../../../modules/core/migrations/0002_cloud_sync.sql')),
  migration('core/0003_cloud_erasure', sql('../../../modules/core/migrations/0003_cloud_erasure.sql')),
  migration(
    'core/0004_cloud_blob_reference_sets',
    sql('../../../modules/core/migrations/0004_cloud_blob_reference_sets.sql'),
  ),
  migration(
    'core/0005_cloud_ingestion_finalization',
    sql('../../../modules/core/migrations/0005_cloud_ingestion_finalization.sql'),
  ),
  migration(
    'core/0006_cloud_ingestion_v2_hashes',
    sql('../../../modules/core/migrations/0006_cloud_ingestion_v2_hashes.sql'),
  ),
  migration(
    'core/0007_cloud_erasure_v2_fence',
    sql('../../../modules/core/migrations/0007_cloud_erasure_v2_fence.sql'),
  ),
  migration(
    'core/0008_cloud_erasure_sync_delete',
    sql('../../../modules/core/migrations/0008_cloud_erasure_sync_delete.sql'),
  ),
  migration(
    'core/0009_cloud_erasure_provenance_delete',
    sql('../../../modules/core/migrations/0009_cloud_erasure_provenance_delete.sql'),
  ),
  migration(
    'core/0010_cloud_erasure_deleting_state',
    sql('../../../modules/core/migrations/0010_cloud_erasure_deleting_state.sql'),
  ),
  migration(
    'core/0011_cloud_invest_signals',
    sql('../../../modules/core/migrations/0011_cloud_invest_signals.sql'),
  ),
  migration(
    'core/0012_cloud_invest_signal_resolution',
    sql('../../../modules/core/migrations/0012_cloud_invest_signal_resolution.sql'),
  ),
];

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_A = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_B = '44444444-4444-4444-8444-444444444444';
const USER_A = '55555555-5555-4555-8555-555555555555';
const ROW = '66666666-6666-4666-8666-666666666666';
const TEST_APPROVAL = '77777777-7777-4777-8777-777777777777';
let db: PGlite;

function access(tenantId: string, workspaceId: string): AccessContext {
  return {
    claims: {
      principalId: USER_A,
      kind: 'user',
      tenantId,
      workspaceIds: [workspaceId],
      activeWorkspaceId: workspaceId,
      autonomy: 1,
      expiresAtMs: Date.now() + 60_000,
      deviceThumbprint: 'd'.repeat(43),
      deviceId: '77777777-7777-4777-8777-777777777777',
    },
    membership: {
      principalId: USER_A,
      tenantId,
      workspaceId,
      role: 'owner',
      permissions: [],
      kind: 'user',
      workspaceKind: 'standard',
    },
    killSwitchEngaged: false,
  };
}

function pushRequest(title: string, stamp = Date.now(), key = `key-${crypto.randomUUID()}`) {
  const hlc = `${String(stamp).padStart(13, '0')}-0001-nodea`;
  return parseSyncPush({
    protocolVersion: 1,
    schemaVersion: 'cloud-sync-v1',
    nodeId: 'nodea',
    idempotencyKey: key,
    changes: [
      {
        table: 'ops_projects',
        id: ROW,
        tenantId: TENANT_A,
        workspaceId: WORKSPACE_A,
        op: 'upsert',
        hlc,
        fields: { name: { value: title, hlc, baseHlc: null } },
      },
    ],
  });
}

async function scoped<T>(
  tenantId: string,
  workspaceId: string,
  work: (client: NeonQueryClient) => Promise<T>,
): Promise<T> {
  await db.exec('BEGIN');
  try {
    await db.exec('SET LOCAL ROLE xyra_cloud_runtime_app');
    await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await db.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
    const result = await work(db as unknown as NeonQueryClient);
    await db.exec('COMMIT');
    return result;
  } catch (cause) {
    await db.exec('ROLLBACK').catch(() => undefined);
    throw cause;
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    'CREATE ROLE xyra_cloud_runtime_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  );
  await applyPGliteMigrations(db, migrations);
  await db.exec(`
    INSERT INTO tenants(id,name) VALUES ('${TENANT_A}','A'),('${TENANT_B}','B');
    INSERT INTO workspaces(id,tenant_id,name) VALUES
      ('${WORKSPACE_A}','${TENANT_A}','A'),('${WORKSPACE_B}','${TENANT_B}','B');
  `);
});

afterAll(async () => db?.close());

describe('Neon canonical sync store (PGlite role/RLS contract)', () => {
  it('accepts a matching local receipt once, erases canonical Cloud copies and replays the durable final result', async () => {
    const sourceId = '32323232-3232-4232-8232-323232323232';
    const versionId = '33333333-3333-4333-8333-333333333333';
    const ingestionId = '34343434-3434-4434-8434-343434343434';
    const operationId = '35353535-3535-4535-8535-353535353535';
    const attemptId = '36363636-3636-4636-8636-363636363636';
    const approvalId = '37373737-3737-4737-8737-373737373737';
    const localReceiptId = '38383838-3838-4838-8838-383838383838';
    const claimId = '39393939-3939-4939-8939-393939393939';
    const auditReceiptId = '40404040-4040-4040-8040-404040404040';
    const content = 'Cloud copy to erase';
    const contentHash = '9'.repeat(64);
    const contentDigest = await cloudBrainContentDigest(content);
    const contentVersion = await sourceVersionDigest({
      sourceId,
      versions: [{ id: versionId, version: 1, contentHash }],
    });
    const objectRefIds: string[] = [];
    const referenceStateVersion = 1;
    const snapshotDigest = await cloudReferenceSetDigest({
      sourceId,
      sourceVersionId: versionId,
      objectRefIds,
    });
    const sourceVersion = await cloudBrainSourceVersion({
      protocolVersion: 'cloud-ingest-v2',
      sourceId,
      sourceVersionId: versionId,
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      contentDigest,
      objectRefIds,
      referenceStateVersion,
    });
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      await lockWorkspaceSequence(client, TENANT_A, WORKSPACE_A);
      await client.query(
        `INSERT INTO cloud_sync_rows(tenant_id,workspace_id,table_name,row_id,fields)
        VALUES ($1,$2,'brain_sources',$3,$4::jsonb),($1,$2,'brain_source_versions',$5,$6::jsonb)`,
        [
          TENANT_A,
          WORKSPACE_A,
          sourceId,
          JSON.stringify({ cloud_object_ref_ids: { value: [] } }),
          versionId,
          JSON.stringify({
            source_id: { value: sourceId },
            version: { value: 1 },
            content_hash: { value: contentHash },
            content_text: { value: content },
          }),
        ],
      );
      await client.query(
        `INSERT INTO cloud_source_ingestions(tenant_id,workspace_id,id,source_id,actor_id,mode,status,
          content_version,source_version,source_version_id,content_digest,reference_state_version,snapshot_digest,
          reference_state,object_ref_ids,finalized_at)
        VALUES ($1,$2,$3,$4,$5,'text_only','finalized',$6,$7,$8,$9,$10,$11,'verified_empty','{}',now())`,
        [
          TENANT_A,
          WORKSPACE_A,
          ingestionId,
          sourceId,
          USER_A,
          contentVersion,
          sourceVersion,
          versionId,
          contentDigest,
          referenceStateVersion,
          snapshotDigest,
        ],
      );
      await client.query(
        `INSERT INTO cloud_erasure_reference_sets(tenant_id,workspace_id,snapshot_id,source_kind,source_id,
          source_version,snapshot_digest,reference_state_version,object_ids,current,ingestion_id,content_version,completeness)
        VALUES ($1,$2,$3,'brain_source',$4,$5,$6,$7,'{}',true,$8,$9,'verified_empty')`,
        [
          TENANT_A,
          WORKSPACE_A,
          crypto.randomUUID(),
          sourceId,
          sourceVersion,
          snapshotDigest,
          referenceStateVersion,
          ingestionId,
          contentVersion,
        ],
      );
      await client.query(
        `INSERT INTO cloud_erasure_operations(tenant_id,workspace_id,id,erasure_id,source_kind,source_id,
          source_version,request_digest,actor_id,capability_id,approval_id,status,claim_id,claim_generation,receipt_id)
        VALUES ($1,$2,$3,$4,'brain_source',$5,$6,$7,$8,'brain.sources.erase',$9,'purge_claimed',$10,1,$11)`,
        [
          TENANT_A,
          WORKSPACE_A,
          operationId,
          operationId,
          sourceId,
          sourceVersion,
          '8'.repeat(64),
          USER_A,
          approvalId,
          claimId,
          auditReceiptId,
        ],
      );
      await client.query(
        `INSERT INTO cloud_erasure_attempts(tenant_id,workspace_id,operation_id,attempt_id,attempt_no,
          request_digest,approval_id,approval_input_hash,approval_scope_hash)
        VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8)`,
        [
          TENANT_A,
          WORKSPACE_A,
          operationId,
          attemptId,
          '8'.repeat(64),
          approvalId,
          '7'.repeat(64),
          '6'.repeat(64),
        ],
      );
      const ack = LocalPurgeAckRequest.parse({
        protocolVersion: 'cloud-erasure-v1',
        attemptId,
        claimId,
        claimGeneration: 1,
        localPurgeReceiptId: localReceiptId,
        localPurgeReceiptDigest: '5'.repeat(64),
        sourceVersion,
      });
      const first = await acknowledgeLocalErasurePurge(
        client,
        TENANT_A,
        WORKSPACE_A,
        operationId,
        ack,
        false,
      );
      expect(first).toMatchObject({
        ok: true,
        status: 'completed',
        receiptId: auditReceiptId,
        replayed: false,
      });
      const replay = await acknowledgeLocalErasurePurge(
        client,
        TENANT_A,
        WORKSPACE_A,
        operationId,
        ack,
        false,
      );
      expect(replay).toEqual({ ...first, replayed: true, deleteTargets: [] });
      const mismatch = await acknowledgeLocalErasurePurge(
        client,
        TENANT_A,
        WORKSPACE_A,
        operationId,
        { ...ack, localPurgeReceiptId: '41414141-4141-4141-8141-414141414141' },
        false,
      );
      expect(mismatch).toEqual({ ok: false, code: 'RECEIPT_MISMATCH' });
      const copies = await client.query(
        `SELECT 1 FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2
        AND table_name IN ('brain_sources','brain_source_versions') AND row_id=ANY($3::uuid[])`,
        [TENANT_A, WORKSPACE_A, [sourceId, versionId]],
      );
      expect(copies.rows).toHaveLength(0);
    });
  });

  it('purges only explicit BRAIN source lineage, fences stale rows and detaches surviving history edges', async () => {
    const sourceId = '19191919-1919-4919-8919-191919191919';
    const versionId = '20202020-2020-4020-8020-202020202020';
    const chunkId = '21212121-2121-4121-8121-212121212121';
    const signalId = '22222222-2222-4222-8222-222222222222';
    const claimId = '23232323-2323-4323-8323-232323232323';
    const factId = '24242424-2424-4424-8424-242424242424';
    const promotionId = '25252525-2525-4525-8525-252525252525';
    const contradictionId = '26262626-2626-4626-8626-262626262626';
    const memoryId = '27272727-2727-4727-8727-272727272727';
    const survivorMemoryId = '28282828-2828-4828-8828-282828282828';
    const procedureId = '29292929-2929-4929-8929-292929292929';
    const operationId = '30303030-3030-4030-8030-303030303030';
    const ingestionId = '31313131-3131-4131-8131-313131313131';
    const sourceVersion = `cloud-ingest-v2:sha256:${'7'.repeat(64)}`;
    const tick = `${String(Date.now()).padStart(13, '0')}-0001-nodea`;
    const f = (value: unknown) => ({ value, hlc: tick, baseHlc: null });
    const rows = [
      ['brain_sources', sourceId, { title: f('source secret'), cloud_object_ref_ids: f([]) }],
      [
        'brain_source_versions',
        versionId,
        {
          source_id: f(sourceId),
          version: f(1),
          content_hash: f('c'.repeat(64)),
          content_text: f('version secret'),
        },
      ],
      [
        'brain_chunks',
        chunkId,
        { source_id: f(sourceId), source_version_id: f(versionId), content_text: f('chunk secret') },
      ],
      [
        'brain_signals',
        signalId,
        { source_id: f(sourceId), source_version_id: f(versionId), signal_type: f('signal') },
      ],
      ['brain_claims', claimId, { signal_id: f(signalId), subject: f('subject secret') }],
      ['brain_promotions', promotionId, { claim_id: f(claimId), reason: f('promotion secret') }],
      ['brain_facts', factId, { claim_id: f(claimId), object: f('fact secret') }],
      [
        'brain_contradictions',
        contradictionId,
        { claim_id: f(claimId), fact_id: f(factId), resolution: f('resolution secret') },
      ],
      [
        'brain_memories',
        memoryId,
        { source_id: f(sourceId), source_version_id: f(versionId), content: f('memory secret') },
      ],
      ['brain_memories', survivorMemoryId, { content: f('surviving memory'), supersedes_id: f(memoryId) }],
      ['brain_procedures', procedureId, { source_run_id: f(sourceId), body: f('workflow secret') }],
    ] as const;
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      await lockWorkspaceSequence(client, TENANT_A, WORKSPACE_A);
      const seqState = await client.query<{ last_seq: number }>(
        'SELECT last_seq FROM cloud_sync_sequences WHERE tenant_id=$1 AND workspace_id=$2',
        [TENANT_A, WORKSPACE_A],
      );
      const baseSeq = seqState.rows[0]?.last_seq ?? 0;
      await client.query(
        'UPDATE cloud_sync_sequences SET last_seq=$3 WHERE tenant_id=$1 AND workspace_id=$2',
        [TENANT_A, WORKSPACE_A, baseSeq + 1000],
      );
      for (const [table, id, fields] of rows) {
        if (table === 'brain_procedures') {
          await client.query(
            `INSERT INTO cloud_sync_rows(tenant_id,workspace_id,table_name,row_id,fields)
            VALUES ($1,$2,$3,$4,$5::jsonb)`,
            [TENANT_A, WORKSPACE_A, table, id, JSON.stringify(fields)],
          );
          continue;
        }
        await client.query(
          `INSERT INTO cloud_sync_rows(tenant_id,workspace_id,table_name,row_id,fields)
          VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [TENANT_A, WORKSPACE_A, table, id, JSON.stringify(fields)],
        );
        const change = {
          table,
          id,
          tenantId: TENANT_A,
          workspaceId: WORKSPACE_A,
          op: 'append',
          hlc: tick,
          fields,
        };
        const seq = baseSeq + 101 + rows.indexOf(rows.find((item) => item[1] === id)!);
        await client.query(
          `INSERT INTO cloud_sync_changes(tenant_id,workspace_id,server_seq,table_name,row_id,change,bytes)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,octet_length($6::text))`,
          [TENANT_A, WORKSPACE_A, seq, table, id, JSON.stringify(change)],
        );
        await client.query(
          `INSERT INTO cloud_sync_field_seq(tenant_id,workspace_id,table_name,row_id,field_name,server_seq)
          VALUES ($1,$2,$3,$4,'content_text',$5) ON CONFLICT DO NOTHING`,
          [TENANT_A, WORKSPACE_A, table, id, seq],
        );
      }
      await client.query(
        `INSERT INTO cloud_sync_conflicts(tenant_id,workspace_id,table_name,row_id,record,bytes)
        VALUES ($1,$2,'brain_chunks',$3,$4::jsonb,128)`,
        [
          TENANT_A,
          WORKSPACE_A,
          chunkId,
          JSON.stringify({
            table: 'brain_chunks',
            rowId: chunkId,
            field: 'content_text',
            losingValue: 'conflict secret',
          }),
        ],
      );
      await client.query(
        `INSERT INTO cloud_sync_idempotency(tenant_id,workspace_id,idempotency_key,payload_hash,response)
        VALUES ($1,$2,'erasure-replay-secret-key','${'a'.repeat(64)}',$3::jsonb)`,
        [
          TENANT_A,
          WORKSPACE_A,
          JSON.stringify({
            accepted: 1,
            conflicts: 1,
            serverSeq: '101',
            rejected: [],
            replayed: false,
            conflictHistory: [
              {
                table: 'brain_chunks',
                rowId: chunkId,
                field: 'content_text',
                losingValue: 'conflict secret',
              },
            ],
            changeOutcomes: [
              {
                index: 0,
                changeId: chunkId,
                table: 'brain_chunks',
                rowId: chunkId,
                outcome: 'committed',
                appliedFields: ['content_text'],
                unchangedFields: [],
                conflictedFields: [],
              },
            ],
          }),
        ],
      );
      await client.query(
        `INSERT INTO cloud_source_ingestions(tenant_id,workspace_id,id,source_id,actor_id,mode,status)
        VALUES ($1,$2,$3,$4,$5,'text_only','collecting')`,
        [TENANT_A, WORKSPACE_A, ingestionId, sourceId, USER_A],
      );
      const receipt = crypto.randomUUID();
      await client.query(
        `INSERT INTO cloud_erasure_operations(tenant_id,workspace_id,id,erasure_id,source_kind,source_id,
          source_version,request_digest,actor_id,capability_id,approval_id,status,claim_id,claim_generation,receipt_id)
        VALUES ($1,$2,$3,$4,'brain_source',$5,$6,$7,$8,'brain.sources.erase',$9,'purge_claimed',$10,1,$11)`,
        [
          TENANT_A,
          WORKSPACE_A,
          operationId,
          operationId,
          sourceId,
          sourceVersion,
          'b'.repeat(64),
          USER_A,
          TEST_APPROVAL,
          crypto.randomUUID(),
          receipt,
        ],
      );
      const result = await eraseCloudBrainSourceRows(
        client,
        TENANT_A,
        WORKSPACE_A,
        sourceId,
        operationId,
        sourceVersion,
      );
      expect(result).toMatchObject({
        canonicalRows: 2,
        derivedRows: 7,
        detachedSupersedesEdges: 1,
        conflictRecordsDeleted: 1,
        idempotencyRecordsDeleted: 1,
        ingestionRecordsDeleted: 1,
      });
      expect(result.deletedByTable).toMatchObject({
        brain_sources: 1,
        brain_source_versions: 1,
        brain_chunks: 1,
        brain_signals: 1,
        brain_claims: 1,
        brain_promotions: 1,
        brain_facts: 1,
        brain_contradictions: 1,
        brain_memories: 1,
      });
      const remaining = await client.query<{ table_name: string; row_id: string; fields: unknown }>(
        `SELECT table_name,row_id,fields FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2`,
        [TENANT_A, WORKSPACE_A],
      );
      expect(remaining.rows.map((row) => `${row.table_name}:${row.row_id}`)).toContain(
        `brain_procedures:${procedureId}`,
      );
      const survivor = remaining.rows.find((row) => row.row_id === survivorMemoryId);
      const survivorFields =
        typeof survivor?.fields === 'string'
          ? JSON.parse(survivor.fields)
          : (survivor?.fields as Record<string, unknown>);
      const supersedes = survivorFields?.['supersedes_id'];
      expect(
        typeof supersedes === 'object' && supersedes !== null && 'value' in supersedes
          ? supersedes.value
          : undefined,
      ).toBeNull();
      const leaked = await client.query(
        `SELECT 1 FROM cloud_sync_changes WHERE tenant_id=$1 AND workspace_id=$2
        AND change::text LIKE '%secret%' LIMIT 1`,
        [TENANT_A, WORKSPACE_A],
      );
      expect(leaked.rows).toHaveLength(0);
      const fences = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM cloud_erasure_source_fences
        WHERE tenant_id=$1 AND workspace_id=$2 AND operation_id=$3`,
        [TENANT_A, WORKSPACE_A, operationId],
      );
      expect(fences.rows[0]?.count).toBe(9);
    });
  });

  it('re-derives a current finalized empty-reference source snapshot from tenant-scoped canonical rows', async () => {
    const sourceId = '99999999-9999-4999-8999-999999999999';
    const versionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const ingestionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const erasureId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const attemptId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const approvalId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const reservationId = '12121212-1212-4212-8212-121212121212';
    const content = 'source text\nnormalized';
    const contentHash = 'c'.repeat(64);
    const refs: string[] = [];
    const referenceStateVersion = 1;
    const contentDigest = await cloudBrainContentDigest(content);
    const contentVersion = await sourceVersionDigest({
      sourceId,
      versions: [{ id: versionId, version: 1, contentHash }],
    });
    const referenceSetDigest = await cloudReferenceSetDigest({
      sourceId,
      sourceVersionId: versionId,
      objectRefIds: refs,
    });
    const sourceVersion = await cloudBrainSourceVersion({
      protocolVersion: 'cloud-ingest-v2',
      sourceId,
      sourceVersionId: versionId,
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      contentDigest,
      objectRefIds: refs,
      referenceStateVersion,
    });
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      await client.query(
        `INSERT INTO cloud_sync_rows(tenant_id,workspace_id,table_name,row_id,fields)
        VALUES ($1,$2,'brain_sources',$3,$4::jsonb),($1,$2,'brain_source_versions',$5,$6::jsonb)`,
        [
          TENANT_A,
          WORKSPACE_A,
          sourceId,
          JSON.stringify({ cloud_object_ref_ids: { value: refs } }),
          versionId,
          JSON.stringify({
            source_id: { value: sourceId },
            version: { value: 1 },
            content_hash: { value: contentHash },
            content_text: { value: content },
          }),
        ],
      );
      await client.query(
        `INSERT INTO cloud_source_ingestions(tenant_id,workspace_id,id,source_id,actor_id,mode,status,
          content_version,source_version,source_version_id,content_digest,reference_state_version,snapshot_digest,
          reference_state,object_ref_ids,finalized_at)
        VALUES ($1,$2,$3,$4,$5,'text_only','finalized',$6,$7,$8,$9,$10,$11,'verified_empty','{}',now())`,
        [
          TENANT_A,
          WORKSPACE_A,
          ingestionId,
          sourceId,
          USER_A,
          contentVersion,
          sourceVersion,
          versionId,
          contentDigest,
          referenceStateVersion,
          referenceSetDigest,
        ],
      );
      await client.query(
        `INSERT INTO cloud_erasure_reference_sets(tenant_id,workspace_id,snapshot_id,source_kind,source_id,
          source_version,snapshot_digest,reference_state_version,object_ids,current,ingestion_id,content_version,completeness)
        VALUES ($1,$2,$3,'brain_source',$4,$5,$6,$7,'{}',true,$8,$9,'verified_empty')`,
        [
          TENANT_A,
          WORKSPACE_A,
          crypto.randomUUID(),
          sourceId,
          sourceVersion,
          referenceSetDigest,
          referenceStateVersion,
          ingestionId,
          contentVersion,
        ],
      );
      await expect(currentBrainIngestionSnapshot(client, TENANT_A, WORKSPACE_A, sourceId)).resolves.toEqual({
        sourceVersion,
        contentDigest,
        referenceSetDigest,
        referenceStateVersion,
        objectRefIds: [],
      });
      await client.query(
        `INSERT INTO cloud_erasure_operations(tenant_id,workspace_id,id,erasure_id,source_kind,source_id,
          source_version,request_digest,actor_id,capability_id,approval_id,status,reference_state_version,hold_state_version,
          reservation_id,reservation_expires_at,receipt_id)
        VALUES ($1,$2,$3,$4,'brain_source',$5,$6,$7,$8,'brain.sources.erase',$9,'eligible','{}','{}',$10,now()+interval '5 minutes',$11)`,
        [
          TENANT_A,
          WORKSPACE_A,
          operationId,
          erasureId,
          sourceId,
          sourceVersion,
          'd'.repeat(64),
          USER_A,
          approvalId,
          reservationId,
          crypto.randomUUID(),
        ],
      );
      await client.query(
        `INSERT INTO cloud_erasure_attempts(tenant_id,workspace_id,operation_id,attempt_id,attempt_no,
          request_digest,approval_id,approval_input_hash,approval_scope_hash)
        VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8)`,
        [
          TENANT_A,
          WORKSPACE_A,
          operationId,
          attemptId,
          'd'.repeat(64),
          approvalId,
          'a'.repeat(64),
          'b'.repeat(64),
        ],
      );
      const claimed = await claimLocalErasurePurge(
        client,
        TENANT_A,
        WORKSPACE_A,
        operationId,
        attemptId,
        reservationId,
        false,
      );
      expect(claimed).toMatchObject({ ok: true, claimGeneration: 1, replayed: false });
      if (claimed.ok) {
        expect(
          await claimLocalErasurePurge(
            client,
            TENANT_A,
            WORKSPACE_A,
            operationId,
            attemptId,
            reservationId,
            false,
          ),
        ).toEqual({ ...claimed, replayed: true });
      }
      const expiredOperation = '13131313-1313-4313-8313-131313131313';
      const expiredErasure = '14141414-1414-4414-8414-141414141414';
      const expiredAttempt = '15151515-1515-4515-8515-151515151515';
      const expiredApproval = '16161616-1616-4616-8616-161616161616';
      const expiredReservation = '17171717-1717-4717-8717-171717171717';
      await client.query(
        `INSERT INTO cloud_erasure_operations(tenant_id,workspace_id,id,erasure_id,source_kind,source_id,
          source_version,request_digest,actor_id,capability_id,approval_id,status,reference_state_version,hold_state_version,
          reservation_id,reservation_expires_at,receipt_id)
        VALUES ($1,$2,$3,$4,'brain_source',$5,$6,$7,$8,'brain.sources.erase',$9,'eligible','{}','{}',$10,now()-interval '1 second',$11)`,
        [
          TENANT_A,
          WORKSPACE_A,
          expiredOperation,
          expiredErasure,
          sourceId,
          sourceVersion,
          'e'.repeat(64),
          USER_A,
          expiredApproval,
          expiredReservation,
          crypto.randomUUID(),
        ],
      );
      await client.query(
        `INSERT INTO cloud_erasure_attempts(tenant_id,workspace_id,operation_id,attempt_id,attempt_no,
          request_digest,approval_id,approval_input_hash,approval_scope_hash)
        VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8)`,
        [
          TENANT_A,
          WORKSPACE_A,
          expiredOperation,
          expiredAttempt,
          'e'.repeat(64),
          expiredApproval,
          'c'.repeat(64),
          'b'.repeat(64),
        ],
      );
      expect(
        await claimLocalErasurePurge(
          client,
          TENANT_A,
          WORKSPACE_A,
          expiredOperation,
          expiredAttempt,
          expiredReservation,
          false,
        ),
      ).toEqual({ ok: false, code: 'RESERVATION_EXPIRED' });
      const newerVersionId = '18181818-1818-4818-8818-181818181818';
      await client.query(
        `INSERT INTO cloud_sync_rows(tenant_id,workspace_id,table_name,row_id,fields)
        VALUES ($1,$2,'brain_source_versions',$3,$4::jsonb)`,
        [
          TENANT_A,
          WORKSPACE_A,
          newerVersionId,
          JSON.stringify({
            source_id: { value: sourceId },
            version: { value: 2 },
            content_hash: { value: '1'.repeat(64) },
            content_text: { value: 'updated source text' },
          }),
        ],
      );
      await expect(currentBrainIngestionSnapshot(client, TENANT_A, WORKSPACE_A, sourceId)).rejects.toThrow(
        'SOURCE_STATE_UNAVAILABLE',
      );
    });
    await scoped(TENANT_B, WORKSPACE_B, async (client) => {
      await expect(currentBrainIngestionSnapshot(client, TENANT_B, WORKSPACE_B, sourceId)).rejects.toThrow(
        'SOURCE_REFERENCES_UNAVAILABLE',
      );
    });
  });

  it('keeps content-free erasure fences scoped and rejects stale row replay', async () => {
    const erasedSource = '99999999-9999-4999-8999-999999999999';
    const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const digest = `cloud-ingest-v2:sha256:${'f'.repeat(64)}`;
    const requestDigest = 'e'.repeat(64);
    const rowId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      await client.query(
        `INSERT INTO cloud_erasure_operations(tenant_id,workspace_id,id,erasure_id,source_kind,source_id,
          source_version,request_digest,actor_id,capability_id,approval_id,status,receipt_id)
         VALUES ($1,$2,$3,$4,'brain_source',$5,$6,$7,$8,'brain.sources.erase',$9,'completed',$10)`,
        [
          TENANT_A,
          WORKSPACE_A,
          operationId,
          operationId,
          erasedSource,
          digest,
          requestDigest,
          USER_A,
          TEST_APPROVAL,
          operationId,
        ],
      );
      await client.query(
        `INSERT INTO cloud_erasure_source_fences(tenant_id,workspace_id,source_kind,source_id,
          table_name,row_id,operation_id,erased_source_version)
         VALUES ($1,$2,'brain_source',$3,'brain_sources',$4,$5,$6)`,
        [TENANT_A, WORKSPACE_A, erasedSource, rowId, operationId, digest],
      );
      expect(
        await hasErasureFence(client, TENANT_A, WORKSPACE_A, [{ table: 'brain_sources', id: rowId }]),
      ).toBe(true);
      expect(
        await hasErasureFence(client, TENANT_A, WORKSPACE_A, [{ table: 'brain_sources', id: ROW }]),
      ).toBe(false);
    });
    await scoped(TENANT_B, WORKSPACE_B, async (client) => {
      expect(
        await hasErasureFence(client, TENANT_B, WORKSPACE_B, [{ table: 'brain_sources', id: rowId }]),
      ).toBe(false);
    });
  });

  it('creates only a restricted NOLOGIN runtime placeholder when no credential is provisioned', async () => {
    const isolated = new PGlite();
    try {
      await applyPGliteMigrations(isolated, migrations);
      const role = await isolated.query<{
        login: boolean;
        superuser: boolean;
        createdb: boolean;
        createrole: boolean;
        bypassrls: boolean;
        membership_count: number;
        inherit_option: boolean;
        set_option: boolean;
        admin_option: boolean;
      }>(`
        SELECT r.rolcanlogin AS login,r.rolsuper AS superuser,r.rolcreatedb AS createdb,
          r.rolcreaterole AS createrole,r.rolbypassrls AS bypassrls,
          (SELECT count(*)::int FROM pg_auth_members m WHERE m.member=r.oid) AS membership_count,
          m.inherit_option,m.set_option,m.admin_option
        FROM pg_roles r JOIN pg_roles bundle ON bundle.rolname='xyra_app_login'
        LEFT JOIN pg_auth_members m ON m.member=r.oid AND m.roleid=bundle.oid
        WHERE r.rolname='xyra_cloud_runtime_app'
      `);
      expect(role.rows[0]).toEqual({
        login: false,
        superuser: false,
        createdb: false,
        createrole: false,
        bypassrls: false,
        membership_count: 1,
        inherit_option: true,
        set_option: false,
        admin_option: false,
      });
    } finally {
      await isolated.close();
    }
  });

  it('uses the least-privilege Worker role and ordered sync migration', async () => {
    const role = await db.query<{
      app_login: boolean;
      bundle_login: boolean;
      bundle_super: boolean;
      bundle_createdb: boolean;
      bundle_createrole: boolean;
      bundle_bypassrls: boolean;
      bundle_owned_objects: number;
      runtime_super: boolean;
      runtime_createdb: boolean;
      runtime_createrole: boolean;
      runtime_bypassrls: boolean;
      runtime_memberships: number;
      inherit_option: boolean;
      set_option: boolean;
      admin_option: boolean;
      can_change_sequence: boolean;
      can_change_owner: boolean;
      can_delete_conflict: boolean;
      can_delete_sync_row: boolean;
      can_delete_field_seq: boolean;
      can_delete_change: boolean;
      can_delete_idempotency: boolean;
      can_delete_sync_ref: boolean;
      can_delete_blob_ref: boolean;
      can_delete_reference_set: boolean;
      can_delete_ingestion: boolean;
      can_delete_ingestion_object: boolean;
      can_update_sync_fields: boolean;
      can_update_sync_tenant: boolean;
      can_insert_webhook: boolean;
      can_delete_webhook: boolean;
      can_update_cron_result: boolean;
      can_update_cron_started: boolean;
      can_delete_expired_replay: boolean;
      default_acls: number;
    }>(`
      SELECT
        runtime.rolsuper AS runtime_super,runtime.rolcreatedb AS runtime_createdb,
        runtime.rolcreaterole AS runtime_createrole,runtime.rolbypassrls AS runtime_bypassrls,
        bundle.rolcanlogin AS bundle_login,bundle.rolsuper AS bundle_super,
        bundle.rolcreatedb AS bundle_createdb,bundle.rolcreaterole AS bundle_createrole,
        bundle.rolbypassrls AS bundle_bypassrls,
        EXISTS(SELECT 1 FROM pg_roles WHERE rolname='xyra_app_login' AND rolcanlogin) AS app_login,
        (SELECT count(*)::int FROM pg_auth_members WHERE member=runtime.oid) AS runtime_memberships,
        membership.inherit_option,membership.set_option,membership.admin_option,
        (SELECT count(*)::int FROM pg_class WHERE relowner=bundle.oid) +
        (SELECT count(*)::int FROM pg_proc WHERE proowner=bundle.oid) +
        (SELECT count(*)::int FROM pg_namespace WHERE nspowner=bundle.oid) +
        (SELECT count(*)::int FROM pg_type WHERE typowner=bundle.oid) AS bundle_owned_objects,
        has_column_privilege(runtime.rolname,'cloud_sync_sequences','last_seq','UPDATE') AS can_change_sequence,
        has_column_privilege(runtime.rolname,'cloud_sync_rows','tenant_id','UPDATE') AS can_change_owner,
        has_table_privilege(runtime.rolname,'cloud_sync_conflicts','DELETE') AS can_delete_conflict,
        has_table_privilege(runtime.rolname,'cloud_sync_rows','DELETE') AS can_delete_sync_row,
        has_table_privilege(runtime.rolname,'cloud_sync_field_seq','DELETE') AS can_delete_field_seq,
        has_table_privilege(runtime.rolname,'cloud_sync_changes','DELETE') AS can_delete_change,
        has_table_privilege(runtime.rolname,'cloud_sync_idempotency','DELETE') AS can_delete_idempotency,
        has_table_privilege(runtime.rolname,'cloud_sync_refs','DELETE') AS can_delete_sync_ref,
        has_table_privilege(runtime.rolname,'cloud_erasure_refs','DELETE') AS can_delete_blob_ref,
        has_table_privilege(runtime.rolname,'cloud_erasure_reference_sets','DELETE') AS can_delete_reference_set,
        has_table_privilege(runtime.rolname,'cloud_source_ingestions','DELETE') AS can_delete_ingestion,
        has_table_privilege(runtime.rolname,'cloud_source_ingestion_objects','DELETE') AS can_delete_ingestion_object,
        has_column_privilege(runtime.rolname,'cloud_sync_rows','fields','UPDATE') AS can_update_sync_fields,
        has_column_privilege(runtime.rolname,'cloud_sync_rows','tenant_id','UPDATE') AS can_update_sync_tenant,
        has_table_privilege(runtime.rolname,'cloud_webhook_receipts','INSERT') AS can_insert_webhook,
        has_table_privilege(runtime.rolname,'cloud_webhook_receipts','DELETE') AS can_delete_webhook,
        has_column_privilege(runtime.rolname,'cloud_cron_runs','outcome','UPDATE') AS can_update_cron_result,
        has_column_privilege(runtime.rolname,'cloud_cron_runs','started_at','UPDATE') AS can_update_cron_started,
        has_table_privilege(runtime.rolname,'cloud_dpop_replays','DELETE') AS can_delete_expired_replay,
        (SELECT count(*)::int FROM pg_default_acl WHERE defaclrole IN (runtime.oid,bundle.oid)) AS default_acls
      FROM pg_roles runtime
      JOIN pg_roles bundle ON bundle.rolname='xyra_app_login'
      LEFT JOIN pg_auth_members membership ON membership.member=runtime.oid AND membership.roleid=bundle.oid
      WHERE runtime.rolname='xyra_cloud_runtime_app'
    `);
    expect(role.rows[0]).toEqual({
      app_login: false,
      bundle_login: false,
      bundle_super: false,
      bundle_createdb: false,
      bundle_createrole: false,
      bundle_bypassrls: false,
      bundle_owned_objects: 0,
      runtime_super: false,
      runtime_createdb: false,
      runtime_createrole: false,
      runtime_bypassrls: false,
      runtime_memberships: 1,
      inherit_option: true,
      set_option: false,
      admin_option: false,
      can_change_sequence: true,
      can_change_owner: false,
      can_delete_conflict: true,
      can_delete_sync_row: true,
      can_delete_field_seq: true,
      can_delete_change: true,
      can_delete_idempotency: true,
      can_delete_sync_ref: true,
      can_delete_blob_ref: true,
      can_delete_reference_set: true,
      can_delete_ingestion: true,
      can_delete_ingestion_object: true,
      can_update_sync_fields: true,
      can_update_sync_tenant: false,
      can_insert_webhook: true,
      can_delete_webhook: false,
      can_update_cron_result: true,
      can_update_cron_started: false,
      can_delete_expired_replay: true,
      default_acls: 0,
    });
    const rls = await db.query<{ total: number; forced: number }>(`
      SELECT count(*)::int AS total,count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'cloud_sync_%'
    `);
    expect(rls.rows[0]).toEqual({ total: 8, forced: 8 });
    const order = await db.query<{ version: string }>(
      `SELECT id AS version FROM schema_migrations WHERE id IN ('core/0001_cloud_auth','core/0002_cloud_sync','core/0003_cloud_erasure','core/0004_cloud_blob_reference_sets','core/0005_cloud_ingestion_finalization','core/0006_cloud_ingestion_v2_hashes','core/0007_cloud_erasure_v2_fence','core/0008_cloud_erasure_sync_delete','core/0009_cloud_erasure_provenance_delete','core/0010_cloud_erasure_deleting_state') ORDER BY id`,
    );
    expect(order.rows.map((row) => row.version)).toEqual([
      'core/0001_cloud_auth',
      'core/0002_cloud_sync',
      'core/0003_cloud_erasure',
      'core/0004_cloud_blob_reference_sets',
      'core/0005_cloud_ingestion_finalization',
      'core/0006_cloud_ingestion_v2_hashes',
      'core/0007_cloud_erasure_v2_fence',
      'core/0008_cloud_erasure_sync_delete',
      'core/0009_cloud_erasure_provenance_delete',
      'core/0010_cloud_erasure_deleting_state',
    ]);
  });

  it('migrates the Invest inbox with scoped RLS and keeps the source allowlist read-only to the Worker', async () => {
    const sourceId = '71717171-7171-4171-8171-717171717171';
    const keyId = '72727272-7272-4272-8272-727272727272';
    const eventId = crypto.randomUUID();
    const eventRecordId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    await db.query(
      `INSERT INTO cloud_invest_signal_sources
        (tenant_id,workspace_id,source_id,key_id,signing_alg,public_jwk,allowed_algorithm_ids,allowed_symbols)
       VALUES ($1,$2,$3,$4,'ES256','{"kty":"EC","crv":"P-256","x":"${'a'.repeat(43)}","y":"${'b'.repeat(43)}"}'::jsonb,
               ARRAY['paper-alpha'],ARRAY['ACME'])`,
      [TENANT_A, WORKSPACE_A, sourceId, keyId],
    );
    await expect(
      db.query(
        `INSERT INTO cloud_invest_signal_sources
          (tenant_id,workspace_id,source_id,key_id,signing_alg,public_jwk,allowed_algorithm_ids,allowed_symbols)
         VALUES ($1,$2,$3,$4,'ES256',$5::jsonb,ARRAY['paper-alpha'],ARRAY['ACME'])`,
        [
          TENANT_A,
          WORKSPACE_A,
          sourceId,
          crypto.randomUUID(),
          JSON.stringify({
            kty: 'EC',
            crv: 'P-256',
            x: 'a'.repeat(43),
            y: 'b'.repeat(43),
            d: 'c'.repeat(43),
          }),
        ],
      ),
    ).rejects.toThrow('cloud_invest_signal_sources_public_jwk_only');
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      const resolution = await client.query<Record<string, unknown>>(
        `SELECT source_id::text,key_id::text,signing_alg,public_jwk,active
           FROM cloud_invest_signal_resolution WHERE source_id=$1 AND key_id=$2`,
        [sourceId, keyId],
      );
      expect(resolution.rows).toHaveLength(1);
      expect(Object.keys(resolution.rows[0] ?? {}).sort()).toEqual([
        'active',
        'key_id',
        'public_jwk',
        'signing_alg',
        'source_id',
      ]);
      expect(resolution.rows[0]).not.toHaveProperty('tenant_id');
      expect(resolution.rows[0]).not.toHaveProperty('allowed_symbols');
      const policyHidden = await client.query(
        'SELECT tenant_id,allowed_symbols FROM cloud_invest_signal_sources WHERE source_id=$1 AND key_id=$2',
        [sourceId, keyId],
      );
      expect(policyHidden.rows).toHaveLength(0);
      await client.query("SELECT set_config('app.invest_signal_source_id',$1,true)", [sourceId]);
      await client.query("SELECT set_config('app.invest_signal_key_id',$1,true)", [keyId]);
      const policyScoped = await client.query(
        'SELECT tenant_id::text,workspace_id::text,allowed_symbols,max_events_per_minute FROM cloud_invest_signal_sources WHERE source_id=$1 AND key_id=$2',
        [sourceId, keyId],
      );
      expect(policyScoped.rows).toEqual([
        {
          tenant_id: TENANT_A,
          workspace_id: WORKSPACE_A,
          allowed_symbols: ['ACME'],
          max_events_per_minute: 60,
        },
      ]);
      await client.query(
        `INSERT INTO cloud_invest_signal_rate_windows(tenant_id,workspace_id,source_id,window_start,request_count)
         VALUES ($1,$2,$3,date_trunc('minute',now()),1)`,
        [TENANT_A, WORKSPACE_A, sourceId],
      );
      await client.query(
        `INSERT INTO cloud_invest_signal_events
          (id,tenant_id,workspace_id,source_id,key_id,event_id,payload_digest,envelope,event_expires_at,status)
         VALUES ($1,$2,$3,$4,$5,$6,decode($7,'hex'),$8::jsonb,now()+interval '5 minutes','pending')`,
        [
          eventRecordId,
          TENANT_A,
          WORKSPACE_A,
          sourceId,
          keyId,
          eventId,
          'a'.repeat(64),
          JSON.stringify({
            protocol: 'xyra.invest.signal.v1',
            eventId,
            sourceId,
            tenantId: TENANT_A,
            workspaceId: WORKSPACE_A,
            payloadDigest: 'a'.repeat(64),
            verification: { signature: 'verified', keyId },
          }),
        ],
      );
      await client.query(
        `INSERT INTO cloud_queue_jobs(id,tenant_id,workspace_id,job_type,idempotency_key,payload,status)
         VALUES ($1,$2,$3,'invest.signal.received',$4,$5::jsonb,'pending')`,
        [
          jobId,
          TENANT_A,
          WORKSPACE_A,
          `${sourceId}:${eventId}`,
          JSON.stringify({ eventRecordId, payloadDigest: 'a'.repeat(64) }),
        ],
      );
      await client.query(
        'UPDATE cloud_invest_signal_events SET queue_job_id=$4 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3',
        [TENANT_A, WORKSPACE_A, eventRecordId, jobId],
      );
      await client.query('SAVEPOINT invalid_signal_ack');
      await expect(
        client.query(
          `UPDATE cloud_invest_signal_events
              SET status='acked',claim_device_id=$3,lease_id=$4,lease_fence=1,
                  lease_expires_at=now()+interval '1 minute',ack_idempotency_key=$5,acked_at=now()
            WHERE id=$1 AND tenant_id=$2`,
          [eventRecordId, TENANT_A, USER_A, crypto.randomUUID(), crypto.randomUUID()],
        ),
      ).rejects.toThrow('cloud_invest_signal_events_ack_decision_consistent');
      await client.query('ROLLBACK TO SAVEPOINT invalid_signal_ack');
      const visible = await client.query('SELECT id FROM cloud_invest_signal_events WHERE tenant_id=$1', [
        TENANT_A,
      ]);
      expect(visible.rows).toHaveLength(1);
      const hidden = await client.query('SELECT id FROM cloud_invest_signal_events WHERE tenant_id=$1', [
        TENANT_B,
      ]);
      expect(hidden.rows).toHaveLength(0);
    });
    await scoped(TENANT_B, WORKSPACE_B, async (client) => {
      const hidden = await client.query('SELECT id FROM cloud_invest_signal_events WHERE id=$1', [
        eventRecordId,
      ]);
      expect(hidden.rows).toHaveLength(0);
      await expect(
        client.query(
          `INSERT INTO cloud_invest_signal_events
          (id,tenant_id,workspace_id,source_id,key_id,event_id,payload_digest,envelope,event_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,decode($7,'hex'),'{}'::jsonb,now()+interval '1 minute')`,
          [crypto.randomUUID(), TENANT_A, WORKSPACE_A, sourceId, keyId, crypto.randomUUID(), 'b'.repeat(64)],
        ),
      ).rejects.toThrow();
    });
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      await expect(
        client.query('UPDATE cloud_invest_signal_sources SET active=false WHERE source_id=$1', [sourceId]),
      ).rejects.toThrow();
    });
    // The denied UPDATE above aborts its transaction. Retire this RLS fixture as owner so
    // the later claim test cannot treat its intentionally minimal envelope as pending.
    await db.query("UPDATE cloud_invest_signal_events SET status='expired' WHERE id=$1", [eventRecordId]);
    await db.query('UPDATE cloud_invest_signal_sources SET active=false WHERE source_id=$1 AND key_id=$2', [
      sourceId,
      keyId,
    ]);
    const inactiveResolution = await db.query<{ active: boolean }>(
      'SELECT active FROM cloud_invest_signal_resolution WHERE source_id=$1 AND key_id=$2',
      [sourceId, keyId],
    );
    expect(inactiveResolution.rows[0]?.active).toBe(false);
    const privileges = await db.query<{
      source_delete: boolean;
      event_delete: boolean;
      source_update: boolean;
      resolution_select: boolean;
      resolution_insert: boolean;
      resolution_update: boolean;
      resolution_delete: boolean;
    }>(`
      SELECT has_table_privilege('xyra_cloud_runtime_app','cloud_invest_signal_sources','DELETE') AS source_delete,
             has_table_privilege('xyra_cloud_runtime_app','cloud_invest_signal_events','DELETE') AS event_delete,
             has_table_privilege('xyra_cloud_runtime_app','cloud_invest_signal_sources','UPDATE') AS source_update,
             has_table_privilege('xyra_cloud_runtime_app','cloud_invest_signal_resolution','SELECT') AS resolution_select,
             has_table_privilege('xyra_cloud_runtime_app','cloud_invest_signal_resolution','INSERT') AS resolution_insert,
             has_table_privilege('xyra_cloud_runtime_app','cloud_invest_signal_resolution','UPDATE') AS resolution_update,
             has_table_privilege('xyra_cloud_runtime_app','cloud_invest_signal_resolution','DELETE') AS resolution_delete`);
    expect(privileges.rows[0]).toEqual({
      source_delete: false,
      event_delete: false,
      source_update: false,
      resolution_select: true,
      resolution_insert: false,
      resolution_update: false,
      resolution_delete: false,
    });
  });

  it('commits signed inbox and ID-only outbox atomically, then fences claim replay and stale device ack', async () => {
    const sourceId = '73737373-7373-4373-8373-737373737373';
    const keyId = '74747474-7474-4474-8474-747474747474';
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const source: InvestSignalSourceKey = {
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      sourceId,
      keyId,
      signingAlg: 'ES256',
      publicJwk,
      allowedAlgorithmIds: ['paper-alpha'],
      allowedSymbols: ['ACME'],
      maxAgeSeconds: 300,
      maxLifetimeSeconds: 900,
      maxEventsPerMinute: 4,
    };
    await db.query(
      `INSERT INTO cloud_invest_signal_sources
        (tenant_id,workspace_id,source_id,key_id,signing_alg,public_jwk,allowed_algorithm_ids,allowed_symbols,
         max_age_seconds,max_lifetime_seconds,max_events_per_minute)
       VALUES ($1,$2,$3,$4,'ES256',$5::jsonb,ARRAY['paper-alpha'],ARRAY['ACME'],300,900,4)`,
      [TENANT_A, WORKSPACE_A, sourceId, keyId, JSON.stringify(publicJwk)],
    );
    const createWebhook = async (body: InvestSignalBody): Promise<RawInvestWebhook> => {
      const rawBody = new TextEncoder().encode(JSON.stringify(body));
      const timestampSeconds = Math.floor(Date.now() / 1000);
      const prefix = new TextEncoder().encode(`${timestampSeconds}.`);
      const signed = new Uint8Array(prefix.length + rawBody.length);
      signed.set(prefix);
      signed.set(rawBody, prefix.length);
      const signature = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signed),
      );
      return { sourceId, keyId, timestampSeconds, rawBody, signature };
    };
    const makeBody = (eventId: string, quantity = '1.25'): InvestSignalBody => {
      const now = Date.now();
      return {
        protocol: INVEST_SIGNAL_PROTOCOL,
        eventId,
        occurredAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 300_000).toISOString(),
        algorithmId: 'paper-alpha',
        signalId: crypto.randomUUID(),
        symbol: 'ACME',
        side: 'buy',
        quantity,
      };
    };
    const webhook = await createWebhook(makeBody('atomic-event-001'));
    const accepted = await scoped(TENANT_A, WORKSPACE_A, (client) =>
      acceptInvestSignalInTransaction(client, webhook, source),
    );
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('expected accepted signal');
    const storedEnvelope = await scoped(TENANT_A, WORKSPACE_A, (client) =>
      client.query<{ envelope: unknown }>('SELECT envelope FROM cloud_invest_signal_events WHERE id=$1', [
        accepted.eventRecordId,
      ]),
    );
    expect(storedEnvelope.rows[0]?.envelope).toMatchObject({
      eventId: 'atomic-event-001',
      receivedAt: expect.any(String),
      signalId: expect.any(String),
    });
    expect(storedEnvelope.rows[0]?.envelope).toMatchObject({
      verification: { signature: 'verified', keyId, signingAlg: 'ES256' },
      envelopeDigestVersion: 'xyra.invest.envelope.digest.v1',
      envelopeDigestAlgorithm: 'SHA-256',
      envelopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await verifyInvestSignalEnvelopeDigest(accepted.envelope)).toBe(true);
    const mutatedEnvelopes = [
      { ...accepted.envelope, quantity: '9.99' },
      { ...accepted.envelope, tenantId: TENANT_B },
      { ...accepted.envelope, workspaceId: WORKSPACE_B },
      {
        ...accepted.envelope,
        verification: { ...accepted.envelope.verification, keyId: '75757575-7575-4575-8575-757575757575' },
      },
    ];
    for (const mutatedEnvelope of mutatedEnvelopes) {
      expect(mutatedEnvelope.payloadDigest).toBe(accepted.envelope.payloadDigest);
      expect(await verifyInvestSignalEnvelopeDigest(mutatedEnvelope)).toBe(false);
    }
    const duplicate = await scoped(TENANT_A, WORKSPACE_A, (client) =>
      acceptInvestSignalInTransaction(client, webhook, source),
    );
    expect(duplicate).toMatchObject({
      kind: 'duplicate',
      jobId: accepted.jobId,
      eventRecordId: accepted.eventRecordId,
    });
    const conflictingWebhook = await createWebhook(makeBody('atomic-event-001', '2'));
    expect(
      await scoped(TENANT_A, WORKSPACE_A, (client) =>
        acceptInvestSignalInTransaction(client, conflictingWebhook, source),
      ),
    ).toEqual({ kind: 'conflict' });

    const consumerA = {
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      principalId: USER_A,
      deviceId: '75757575-7575-4575-8575-757575757575',
    };
    const consumerB = { ...consumerA, deviceId: '76767676-7676-4676-8676-767676767676' };
    const claimInput = {
      protocol: INVEST_SIGNAL_CONSUME_PROTOCOL,
      idempotencyKey: crypto.randomUUID(),
    } as const;
    const claim = await scoped(TENANT_A, WORKSPACE_A, (client) =>
      claimInvestSignalInTransaction(client, consumerA, claimInput),
    );
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') throw new Error('expected a signal claim');
    const claimReplay = await scoped(TENANT_A, WORKSPACE_A, (client) =>
      claimInvestSignalInTransaction(client, consumerA, claimInput),
    );
    expect(claimReplay.status).toBe('claimed');
    if (claimReplay.status !== 'claimed') throw new Error('expected idempotent claim replay');
    expect(claimReplay.lease).toEqual(claim.lease);
    expect(
      await scoped(TENANT_A, WORKSPACE_A, (client) =>
        claimInvestSignalInTransaction(client, consumerB, {
          ...claimInput,
          idempotencyKey: crypto.randomUUID(),
        }),
      ),
    ).toEqual({ status: 'empty' });

    await db.query(
      "UPDATE cloud_invest_signal_events SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [accepted.eventRecordId],
    );
    const reclaimed = await scoped(TENANT_A, WORKSPACE_A, (client) =>
      claimInvestSignalInTransaction(client, consumerB, {
        ...claimInput,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    expect(reclaimed.status).toBe('claimed');
    if (reclaimed.status !== 'claimed') throw new Error('expected fenced reclaim');
    expect(reclaimed.lease.fence).toBeGreaterThan(claim.lease.fence);

    const ackBase = {
      protocol: INVEST_SIGNAL_CONSUME_PROTOCOL,
      eventId: 'atomic-event-001',
      payloadDigest: accepted.envelope.payloadDigest,
      envelopeDigestVersion: accepted.envelope.envelopeDigestVersion,
      envelopeDigestAlgorithm: accepted.envelope.envelopeDigestAlgorithm,
      envelopeDigest: accepted.envelope.envelopeDigest,
      decisionId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
    } as const;
    await expect(
      scoped(TENANT_A, WORKSPACE_A, (client) =>
        acknowledgeInvestSignalInTransaction(client, consumerA, { ...ackBase, leaseId: claim.lease.leaseId }),
      ),
    ).rejects.toThrow('SIGNAL_LEASE_INVALID');
    await expect(
      scoped(TENANT_A, WORKSPACE_A, (client) =>
        acknowledgeInvestSignalInTransaction(client, consumerB, {
          ...ackBase,
          envelopeDigest: '0'.repeat(64),
          leaseId: reclaimed.lease.leaseId,
        }),
      ),
    ).rejects.toThrow('SIGNAL_ENVELOPE_DIGEST_MISMATCH');
    const ack = await scoped(TENANT_A, WORKSPACE_A, (client) =>
      acknowledgeInvestSignalInTransaction(client, consumerB, {
        ...ackBase,
        leaseId: reclaimed.lease.leaseId,
      }),
    );
    expect(ack.replayed).toBe(false);
    expect(
      await scoped(TENANT_A, WORKSPACE_A, (client) =>
        acknowledgeInvestSignalInTransaction(client, consumerB, {
          ...ackBase,
          leaseId: reclaimed.lease.leaseId,
        }),
      ),
    ).toMatchObject({ replayed: true, status: 'acked' });

    const durable = await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      const events = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM cloud_invest_signal_events WHERE id=$1`,
        [accepted.eventRecordId],
      );
      const jobs = await client.query<{ payload: unknown; job_type: string }>(
        `SELECT payload,job_type FROM cloud_queue_jobs WHERE id=$1`,
        [accepted.jobId],
      );
      return { events: events.rows[0]?.count, jobs: jobs.rows[0] };
    });
    expect(durable.events).toBe('1');
    expect(durable.jobs?.job_type).toBe('invest.signal.received');
    expect(durable.jobs?.payload).toEqual({
      eventRecordId: accepted.eventRecordId,
      payloadDigest: accepted.envelope.payloadDigest,
    });
  });

  it('atomically commits row state, per-field sequence, compacted pull log, conflict and cache outbox', async () => {
    const first = pushRequest('first', Date.now() - 10, 'first-key-sync-0001');
    const second = pushRequest('second', Date.now(), 'second-key-sync-0002');
    expect(first && second).toBeTruthy();
    let committedServerSeq = '';
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      await lockWorkspaceSequence(client, TENANT_A, WORKSPACE_A);
      const seqState = await client.query<{ last_seq: number }>(
        'SELECT last_seq FROM cloud_sync_sequences WHERE tenant_id=$1 AND workspace_id=$2',
        [TENANT_A, WORKSPACE_A],
      );
      const baseSeq = seqState.rows[0]?.last_seq ?? 0;
      await client.query(
        `UPDATE cloud_sync_outbox SET delivered_at=now()
        WHERE tenant_id=$1 AND workspace_id=$2 AND delivered_at IS NULL`,
        [TENANT_A, WORKSPACE_A],
      );
      const engine = new SyncAuthorityEngine(new NeonSyncStore(client, TENANT_A, WORKSPACE_A));
      await engine.push(access(TENANT_A, WORKSPACE_A), first!, Date.now(), await hashRequest(first!));
      const committed = await engine.push(
        access(TENANT_A, WORKSPACE_A),
        second!,
        Date.now(),
        await hashRequest(second!),
      );
      committedServerSeq = committed.serverSeq;
      const replayed = await engine.push(
        access(TENANT_A, WORKSPACE_A),
        second!,
        Date.now(),
        await hashRequest(second!),
      );
      expect(committed.serverSeq).toBe(String(baseSeq + 2));
      expect(replayed.replayed).toBe(true);
      const pull = await engine.pull(access(TENANT_A, WORKSPACE_A), undefined);
      expect(
        pull.ok && pull.response.changes.some((entry) => entry.change.fields['name']?.value === 'second'),
      ).toBe(true);
      return undefined;
    });
    const row = await db.query<{ fields: { name: { value: string } } }>(
      `SELECT fields FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2 AND row_id=$3`,
      [TENANT_A, WORKSPACE_A, ROW],
    );
    expect(row.rows[0]?.fields['name']?.value).toBe('second');
    const conflict = await db.query<{ record: { losingValue: string } }>(
      `SELECT record FROM cloud_sync_conflicts WHERE tenant_id=$1 AND workspace_id=$2`,
      [TENANT_A, WORKSPACE_A],
    );
    expect(conflict.rows.map((item) => item.record.losingValue)).toContain('first');
    const durable = await db.query<{ last_seq: number; changes: number; pending: number }>(
      `SELECT s.last_seq,
        (SELECT count(*)::int FROM cloud_sync_changes c WHERE c.tenant_id=s.tenant_id AND c.workspace_id=s.workspace_id) AS changes,
        (SELECT count(*)::int FROM cloud_sync_outbox o WHERE o.tenant_id=s.tenant_id AND o.workspace_id=s.workspace_id AND o.delivered_at IS NULL) AS pending
       FROM cloud_sync_sequences s WHERE s.tenant_id=$1 AND s.workspace_id=$2`,
      [TENANT_A, WORKSPACE_A],
    );
    expect(durable.rows[0]?.last_seq).toBe(Number(committedServerSeq));
    const changesForRow = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM cloud_sync_changes WHERE tenant_id=$1 AND workspace_id=$2 AND row_id=$3',
      [TENANT_A, WORKSPACE_A, ROW],
    );
    expect(changesForRow.rows[0]?.count).toBe(2);
    expect(durable.rows[0]?.pending).toBe(2);
    const log = await db.query<{ server_seq: number; change: { fields: Record<string, unknown> } }>(
      `SELECT server_seq,change FROM cloud_sync_changes WHERE tenant_id=$1 AND workspace_id=$2 AND row_id=$3 ORDER BY server_seq`,
      [TENANT_A, WORKSPACE_A, ROW],
    );
    expect(log.rows[0]?.change.fields).not.toHaveProperty('name');
    expect(log.rows[1]?.change.fields).toHaveProperty('name');

    const runScoped = <T>(
      _url: string,
      scope: { tenantId?: string; workspaceId?: string },
      operation: (client: NeonQueryClient) => Promise<T>,
    ) => scoped(scope.tenantId ?? '', scope.workspaceId ?? '', operation);
    let delivery = 0;
    const deliver = async (workspaceId: string, seq: string) => {
      expect(workspaceId).toBe(WORKSPACE_A);
      expect(seq).toBe(committedServerSeq);
      delivery += 1;
      return delivery === 2;
    };
    expect(await drainSyncOutbox('pglite://', deliver, 10, runScoped)).toEqual({
      delivered: 0,
      failed: 1,
      pruned: 0,
    });
    expect(await drainSyncOutbox('pglite://', deliver, 10, runScoped)).toEqual({
      delivered: 1,
      failed: 0,
      pruned: 0,
    });
    const outbox = await db.query<{ pending: number; attempts: number }>(
      `SELECT count(*) FILTER (WHERE delivered_at IS NULL)::int AS pending,sum(attempts)::int AS attempts
         FROM cloud_sync_outbox WHERE tenant_id=$1 AND workspace_id=$2 AND server_seq>=$3`,
      [TENANT_A, WORKSPACE_A, Number(committedServerSeq) - 1],
    );
    expect(outbox.rows[0]).toEqual({ pending: 0, attempts: 4 });

    // Old acknowledged invalidations are pruned, while canonical conflict and pull history remains.
    await db.query(
      `UPDATE cloud_sync_outbox SET delivered_at=now()-interval '31 days'
        WHERE tenant_id=$1 AND workspace_id=$2 AND server_seq>=$3`,
      [TENANT_A, WORKSPACE_A, Number(committedServerSeq) - 1],
    );
    expect(await drainSyncOutbox('pglite://', deliver, 10, runScoped)).toEqual({
      delivered: 0,
      failed: 0,
      pruned: 2,
    });
    const retained = await db.query<{ outbox: number; changes: number; conflicts: number }>(
      `SELECT
        (SELECT count(*)::int FROM cloud_sync_outbox WHERE tenant_id=$1 AND workspace_id=$2 AND server_seq>=$3) AS outbox,
        (SELECT count(*)::int FROM cloud_sync_changes WHERE tenant_id=$1 AND workspace_id=$2 AND row_id=$4) AS changes,
        (SELECT count(*)::int FROM cloud_sync_conflicts WHERE tenant_id=$1 AND workspace_id=$2) AS conflicts`,
      [TENANT_A, WORKSPACE_A, Number(committedServerSeq) - 1, ROW],
    );
    expect(retained.rows[0]).toEqual({ outbox: 0, changes: 2, conflicts: 1 });
  });

  it('prunes idempotency records older than the seven-day replay window only', async () => {
    const oldRequest = pushRequest('retention-old', Date.now(), 'retention-key-sync-0005')!;
    const recentRequest = pushRequest('retention-recent', Date.now() + 1, 'retention-key-sync-0006')!;
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      const engine = new SyncAuthorityEngine(new NeonSyncStore(client, TENANT_A, WORKSPACE_A));
      await lockWorkspaceSequence(client, TENANT_A, WORKSPACE_A);
      await engine.push(access(TENANT_A, WORKSPACE_A), oldRequest, Date.now(), await hashRequest(oldRequest));
      await engine.push(
        access(TENANT_A, WORKSPACE_A),
        recentRequest,
        Date.now(),
        await hashRequest(recentRequest),
      );
    });
    // Age the record as fixture setup with the migration owner, then exercise pruning as the
    // restricted runtime role in a tenant/workspace-scoped transaction.
    await db.query(
      `UPDATE cloud_sync_idempotency SET created_at=now()-interval '8 days'
        WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3`,
      [TENANT_A, WORKSPACE_A, `${TENANT_A}:${WORKSPACE_A}:${USER_A}:nodea:${oldRequest.idempotencyKey}`],
    );
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      await new NeonSyncStore(client, TENANT_A, WORKSPACE_A).pruneIdempotency(
        Date.now() - 7 * 24 * 3_600_000,
      );
    });
    const remaining = await db.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM cloud_sync_idempotency
        WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY idempotency_key`,
      [TENANT_A, WORKSPACE_A],
    );
    const keys = remaining.rows.map((row) => row.idempotency_key);
    expect(keys).not.toContain(`${TENANT_A}:${WORKSPACE_A}:${USER_A}:nodea:${oldRequest.idempotencyKey}`);
    expect(keys).toContain(`${TENANT_A}:${WORKSPACE_A}:${USER_A}:nodea:${recentRequest.idempotencyKey}`);
  });

  it('rolls back every canonical write if the transaction fails before commit', async () => {
    const request = pushRequest('rollback', Date.now(), 'rollback-key-sync-0003')!;
    const beforeRows = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2',
      [TENANT_A, WORKSPACE_A],
    );
    const before = await db.query<{ last_seq: number }>(
      'SELECT last_seq FROM cloud_sync_sequences WHERE tenant_id=$1 AND workspace_id=$2',
      [TENANT_A, WORKSPACE_A],
    );
    await expect(
      scoped(TENANT_A, WORKSPACE_A, async (client) => {
        await lockWorkspaceSequence(client, TENANT_A, WORKSPACE_A);
        await new SyncAuthorityEngine(new NeonSyncStore(client, TENANT_A, WORKSPACE_A)).push(
          access(TENANT_A, WORKSPACE_A),
          request,
          Date.now(),
          await hashRequest(request),
        );
        throw new Error('simulate post-write failure');
      }),
    ).rejects.toThrow('simulate post-write failure');
    const rows = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2',
      [TENANT_A, WORKSPACE_A],
    );
    expect(rows.rows[0]?.count).toBe(beforeRows.rows[0]?.count);
    const seq = await db.query<{ last_seq: number }>(
      'SELECT last_seq FROM cloud_sync_sequences WHERE tenant_id=$1 AND workspace_id=$2',
      [TENANT_A, WORKSPACE_A],
    );
    expect(seq.rows[0]?.last_seq).toBe(before.rows[0]?.last_seq);
  });

  it('filters canonical reads by RLS and refuses a cross-tenant write attempt', async () => {
    await scoped(TENANT_B, WORKSPACE_B, async (client) => {
      await lockWorkspaceSequence(client, TENANT_B, WORKSPACE_B);
      const request = parseSyncPush({
        protocolVersion: 1,
        schemaVersion: 'cloud-sync-v1',
        nodeId: 'nodea',
        idempotencyKey: 'tenant-b-key-sync-0004',
        changes: [
          {
            table: 'ops_projects',
            id: ROW,
            tenantId: TENANT_B,
            workspaceId: WORKSPACE_B,
            op: 'upsert',
            hlc: `${String(Date.now()).padStart(13, '0')}-0001-nodea`,
            fields: {
              name: {
                value: 'tenant b',
                hlc: `${String(Date.now()).padStart(13, '0')}-0001-nodea`,
                baseHlc: null,
              },
            },
          },
        ],
      })!;
      return new SyncAuthorityEngine(new NeonSyncStore(client, TENANT_B, WORKSPACE_B)).push(
        access(TENANT_B, WORKSPACE_B),
        request,
        Date.now(),
        await hashRequest(request),
      );
    });
    await db.exec('SET ROLE xyra_cloud_runtime_app');
    try {
      await db.query("SELECT set_config('app.tenant_id',$1,false)", [TENANT_A]);
      await db.query("SELECT set_config('app.workspace_id',$1,false)", [WORKSPACE_A]);
      const hidden = await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2',
        [TENANT_B, WORKSPACE_B],
      );
      expect(hidden.rows[0]?.count).toBe(0);
      const dispatchVisible = await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM cloud_sync_outbox WHERE tenant_id=$1 AND workspace_id=$2 AND delivered_at IS NULL',
        [TENANT_B, WORKSPACE_B],
      );
      expect(dispatchVisible.rows[0]?.count).toBe(1); // only invalidation metadata is globally readable
      const changed = await db.query(
        `UPDATE cloud_sync_outbox SET delivered_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND delivered_at IS NULL`,
        [TENANT_B, WORKSPACE_B],
      );
      expect(changed.rows).toHaveLength(0); // the cross-tenant dispatch policy is SELECT-only
      await expect(
        db.query(
          `INSERT INTO cloud_sync_rows(tenant_id,workspace_id,table_name,row_id,fields)
         VALUES ($1,$2,'ops_projects',$3,'{}'::jsonb)`,
          [TENANT_B, WORKSPACE_B, '88888888-8888-4888-8888-888888888888'],
        ),
      ).rejects.toThrow();
    } finally {
      await db.exec('RESET ROLE');
    }
    const tenantB = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM cloud_sync_rows WHERE tenant_id=$1 AND workspace_id=$2',
      [TENANT_B, WORKSPACE_B],
    );
    expect(tenantB.rows[0]?.count).toBe(1);
  });

  it('runtime login can only use the explicitly granted auth, webhook, Cron and expiry operations', async () => {
    await scoped(TENANT_A, WORKSPACE_A, async (client) => {
      const identity = await client.query('SELECT current_user');
      expect(identity.rows[0]?.current_user).toBe('xyra_cloud_runtime_app');
      await client.query(
        `INSERT INTO cloud_webhook_receipts(provider,event_id,payload_hash)
         VALUES ('probe','role-grant-probe-001',decode(repeat('ab',32),'hex'))`,
      );
      const receipt = await client.query(
        `SELECT 1 FROM cloud_webhook_receipts WHERE provider='probe' AND event_id='role-grant-probe-001'`,
      );
      expect(receipt.rows).toHaveLength(1);
      await client.query(
        `INSERT INTO cloud_cron_runs(job_name,window_start) VALUES ('role-grant-probe',now())`,
      );
      const updated = await client.query(
        `UPDATE cloud_cron_runs SET finished_at=now(),outcome='succeeded'
          WHERE job_name='role-grant-probe' RETURNING outcome`,
      );
      expect(updated.rows[0]?.outcome).toBe('succeeded');
      await client.query(
        `INSERT INTO cloud_dpop_replays(tenant_id,device_id,jti_hash,expires_at)
         VALUES ($1,$2,decode('aabb','hex'),now()-interval '1 second')`,
        [TENANT_A, '77777777-7777-4777-8777-777777777777'],
      );
      const expired = await client.query(
        `DELETE FROM cloud_dpop_replays WHERE tenant_id=$1 AND jti_hash=decode('aabb','hex') RETURNING 1`,
        [TENANT_A],
      );
      expect(expired.rows).toHaveLength(1);
      await expect(
        client.query(`DELETE FROM cloud_webhook_receipts WHERE provider='probe'`),
      ).rejects.toThrow();
    });
  });
});

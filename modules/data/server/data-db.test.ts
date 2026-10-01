import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyPGliteMigrations, LocalScopedStore, migration, prepareLocalAppRole, type Migration } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import manifest from '../manifest';
import { DataRepository } from '../server/repository';
import { registerData, type DataCall } from '../server';
import type { AnyCapability, ModuleManifest } from '@xyra/contracts';

type Db = Awaited<ReturnType<typeof openLocalStore>>;
const tenantA = '019a0000-0000-7000-8000-000000000001';
const tenantB = '019a0000-0000-7000-8000-000000000002';
const workspaceA = '019a0000-0000-7000-8000-000000000011';
const workspaceB = '019a0000-0000-7000-8000-000000000012';
const actor = '019a0000-0000-7000-8000-000000000021';
const actorBId = '019a0000-0000-7000-8000-000000000022';
const scopeA = { tenantId: tenantA, workspaceId: workspaceA };
const scopeB = { tenantId: tenantB, workspaceId: workspaceB };
const actorA = { id: actor, tenantId: tenantA, workspaceId: workspaceA };
let db: Db;
let scoped: LocalScopedStore;
let data: DataRepository;

function load(owner: string, relativeDir: string): Migration[] {
  const dir = fileURLToPath(new URL(relativeDir, import.meta.url));
  return readdirSync(dir).filter((name) => name.endsWith('.sql')).sort().map((name) =>
    migration(`${owner}/${name.slice(0, -4)}`, readFileSync(`${dir}${name}`, 'utf8').replace(/\r\n/g, '\n')),
  );
}

beforeAll(async () => {
  db = await openLocalStore();
  await applyPGliteMigrations(db, [...load('platform', '../../../packages/db/migrations/'), ...load('data', '../migrations/')]);
  await prepareLocalAppRole(db, manifest.tables);
  await db.query('INSERT INTO tenants(id,name) VALUES ($1,$2),($3,$4)', [tenantA, 'A', tenantB, 'B']);
  await db.query('INSERT INTO workspaces(id,tenant_id,name) VALUES ($1,$2,$3),($4,$5,$6)', [workspaceA, tenantA, 'A', workspaceB, tenantB, 'B']);
  await db.query('INSERT INTO users(id,tenant_id,display_name) VALUES ($1,$2,$3),($4,$5,$6)', [actor, tenantA, 'Actor A', actorBId, tenantB, 'Actor B']);
  scoped = new LocalScopedStore(db);
  data = new DataRepository(scoped);
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('data schema, RLS isolation and read-only SQL enforcement', () => {
  it('creates every declared table and keeps dataset rows workspace-scoped under RLS', async () => {
    const result = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    const tableNames = new Set(result.rows.map((row) => row.tablename));
    expect(manifest.tables.map((table) => table.name).filter((name) => !tableNames.has(name))).toEqual([]);
    const created = await data.createDataset(actorA, { name: 'Tenant A dataset', kind: 'sheet' });
    expect((await scoped.query(scopeB, 'SELECT id FROM data_datasets')).rows).toEqual([]);
    expect((await scoped.query(scopeA, 'SELECT id FROM data_datasets')).rows.map((row) => (row as { id: string }).id)).toContain(created.id);
    await expect(scoped.query(scopeB, "INSERT INTO data_datasets(id,tenant_id,workspace_id,name,kind,created_by) VALUES ('019a0000-0000-7000-8000-000000000099',$1,$2,'cross','sheet',$3)", [tenantA, workspaceB, actor])).rejects.toThrow();
  });

  it('rejects a non-SELECT statement before it reaches the database and blocks cross-tenant SELECT', async () => {
    await expect(data.runSqlQuery(actorA, { statement: "DELETE FROM data_datasets", params: [] })).rejects.toThrow('DATA_SQL_SELECT_OR_WITH_ONLY');
    await expect(data.runSqlQuery(actorA, { statement: "SELECT 1; DROP TABLE data_datasets", params: [] })).rejects.toThrow();
    const dataset = await data.createDataset(actorA, { name: 'SQL isolation dataset', kind: 'sheet' });
    const ownRead = await data.runSqlQuery(actorA, { statement: 'SELECT id FROM data_datasets WHERE id=$1', params: [dataset.id] });
    expect(ownRead.rowCount).toBe(1);
    const actorB = { id: actorBId, tenantId: tenantB, workspaceId: workspaceB };
    const crossRead = await data.runSqlQuery(actorB, { statement: 'SELECT id FROM data_datasets WHERE id=$1', params: [dataset.id] });
    expect(crossRead.rowCount).toBe(0);
    const audit = await scoped.query(scopeA, 'SELECT statement FROM data_sql_audit_log ORDER BY executed_at DESC LIMIT 1');
    expect(audit.rows[0]).toMatchObject({ statement: 'SELECT id FROM data_datasets WHERE id=$1' });
  });

  it('imports and exports CSV value-for-value through the repository', async () => {
    const csv = 'a,b,c\n1,2,3\nx,y,"z,1"\n';
    const snapshot = await data.importCsv(actorA, { name: 'CSV round trip', csv });
    expect(snapshot.cells.length).toBe(9);
    const exported = await data.exportCsv(actorA, { datasetId: snapshot.datasetId });
    expect(exported.csv).toBe('a,b,c\n1,2,3\nx,y,"z,1"');
  });

  it('runs a pipeline idempotently: a repeated idempotencyKey returns the stored result without re-executing', async () => {
    const pipeline = await data.createPipeline(actorA, {
      name: 'Idempotent import',
      steps: [{ name: 'import', kind: 'csv_import', config: { csv: 'h1,h2\n1,2\n' } }],
    });
    const first = await data.runPipeline(actorA, { pipelineId: pipeline.id, idempotencyKey: 'idem-key-1' });
    expect(first.status).toBe('completed');
    const runsAfterFirst = await data.pipelineRuns(actorA, { pipelineId: pipeline.id });
    expect(runsAfterFirst).toHaveLength(1);
    const second = await data.runPipeline(actorA, { pipelineId: pipeline.id, idempotencyKey: 'idem-key-1' });
    expect(second.id).toBe(first.id);
    expect(second.result).toEqual(first.result);
    const runsAfterSecond = await data.pipelineRuns(actorA, { pipelineId: pipeline.id });
    expect(runsAfterSecond).toHaveLength(1);
  });


  it('resumes from a persisted checkpoint instead of re-running the already-completed step', async () => {
    const pipeline = await data.createPipeline(actorA, {
      name: 'Two step pipeline',
      steps: [
        { name: 'step-0-marker-should-not-rerun', kind: 'csv_import', config: { csv: 'marker\n1\n', name: 'checkpoint-resume-marker' } },
        { name: 'step-1-final', kind: 'csv_import', config: { csv: 'final\n2\n', name: 'checkpoint-resume-final' } },
      ],
    });
    const runId = '019a0000-0000-7000-8000-000000000081';
    await scoped.query(scopeA, "INSERT INTO data_pipeline_runs(id,tenant_id,workspace_id,pipeline_id,idempotency_key,status,checkpoint) VALUES($1,$2,$3,$4,'resume-key','running',$5::jsonb)", [runId, tenantA, workspaceA, pipeline.id, JSON.stringify({ completedStepIndex: 0, stepResults: [{ datasetId: 'preexisting', cellCount: 0 }] })]);
    const result = await data.runPipeline(actorA, { pipelineId: pipeline.id, idempotencyKey: 'resume-key' });
    expect(result.status).toBe('completed');
    expect(result.checkpoint.completedStepIndex).toBe(1);
    const markerDatasets = (await data.datasets(actorA)).filter((dataset) => dataset.name === 'checkpoint-resume-marker');
    expect(markerDatasets).toHaveLength(0);
    const finalDatasets = (await data.datasets(actorA)).filter((dataset) => dataset.name === 'checkpoint-resume-final');
    expect(finalDatasets).toHaveLength(1);
  });

  it('records a lineage edge linking an output dataset to its producing pipeline run', async () => {
    const input = await data.importCsv(actorA, { name: 'lineage-input', csv: 'x\n1\n' });
    const pipeline = await data.createPipeline(actorA, {
      name: 'Lineage pipeline',
      steps: [{ name: 'produce', kind: 'csv_import', config: { csv: 'y\n2\n', name: 'lineage-output' } }],
    });
    const run = await data.runPipeline(actorA, { pipelineId: pipeline.id, idempotencyKey: 'lineage-key', inputDatasetId: input.datasetId });
    const outputDatasetId = (run.result as { outputDatasetId: string }).outputDatasetId;
    expect(outputDatasetId).toBeTruthy();
    const graph = await data.lineage(actorA, { datasetId: outputDatasetId });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ outputDatasetId, inputDatasetId: input.datasetId, pipelineRunId: run.id });
  });

  it('derives tenant and workspace from trusted capability call context when registered on a bus', async () => {
    const handlers = new Map<string, (input: unknown, call: DataCall) => Promise<unknown>>();
    registerData({ register: (_manifest: ModuleManifest, descriptor: AnyCapability, handler: (input: unknown, call: DataCall) => Promise<unknown>) => handlers.set(descriptor.id, handler) } as never, manifest, data);
    const callA: DataCall = { principal: { id: actor, tenantId: tenantA }, workspaceId: workspaceA };
    const created = await handlers.get('data.dataset.create')?.({ name: 'Capability scoped', kind: 'sheet' }, callA) as { workspaceId: string };
    expect(created.workspaceId).toBe(workspaceA);
    await expect(Promise.resolve().then(() => handlers.get('data.dataset.list')?.({}, undefined as unknown as DataCall))).rejects.toThrow('DATA_TRUSTED_CALL_CONTEXT_REQUIRED');
  });
});

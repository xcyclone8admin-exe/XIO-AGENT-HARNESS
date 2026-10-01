import { uuidv7 } from '@xyra/core';
import type { LocalScopedStore, Scope } from '@xyra/db';
import {
  Dataset, DatasetCreate, LineageEdge, LineageGraph, LineageGetRequest, Pipeline, PipelineCheckpointRequest,
  PipelineCreate, PipelineRun, PipelineRunCheckpoint, PipelineRunRequest, PipelineRunsList, PipelineScheduleDescribe, PipelineScheduleDescriptor,
  SheetCell, SheetExportCsv, SheetGet, SheetImportCsv, SheetSnapshot, SheetUpsertCells, SqlQuery, SqlResult,
} from '../contracts';
import { parseCsv, writeCsv } from './csv';
import { EMPTY_CHECKPOINT, runFromCheckpoint } from './pipeline-engine';

export interface DataActor { readonly id: string; readonly tenantId: string; readonly workspaceId: string }
const json = (value: unknown) => JSON.stringify(value);
const timestamp = (value: unknown) => new Date(value as string | Date).toISOString();

/** Leading-statement-kind check for data.sql.query defense in depth (REQ-DATA-002, C §sql). */
const ONLY_READ = /^\s*(SELECT|WITH)\b/i;
const FORBIDDEN_WRITE_KEYWORD = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|CALL|COPY|MERGE)\b/i;
export function assertReadOnlyStatement(statement: string): void {
  if (statement.includes(';')) throw new Error('DATA_SQL_SINGLE_STATEMENT_ONLY');
  if (!ONLY_READ.test(statement)) throw new Error('DATA_SQL_SELECT_OR_WITH_ONLY');
  if (FORBIDDEN_WRITE_KEYWORD.test(statement)) throw new Error('DATA_SQL_WRITE_KEYWORD_REJECTED');
}

export class DataRepository {
  constructor(private readonly store: LocalScopedStore) {}
  private scope(actor: DataActor): Scope { return { tenantId: actor.tenantId, workspaceId: actor.workspaceId }; }

  async datasets(actor: DataActor): Promise<Dataset[]> {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; name: string; kind: string; created_by: string; created_at: string; updated_at: string }>(
      this.scope(actor),
      'SELECT id, name, kind, created_by, created_at, updated_at FROM data_datasets WHERE deleted_hlc IS NULL ORDER BY created_at DESC',
    );
    return rows.map((row) => Dataset.parse({ id: row.id, workspaceId: actor.workspaceId, name: row.name, description: '', kind: row.kind, createdBy: row.created_by, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) }));
  }

  async createDataset(actor: DataActor, raw: unknown): Promise<Dataset> {
    const input = DatasetCreate.parse(raw);
    const id = uuidv7();
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; name: string; kind: string; created_by: string; created_at: string; updated_at: string }>(
      this.scope(actor),
      'INSERT INTO data_datasets(id,tenant_id,workspace_id,name,kind,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,kind,created_by,created_at,updated_at',
      [id, actor.tenantId, actor.workspaceId, input.name, input.kind, actor.id],
    );
    const row = rows[0];
    if (!row) throw new Error('DATA_DATASET_CREATE_FAILED');
    return Dataset.parse({ id: row.id, workspaceId: actor.workspaceId, name: row.name, description: input.description, kind: row.kind, createdBy: row.created_by, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) });
  }

  private async requireDataset(actor: DataActor, datasetId: string): Promise<void> {
    const found = await this.store.query(this.scope(actor), 'SELECT id FROM data_datasets WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND deleted_hlc IS NULL', [actor.tenantId, actor.workspaceId, datasetId]);
    if (!found.rows.length) throw new Error('DATA_DATASET_NOT_FOUND');
  }

  async sheetCells(actor: DataActor, raw: unknown): Promise<SheetSnapshot> {
    const input = SheetGet.parse(raw);
    await this.requireDataset(actor, input.datasetId);
    const { rows } = await this.store.query<Record<string, unknown> & { row_index: number; col_index: number; formula: string | null; value: string | null }>(
      this.scope(actor),
      'SELECT row_index, col_index, formula, value FROM data_sheet_cells WHERE tenant_id=$1 AND workspace_id=$2 AND dataset_id=$3 ORDER BY row_index, col_index',
      [actor.tenantId, actor.workspaceId, input.datasetId],
    );
    return SheetSnapshot.parse({ datasetId: input.datasetId, cells: rows.map((row) => ({ row: row.row_index, col: row.col_index, formula: row.formula, value: row.value })) });
  }

  async upsertCells(actor: DataActor, raw: unknown): Promise<SheetSnapshot> {
    const input = SheetUpsertCells.parse(raw);
    await this.requireDataset(actor, input.datasetId);
    for (const cell of input.cells) {
      await this.store.query(
        this.scope(actor),
        `INSERT INTO data_sheet_cells(id,tenant_id,workspace_id,dataset_id,row_index,col_index,formula,value)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id,workspace_id,dataset_id,row_index,col_index)
         DO UPDATE SET formula=EXCLUDED.formula, value=EXCLUDED.value, updated_at=now()`,
        [uuidv7(), actor.tenantId, actor.workspaceId, input.datasetId, cell.row, cell.col, cell.formula, cell.value],
      );
    }
    return this.sheetCells(actor, { datasetId: input.datasetId });
  }

  /** Deterministic CSV import: creates a dataset (or overwrites an existing one's cells) from CSV text. */
  async importCsv(actor: DataActor, raw: unknown): Promise<SheetSnapshot> {
    const input = SheetImportCsv.parse(raw);
    const grid = parseCsv(input.csv);
    let datasetId = input.datasetId;
    if (datasetId) {
      await this.requireDataset(actor, datasetId);
      await this.store.query(this.scope(actor), 'DELETE FROM data_sheet_cells WHERE tenant_id=$1 AND workspace_id=$2 AND dataset_id=$3', [actor.tenantId, actor.workspaceId, datasetId]);
    } else {
      const created = await this.createDataset(actor, { name: input.name ?? `Imported ${new Date().toISOString()}`, description: '', kind: 'sheet' });
      datasetId = created.id;
    }
    const cells: SheetCell[] = [];
    for (let row = 0; row < grid.length; row += 1) {
      const line = grid[row] ?? [];
      for (let col = 0; col < line.length; col += 1) {
        const value = line[col] ?? '';
        cells.push(SheetCell.parse({ row, col, formula: null, value }));
      }
    }
    if (cells.length) await this.upsertCells(actor, { datasetId, cells });
    return this.sheetCells(actor, { datasetId });
  }

  async exportCsv(actor: DataActor, raw: unknown): Promise<{ csv: string }> {
    const input = SheetExportCsv.parse(raw);
    const snapshot = await this.sheetCells(actor, { datasetId: input.datasetId });
    if (!snapshot.cells.length) return { csv: '' };
    const maxRow = Math.max(...snapshot.cells.map((cell: SheetCell) => cell.row));
    const maxCol = Math.max(...snapshot.cells.map((cell: SheetCell) => cell.col));
    const grid: string[][] = Array.from({ length: maxRow + 1 }, () => Array.from({ length: maxCol + 1 }, () => ''));
    for (const cell of snapshot.cells) grid[cell.row]![cell.col] = cell.value ?? '';
    return { csv: writeCsv(grid) };
  }

  /**
   * data.sql.query: statement is validated as SELECT/WITH-only here (defense in depth), then
   * executed via LocalScopedStore.withServerScope under the data_sql_query capability role,
   * which the manifest grants SELECT only (serverReadCapabilities) on every data_* table and
   * nothing else — so even a bug in this validation cannot reach a write grant at the DB layer.
   * Every execution is recorded in data_sql_audit_log (statement + row count only, never rows).
   */
  async runSqlQuery(actor: DataActor, raw: unknown): Promise<SqlResult> {
    const input = SqlQuery.parse(raw);
    assertReadOnlyStatement(input.statement);
    const { rows, columns } = await this.store.withServerScope(this.scope(actor), 'data_sql_query', undefined, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(input.statement, input.params);
      const cols = result.rows.length ? Object.keys(result.rows[0] ?? {}) : [];
      return { rows: result.rows, columns: cols };
    });
    await this.store.query(
      this.scope(actor),
      'INSERT INTO data_sql_audit_log(id,tenant_id,workspace_id,statement,row_count,executed_by) VALUES($1,$2,$3,$4,$5,$6)',
      [uuidv7(), actor.tenantId, actor.workspaceId, input.statement, rows.length, actor.id],
    );
    return SqlResult.parse({ columns, rows: rows.map((row) => columns.map((col) => row[col])), rowCount: rows.length });
  }

  async createPipeline(actor: DataActor, raw: unknown): Promise<Pipeline> {
    const input = PipelineCreate.parse(raw);
    const id = uuidv7();
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; name: string; steps: unknown; schedule_cron: string | null; schedule_enabled: boolean; created_by: string; created_at: string }>(
      this.scope(actor),
      'INSERT INTO data_pipelines(id,tenant_id,workspace_id,name,steps,schedule_cron,schedule_enabled,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING id,name,steps,schedule_cron,schedule_enabled,created_by,created_at',
      [id, actor.tenantId, actor.workspaceId, input.name, json(input.steps), input.scheduleCron, input.scheduleEnabled, actor.id],
    );
    const row = rows[0];
    if (!row) throw new Error('DATA_PIPELINE_CREATE_FAILED');
    return Pipeline.parse({ id: row.id, workspaceId: actor.workspaceId, name: row.name, steps: row.steps, scheduleCron: row.schedule_cron, scheduleEnabled: row.schedule_enabled, createdBy: row.created_by, createdAt: timestamp(row.created_at) });
  }

  private async requirePipeline(actor: DataActor, pipelineId: string): Promise<Pipeline> {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; name: string; steps: unknown; schedule_cron: string | null; schedule_enabled: boolean; created_by: string; created_at: string }>(
      this.scope(actor),
      'SELECT id,name,steps,schedule_cron,schedule_enabled,created_by,created_at FROM data_pipelines WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3',
      [actor.tenantId, actor.workspaceId, pipelineId],
    );
    const row = rows[0];
    if (!row) throw new Error('DATA_PIPELINE_NOT_FOUND');
    return Pipeline.parse({ id: row.id, workspaceId: actor.workspaceId, name: row.name, steps: row.steps, scheduleCron: row.schedule_cron, scheduleEnabled: row.schedule_enabled, createdBy: row.created_by, createdAt: timestamp(row.created_at) });
  }

  private rowToRun(row: Record<string, unknown> & { id: string; pipeline_id: string; idempotency_key: string; status: string; checkpoint: unknown; result: unknown; started_at: string; completed_at: string | null }): PipelineRun {
    return PipelineRun.parse({
      id: row.id, pipelineId: row.pipeline_id, idempotencyKey: row.idempotency_key, status: row.status,
      checkpoint: PipelineRunCheckpoint.parse(row.checkpoint), result: row.result ?? null,
      startedAt: timestamp(row.started_at), completedAt: row.completed_at ? timestamp(row.completed_at) : null,
    });
  }

  private async findRun(actor: DataActor, pipelineId: string, idempotencyKey: string) {
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; pipeline_id: string; idempotency_key: string; status: string; checkpoint: unknown; result: unknown; started_at: string; completed_at: string | null }>(
      this.scope(actor),
      'SELECT id,pipeline_id,idempotency_key,status,checkpoint,result,started_at,completed_at FROM data_pipeline_runs WHERE tenant_id=$1 AND workspace_id=$2 AND pipeline_id=$3 AND idempotency_key=$4',
      [actor.tenantId, actor.workspaceId, pipelineId, idempotencyKey],
    );
    return rows[0] ? this.rowToRun(rows[0]) : null;
  }

  private async persistCheckpoint(actor: DataActor, runId: string, checkpoint: PipelineRunCheckpoint, status: 'running' | 'completed' | 'failed', result: Record<string, unknown> | null): Promise<void> {
    await this.store.withServerScope(this.scope(actor), 'data_pipeline_run', undefined, async (tx) => {
      await tx.query(
        "UPDATE data_pipeline_runs SET checkpoint=$1::jsonb, status=$2, result=$3::jsonb, completed_at=CASE WHEN $2 IN ('completed','failed') THEN now() ELSE NULL END WHERE tenant_id=$4 AND workspace_id=$5 AND id=$6",
        [json(checkpoint), status, result === null ? null : json(result), actor.tenantId, actor.workspaceId, runId],
      );
    });
  }

  private async executeStep(actor: DataActor, step: { name: string; kind: string; config: Record<string, unknown> }, outputDatasetName: string | undefined): Promise<Record<string, unknown>> {
    if (step.kind === 'csv_import') {
      const csv = typeof step.config.csv === 'string' ? step.config.csv : '';
      const name = typeof step.config.name === 'string' ? step.config.name : (outputDatasetName ?? step.name);
      const snapshot = await this.importCsv(actor, { name, csv });
      return { datasetId: snapshot.datasetId, cellCount: snapshot.cells.length };
    }
    if (step.kind === 'sql_transform') {
      const statement = typeof step.config.statement === 'string' ? step.config.statement : '';
      const params = Array.isArray(step.config.params) ? step.config.params : [];
      const queryResult = await this.runSqlQuery(actor, { statement, params });
      const created = await this.createDataset(actor, { name: outputDatasetName ?? step.name, description: '', kind: 'derived' });
      const cells: SheetCell[] = [];
      for (let col = 0; col < queryResult.columns.length; col += 1) cells.push(SheetCell.parse({ row: 0, col, formula: null, value: queryResult.columns[col] ?? '' }));
      for (let row = 0; row < queryResult.rows.length; row += 1) {
        const line = queryResult.rows[row] ?? [];
        for (let col = 0; col < line.length; col += 1) cells.push(SheetCell.parse({ row: row + 1, col, formula: null, value: line[col] === null || line[col] === undefined ? null : String(line[col]) }));
      }
      if (cells.length) await this.upsertCells(actor, { datasetId: created.id, cells });
      return { datasetId: created.id, rowCount: queryResult.rowCount };
    }
    throw new Error(`DATA_PIPELINE_UNKNOWN_STEP_KIND:${step.kind}`);
  }

  async runPipeline(actor: DataActor, raw: unknown): Promise<PipelineRun> {
    const input = PipelineRunRequest.parse(raw);
    const pipeline = await this.requirePipeline(actor, input.pipelineId);
    const existing = await this.findRun(actor, input.pipelineId, input.idempotencyKey);
    if (existing && existing.status === 'completed') return existing;
    const runId = existing?.id ?? uuidv7();
    const checkpoint = existing?.checkpoint ?? EMPTY_CHECKPOINT;
    if (!existing) {
      await this.store.query(
        this.scope(actor),
        "INSERT INTO data_pipeline_runs(id,tenant_id,workspace_id,pipeline_id,idempotency_key,status,checkpoint) VALUES($1,$2,$3,$4,$5,'running',$6::jsonb)",
        [runId, actor.tenantId, actor.workspaceId, input.pipelineId, input.idempotencyKey, json(checkpoint)],
      );
    } else if (existing.status === 'running' || existing.status === 'failed') {
      await this.persistCheckpoint(actor, runId, checkpoint, 'running', null);
    }
    let outputDatasetId: string | undefined;
    const outcome = await runFromCheckpoint(pipeline.steps, checkpoint, async (step, context) => {
      const output = await this.executeStep(actor, step, context.stepIndex === pipeline.steps.length - 1 ? input.outputDatasetName : undefined);
      if (typeof output.datasetId === 'string') outputDatasetId = output.datasetId;
      return output;
    });
    if (outcome.error) {
      await this.persistCheckpoint(actor, runId, outcome.checkpoint, 'failed', { error: outcome.error.message });
      throw outcome.error;
    }
    const result = { outputDatasetId: outputDatasetId ?? null, stepResults: outcome.checkpoint.stepResults };
    await this.persistCheckpoint(actor, runId, outcome.checkpoint, 'completed', result);
    if (outputDatasetId) {
      await this.store.query(
        this.scope(actor),
        'INSERT INTO data_lineage_edges(id,tenant_id,workspace_id,output_dataset_id,input_dataset_id,pipeline_run_id) VALUES($1,$2,$3,$4,$5,$6)',
        [uuidv7(), actor.tenantId, actor.workspaceId, outputDatasetId, input.inputDatasetId ?? null, runId],
      );
    }
    const run = await this.findRun(actor, input.pipelineId, input.idempotencyKey);
    if (!run) throw new Error('DATA_PIPELINE_RUN_LOST');
    return run;
  }

  async pipelineRuns(actor: DataActor, raw: unknown): Promise<PipelineRun[]> {
    const { pipelineId } = PipelineRunsList.parse(raw);
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; pipeline_id: string; idempotency_key: string; status: string; checkpoint: unknown; result: unknown; started_at: string; completed_at: string | null }>(
      this.scope(actor),
      'SELECT id,pipeline_id,idempotency_key,status,checkpoint,result,started_at,completed_at FROM data_pipeline_runs WHERE tenant_id=$1 AND workspace_id=$2 AND pipeline_id=$3 ORDER BY started_at DESC',
      [actor.tenantId, actor.workspaceId, pipelineId],
    );
    return rows.map((row) => this.rowToRun(row));
  }

  /** Internal checkpoint-recording capability; also usable directly for tests. */
  async recordCheckpoint(actor: DataActor, raw: unknown): Promise<PipelineRun> {
    const input = PipelineCheckpointRequest.parse(raw);
    const { rows } = await this.store.query<Record<string, unknown> & { pipeline_id: string; idempotency_key: string; checkpoint: unknown }>(
      this.scope(actor),
      'SELECT pipeline_id,idempotency_key,checkpoint FROM data_pipeline_runs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3',
      [actor.tenantId, actor.workspaceId, input.runId],
    );
    const row = rows[0];
    if (!row) throw new Error('DATA_PIPELINE_RUN_NOT_FOUND');
    const current = PipelineRunCheckpoint.parse(row.checkpoint);
    const stepResults = [...current.stepResults];
    stepResults[input.completedStepIndex] = input.stepResult;
    await this.persistCheckpoint(actor, input.runId, { completedStepIndex: input.completedStepIndex, stepResults }, 'running', null);
    const run = await this.findRun(actor, row.pipeline_id, row.idempotency_key);
    if (!run) throw new Error('DATA_PIPELINE_RUN_LOST');
    return run;
  }

  /**
   * Typed descriptor only (XIO-REQ-DAT-001). An apps-scope owner wires a real Cloudflare Cron
   * Trigger elsewhere that calls data.pipeline.run; this module never binds a Cron Trigger itself.
   */
  async scheduleDescribe(actor: DataActor, raw: unknown): Promise<PipelineScheduleDescriptor> {
    const { pipelineId } = PipelineScheduleDescribe.parse(raw);
    const pipeline = await this.requirePipeline(actor, pipelineId);
    return PipelineScheduleDescriptor.parse({ cron: pipeline.scheduleCron, pipelineId: pipeline.id, enabled: pipeline.scheduleEnabled });
  }

  async lineage(actor: DataActor, raw: unknown): Promise<LineageGraph> {
    const { datasetId } = LineageGetRequest.parse(raw);
    await this.requireDataset(actor, datasetId);
    const { rows } = await this.store.query<Record<string, unknown> & { id: string; output_dataset_id: string; input_dataset_id: string | null; pipeline_run_id: string | null; created_at: string }>(
      this.scope(actor),
      'SELECT id,output_dataset_id,input_dataset_id,pipeline_run_id,created_at FROM data_lineage_edges WHERE tenant_id=$1 AND workspace_id=$2 AND output_dataset_id=$3 ORDER BY created_at DESC',
      [actor.tenantId, actor.workspaceId, datasetId],
    );
    const edges = rows.map((row) => LineageEdge.parse({ id: row.id, outputDatasetId: row.output_dataset_id, inputDatasetId: row.input_dataset_id, pipelineRunId: row.pipeline_run_id, createdAt: timestamp(row.created_at) }));
    return LineageGraph.parse({ datasetId, edges });
  }
}

import { defineCapability } from '@xyra/contracts';
import { z } from 'zod';

export const UUID = z.uuid();

export const DatasetKind = z.enum(['sheet', 'derived']);
export const Dataset = z.object({
  id: UUID,
  workspaceId: UUID,
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  kind: DatasetKind,
  createdBy: UUID,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Dataset = z.infer<typeof Dataset>;
export const DatasetCreate = z.object({ name: z.string().min(1).max(200), description: z.string().max(4000).default(''), kind: DatasetKind.default('sheet') });
export const DatasetList = z.object({});

export const SheetCell = z.object({ row: z.number().int().min(0).max(1000000), col: z.number().int().min(0).max(16384), formula: z.string().max(4000).nullable().default(null), value: z.string().max(10000).nullable().default(null) });
export type SheetCell = z.infer<typeof SheetCell>;
export const SheetGet = z.object({ datasetId: UUID });
export const SheetSnapshot = z.object({ datasetId: UUID, cells: z.array(SheetCell) });
export type SheetSnapshot = z.infer<typeof SheetSnapshot>;
export const SheetUpsertCells = z.object({ datasetId: UUID, cells: z.array(SheetCell).min(1).max(5000) });
export const SheetImportCsv = z.object({ datasetId: UUID.optional(), name: z.string().min(1).max(200).optional(), csv: z.string().max(5000000) });
export const SheetExportCsv = z.object({ datasetId: UUID });
export const CsvResult = z.object({ csv: z.string() });

export const SqlQuery = z.object({ statement: z.string().min(1).max(20000), params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(100).default([]) });
export const SqlResult = z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.unknown())), rowCount: z.number().int().nonnegative() });
export type SqlResult = z.infer<typeof SqlResult>;
export const PipelineStepKind = z.enum(['sql_transform', 'csv_import']);
export const PipelineStep = z.object({
  name: z.string().min(1).max(200),
  kind: PipelineStepKind,
  config: z.record(z.string(), z.unknown()).default({}),
});
export type PipelineStep = z.infer<typeof PipelineStep>;
export const PipelineCreate = z.object({ name: z.string().min(1).max(200), steps: z.array(PipelineStep).min(1).max(50), scheduleCron: z.string().max(120).nullable().default(null), scheduleEnabled: z.boolean().default(false) });
export const Pipeline = z.object({ id: UUID, workspaceId: UUID, name: z.string(), steps: z.array(PipelineStep), scheduleCron: z.string().nullable(), scheduleEnabled: z.boolean(), createdBy: UUID, createdAt: z.iso.datetime({ offset: true }) });
export type Pipeline = z.infer<typeof Pipeline>;

export const PipelineRunCheckpoint = z.object({ completedStepIndex: z.number().int().min(-1), stepResults: z.array(z.record(z.string(), z.unknown())).default([]) });
export type PipelineRunCheckpoint = z.infer<typeof PipelineRunCheckpoint>;
export const PipelineRunRequest = z.object({ pipelineId: UUID, idempotencyKey: z.string().min(1).max(200), inputDatasetId: UUID.optional(), outputDatasetName: z.string().min(1).max(200).optional() });
export const PipelineRunStatus = z.enum(['running', 'completed', 'failed']);
export const PipelineRun = z.object({ id: UUID, pipelineId: UUID, idempotencyKey: z.string(), status: PipelineRunStatus, checkpoint: PipelineRunCheckpoint, result: z.record(z.string(), z.unknown()).nullable(), startedAt: z.iso.datetime({ offset: true }), completedAt: z.iso.datetime({ offset: true }).nullable() });
export type PipelineRun = z.infer<typeof PipelineRun>;
export const PipelineRunsList = z.object({ pipelineId: UUID });
export const PipelineCheckpointRequest = z.object({ runId: UUID, completedStepIndex: z.number().int().min(-1), stepResult: z.record(z.string(), z.unknown()).default({}) });
export const PipelineScheduleDescribe = z.object({ pipelineId: UUID });
export const PipelineScheduleDescriptor = z.object({ cron: z.string().nullable(), pipelineId: UUID, enabled: z.boolean() });
export type PipelineScheduleDescriptor = z.infer<typeof PipelineScheduleDescriptor>;

export const LineageGetRequest = z.object({ datasetId: UUID });
export const LineageEdge = z.object({ id: UUID, outputDatasetId: UUID, inputDatasetId: UUID.nullable(), pipelineRunId: UUID.nullable(), createdAt: z.iso.datetime({ offset: true }) });
export const LineageGraph = z.object({ datasetId: UUID, edges: z.array(LineageEdge) });
export type LineageGraph = z.infer<typeof LineageGraph>;
export const dataCapabilities = {
  datasetList: defineCapability({ id: 'data.dataset.list', title: 'List datasets', description: 'List workspace datasets', kind: 'read', permission: 'data:dataset:read', input: DatasetList, output: z.array(Dataset) }),
  datasetCreate: defineCapability({ id: 'data.dataset.create', title: 'Create dataset', description: 'Create a dataset (sheet or derived)', kind: 'write', permission: 'data:dataset:write', input: DatasetCreate, output: Dataset }),
  sheetGet: defineCapability({ id: 'data.sheet.get', title: 'Get sheet snapshot', description: 'Read all cells of a sheet dataset', kind: 'read', permission: 'data:sheet:read', input: SheetGet, output: SheetSnapshot }),
  sheetUpsertCells: defineCapability({ id: 'data.sheet.upsertCells', title: 'Upsert sheet cells', description: 'Batch write row/col formula or value cells', kind: 'write', permission: 'data:sheet:write', input: SheetUpsertCells, output: SheetSnapshot }),
  sheetImportCsv: defineCapability({ id: 'data.sheet.importCsv', title: 'Import CSV', description: 'Deterministically create or overwrite a sheet dataset from CSV text', kind: 'write', permission: 'data:sheet:write', input: SheetImportCsv, output: SheetSnapshot }),
  sheetExportCsv: defineCapability({ id: 'data.sheet.exportCsv', title: 'Export CSV', description: 'Render a sheet dataset as CSV text', kind: 'read', permission: 'data:sheet:read', input: SheetExportCsv, output: CsvResult }),
  sqlQuery: defineCapability({ id: 'data.sql.query', title: 'Run read-only SQL', description: 'Execute a single tenant-scoped SELECT or WITH statement under a role with no write grants', kind: 'read', permission: 'data:sql:read', input: SqlQuery, output: SqlResult, agentCallable: false }),
  pipelineCreate: defineCapability({ id: 'data.pipeline.create', title: 'Create pipeline', description: 'Define an ordered list of pipeline steps', kind: 'write', permission: 'data:pipeline:write', input: PipelineCreate, output: Pipeline }),
  pipelineRun: defineCapability({ id: 'data.pipeline.run', title: 'Run pipeline', description: 'Idempotently run a pipeline; a prior completed run under the same idempotencyKey is returned without re-executing', kind: 'consequential', permission: 'data:pipeline:run', input: PipelineRunRequest, output: PipelineRun }),
  pipelineRunsList: defineCapability({ id: 'data.pipeline.runs.list', title: 'List pipeline runs', description: 'List run history for a pipeline', kind: 'read', permission: 'data:pipeline:read', input: PipelineRunsList, output: z.array(PipelineRun) }),
  pipelineCheckpoint: defineCapability({ id: 'data.pipeline.checkpoint', title: 'Record pipeline checkpoint', description: 'Internal step so a failed run can resume from the last completed step', kind: 'write', permission: 'data:pipeline:run', input: PipelineCheckpointRequest, output: PipelineRun, agentCallable: false }),
  pipelineScheduleDescribe: defineCapability({ id: 'data.pipeline.schedule.describe', title: 'Describe pipeline schedule', description: 'Typed schedule descriptor only; does not bind a real Cloudflare Cron Trigger', kind: 'read', permission: 'data:pipeline:read', input: PipelineScheduleDescribe, output: PipelineScheduleDescriptor }),
  lineageGet: defineCapability({ id: 'data.lineage.get', title: 'Get dataset lineage', description: 'Return which pipeline run and source datasets produced a dataset', kind: 'read', permission: 'data:lineage:read', input: LineageGetRequest, output: LineageGraph }),
} as const;

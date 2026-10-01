import { defineModule } from '@xyra/contracts';

const DATASET_COLUMNS = {
  id: { type: 'uuid' },
  name: { type: 'text' },
  kind: { type: 'text' },
  created_by: { type: 'uuid' },
  created_at: { type: 'timestamptz' },
  updated_at: { type: 'timestamptz' },
} as const;

const SHEET_CELL_COLUMNS = {
  dataset_id: { type: 'uuid' },
  row_index: { type: 'integer' },
  col_index: { type: 'integer' },
  formula: { type: 'text' },
  value: { type: 'text' },
  updated_at: { type: 'timestamptz' },
} as const;

const PIPELINE_COLUMNS = {
  id: { type: 'uuid' },
  name: { type: 'text' },
  steps: { type: 'jsonb' },
  schedule_cron: { type: 'text' },
  schedule_enabled: { type: 'boolean' },
  created_by: { type: 'uuid' },
  created_at: { type: 'timestamptz' },
} as const;

const PIPELINE_RUN_COLUMNS = {
  id: { type: 'uuid' },
  pipeline_id: { type: 'uuid' },
  idempotency_key: { type: 'text' },
  status: { type: 'text' },
  checkpoint: { type: 'jsonb' },
  result: { type: 'jsonb' },
  started_at: { type: 'timestamptz' },
  completed_at: { type: 'timestamptz' },
} as const;

export default defineModule({
  id: 'data',
  version: '1.0.0',
  pillar: 'DATA',
  title: 'Data',
  description:
    'Workspace spreadsheets with CSV import/export and formulas, read-only tenant-scoped SQL, and idempotent checkpointed pipelines with lineage.',
  icon: 'database',
  requirements: ['XIO-REQ-DAT-001', 'REQ-DATA-001', 'REQ-DATA-002'],
  permissions: [
    'data:dataset:read',
    'data:dataset:write',
    'data:sheet:read',
    'data:sheet:write',
    'data:sql:read',
    'data:pipeline:read',
    'data:pipeline:write',
    'data:pipeline:run',
    'data:lineage:read',
  ],
  roleGrants: {
    owner: [
      'data:dataset:read', 'data:dataset:write', 'data:sheet:read', 'data:sheet:write',
      'data:sql:read', 'data:pipeline:read', 'data:pipeline:write', 'data:pipeline:run', 'data:lineage:read',
    ],
    admin: [
      'data:dataset:read', 'data:dataset:write', 'data:sheet:read', 'data:sheet:write',
      'data:sql:read', 'data:pipeline:read', 'data:pipeline:write', 'data:pipeline:run', 'data:lineage:read',
    ],
    manager: [
      'data:dataset:read', 'data:dataset:write', 'data:sheet:read', 'data:sheet:write',
      'data:sql:read', 'data:pipeline:read', 'data:pipeline:write', 'data:pipeline:run', 'data:lineage:read',
    ],
    member: ['data:dataset:read', 'data:dataset:write', 'data:sheet:read', 'data:sheet:write', 'data:sql:read', 'data:pipeline:read', 'data:lineage:read'],
    viewer: ['data:dataset:read', 'data:sheet:read', 'data:sql:read', 'data:pipeline:read', 'data:lineage:read'],
    auditor: ['data:dataset:read', 'data:sheet:read', 'data:sql:read', 'data:pipeline:read', 'data:lineage:read'],
  },
  nav: [
    { path: '', title: 'Overview', keywords: ['datasets', 'spreadsheets'] },
    { path: 'sheets', title: 'Sheets', keywords: ['spreadsheet', 'csv', 'xlsx', 'formulas'] },
    { path: 'sql', title: 'SQL console', keywords: ['query', 'read-only', 'sql'] },
    { path: 'pipelines', title: 'Pipelines', keywords: ['etl', 'lineage', 'checkpoint'] },
  ],
  dependsOn: [],
  tables: [
    {
      name: 'data_datasets',
      class: 'lww',
      authority: 'synced',
      allowedFields: ['name', 'kind'],
      actorField: 'created_by',
      writePermission: 'data:dataset:write',
      readPermission: 'data:dataset:read',
      columns: DATASET_COLUMNS,
      serverReadCapabilities: ['data_sql_query'],
    },
    {
      name: 'data_sheet_cells',
      class: 'lww',
      authority: 'synced',
      allowedFields: ['formula', 'value'],
      writePermission: 'data:sheet:write',
      readPermission: 'data:sheet:read',
      columns: SHEET_CELL_COLUMNS,
      serverReadCapabilities: ['data_sql_query'],
    },
    {
      name: 'data_pipelines',
      class: 'lww',
      authority: 'synced',
      allowedFields: ['name', 'steps', 'schedule_cron', 'schedule_enabled'],
      actorField: 'created_by',
      writePermission: 'data:pipeline:write',
      readPermission: 'data:pipeline:read',
      columns: PIPELINE_COLUMNS,
      serverReadCapabilities: ['data_sql_query'],
    },
    {
      name: 'data_pipeline_runs',
      class: 'append',
      authority: 'append',
      receivedAtField: 'started_at',
      writePermission: 'data:pipeline:run',
      readPermission: 'data:pipeline:read',
      columns: PIPELINE_RUN_COLUMNS,
      serverWriteCapabilities: ['data_pipeline_run'],
      serverReadCapabilities: ['data_sql_query'],
    },
    {
      name: 'data_lineage_edges',
      class: 'append',
      authority: 'append',
      receivedAtField: 'created_at',
      writePermission: 'data:pipeline:run',
      readPermission: 'data:lineage:read',
      columns: { id: { type: 'uuid' }, output_dataset_id: { type: 'uuid' }, input_dataset_id: { type: 'uuid' }, pipeline_run_id: { type: 'uuid' }, created_at: { type: 'timestamptz' } },
    },
    {
      name: 'data_sql_audit_log',
      class: 'append',
      authority: 'append',
      receivedAtField: 'executed_at',
      writePermission: 'data:sql:read',
      readPermission: 'data:sql:read',
      columns: { id: { type: 'uuid' }, statement: { type: 'text' }, row_count: { type: 'integer' }, executed_by: { type: 'uuid' }, executed_at: { type: 'timestamptz' } },
    },
  ],
});

'use client';

import { useState } from 'react';
import { Database, FileSpreadsheet, GitBranch, Play, RefreshCw, Table2 } from 'lucide-react';
import { useCapability } from '@xyra/sdk';
import type { ModulePageProps, ModuleUi } from '@xyra/sdk/module-ui';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState, OfflineState, PageHeader, Panel } from '@xyra/ui';
import { dataCapabilities as caps } from '../contracts';
import type { Dataset, LineageGraph, Pipeline, PipelineRun, SheetSnapshot, SqlResult } from '../contracts';

function Offline() {
  return <Panel><OfflineState what="Data" /></Panel>;
}

function Overview({ workspaceId, api }: ModulePageProps) {
  const datasets = useCapability<Dataset[]>(api, workspaceId, caps.datasetList.id);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!api || !workspaceId) return <Offline />;

  async function createDataset() {
    if (!api || !workspaceId || !name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await api.write(workspaceId, caps.datasetCreate.id, { name: name.trim(), kind: 'sheet' });
      setName('');
      datasets.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Dataset creation failed');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Data"
        title="Datasets"
        description="Spreadsheets and derived datasets produced by import or pipeline runs."
        actions={<Button size="sm" onClick={() => datasets.refresh()}><RefreshCw aria-hidden className="size-3.5" /> Refresh</Button>}
      />
      <Panel title="Create dataset">
        <div className="flex items-end gap-2">
          <Input placeholder="Dataset name" value={name} onChange={(event) => setName(event.target.value)} />
          <Button size="sm" disabled={creating || !name.trim()} onClick={createDataset}>Create</Button>
        </div>
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      </Panel>
      <Panel title="Datasets">
        {datasets.loading ? <LoadingState /> : null}
        {datasets.error ? <ErrorState error={datasets.error} onRetry={datasets.refresh} title="Could not load datasets" /> : null}
        {!datasets.loading && !datasets.error && !datasets.data?.length ? (
          <EmptyState icon={Database} title="No datasets yet">Create a sheet dataset or import a CSV to get started.</EmptyState>
        ) : null}
        {datasets.data?.length ? (
          <ul className="divide-y divide-line">
            {datasets.data.map((dataset) => (
              <li key={dataset.id} className="flex items-center justify-between py-2 text-sm">
                <span className="flex items-center gap-2"><Table2 aria-hidden className="size-3.5 text-fg-muted" /> {dataset.name}</span>
                <Badge>{dataset.kind}</Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </div>
  );
}

function Sheets({ workspaceId, api }: ModulePageProps) {
  const datasets = useCapability<Dataset[]>(api, workspaceId, caps.datasetList.id);
  const [selected, setSelected] = useState<string | null>(null);
  const [csvText, setCsvText] = useState('');
  const [importName, setImportName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const sheet = useCapability<SheetSnapshot>(api, selected ? workspaceId : null, caps.sheetGet.id, { datasetId: selected ?? '' });

  if (!api || !workspaceId) return <Offline />;

  async function importCsv() {
    if (!api || !workspaceId || !csvText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const snapshot = await api.write<SheetSnapshot>(workspaceId, caps.sheetImportCsv.id, { name: importName.trim() || undefined, csv: csvText });
      setSelected(snapshot.datasetId);
      setCsvText('');
      datasets.refresh();
      sheet.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'CSV import failed');
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv() {
    if (!api || !workspaceId || !selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.read<{ csv: string }>(workspaceId, caps.sheetExportCsv.id, { datasetId: selected });
      setExported(result.csv);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'CSV export failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Data" title="Sheets" description="Spreadsheet cells with formula/value storage, CSV import and export." />
      <Panel title="Import CSV">
        <div className="space-y-2">
          <Input placeholder="New dataset name (optional if a dataset is selected)" value={importName} onChange={(event) => setImportName(event.target.value)} />
          <textarea className="h-28 w-full rounded-md border border-line bg-surface p-2 text-sm font-mono" placeholder="a,b,c&#10;1,2,3" value={csvText} onChange={(event) => setCsvText(event.target.value)} />
          <Button size="sm" disabled={busy || !csvText.trim()} onClick={importCsv}>Import CSV</Button>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </Panel>
      <Panel title="Dataset">
        <div className="flex items-center gap-2">
          <select className="h-9 rounded-md border border-line bg-surface px-3 text-sm" value={selected ?? ''} onChange={(event) => setSelected(event.target.value || null)}>
            <option value="">Select a dataset</option>
            {datasets.data?.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
          </select>
          <Button size="sm" disabled={!selected || busy} onClick={exportCsv}>Export CSV</Button>
        </div>
        {!selected ? <EmptyState icon={FileSpreadsheet} title="No sheet selected">Select a dataset above to view its cells.</EmptyState> : null}
        {selected && sheet.loading ? <LoadingState /> : null}
        {selected && sheet.data ? (
          <div className="mt-3 overflow-auto">
            <table className="min-w-full text-sm">
              <tbody>
                {sheet.data.cells.length === 0 ? <tr><td className="text-fg-muted">No cells yet.</td></tr> : null}
                {Array.from(new Set(sheet.data.cells.map((cell: { row: number }) => cell.row))).sort((a: number, b: number) => a - b).map((row: number) => (
                  <tr key={row}>
                    {sheet.data?.cells.filter((cell: { row: number }) => cell.row === row).sort((a: { col: number }, b: { col: number }) => a.col - b.col).map((cell: { col: number; value: string | null }) => (
                      <td key={cell.col} className="border border-line px-2 py-1 font-mono">{cell.value ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {exported !== null ? <pre className="mt-3 max-h-40 overflow-auto rounded-md border border-line bg-surface p-2 text-xs">{exported}</pre> : null}
      </Panel>
    </div>
  );
}

function SqlConsole({ workspaceId, api }: ModulePageProps) {
  const [statement, setStatement] = useState('SELECT 1');
  const [result, setResult] = useState<SqlResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!api || !workspaceId) return <Offline />;

  async function run() {
    if (!api || !workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const output = await api.read<SqlResult>(workspaceId, caps.sqlQuery.id, { statement, params: [] });
      setResult(output);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Query failed');
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Data" title="SQL console" description="Read-only, tenant-scoped SQL. Only a single SELECT or WITH statement is accepted; it runs under a database role with no write grants." />
      <Panel title="Query">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Read-only &middot; tenant-scoped &middot; no writes are possible from this console</p>
        <textarea className="h-28 w-full rounded-md border border-line bg-surface p-2 text-sm font-mono" value={statement} onChange={(event) => setStatement(event.target.value)} />
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" disabled={busy || !statement.trim()} onClick={run}><Play aria-hidden className="size-3.5" /> Run</Button>
          {error ? <span className="text-sm text-danger">{error}</span> : null}
        </div>
        {result ? (
          <div className="mt-3 overflow-auto">
            <table className="min-w-full text-sm">
              <thead><tr>{result.columns.map((col) => <th key={col} className="border border-line px-2 py-1 text-left">{col}</th>)}</tr></thead>
              <tbody>
                {result.rows.map((row: unknown[], index: number) => (
                  <tr key={index}>{row.map((value: unknown, cellIndex: number) => <td key={cellIndex} className="border border-line px-2 py-1 font-mono">{String(value ?? '')}</td>)}</tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-fg-muted">{result.rowCount} row(s)</p>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

function Pipelines({ workspaceId, api }: ModulePageProps) {
  const [selectedPipeline, setSelectedPipeline] = useState<string | null>(null);
  const [lineageDataset, setLineageDataset] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lineage, setLineage] = useState<LineageGraph | null>(null);
  const runs = useCapability<PipelineRun[]>(api, selectedPipeline ? workspaceId : null, caps.pipelineRunsList.id, { pipelineId: selectedPipeline ?? '' });

  if (!api || !workspaceId) return <Offline />;

  async function createSamplePipeline() {
    if (!api || !workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const pipeline = await api.write<Pipeline>(workspaceId, caps.pipelineCreate.id, {
        name: 'Sample CSV import',
        steps: [{ name: 'import', kind: 'csv_import', config: { csv: 'a,b\n1,2\n' } }],
      });
      setSelectedPipeline(pipeline.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Pipeline creation failed');
    } finally {
      setBusy(false);
    }
  }

  async function runPipeline() {
    if (!api || !workspaceId || !selectedPipeline) return;
    setBusy(true);
    setError(null);
    try {
      await api.write(workspaceId, caps.pipelineRun.id, { pipelineId: selectedPipeline, idempotencyKey: `manual-${Date.now()}` });
      runs.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Pipeline run failed');
    } finally {
      setBusy(false);
    }
  }

  async function loadLineage() {
    if (!api || !workspaceId || !lineageDataset.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const graph = await api.read<LineageGraph>(workspaceId, caps.lineageGet.id, { datasetId: lineageDataset.trim() });
      setLineage(graph);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Lineage lookup failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Data" title="Pipelines" description="Ordered, idempotent and checkpointed steps that import or transform datasets, with recorded lineage." />
      <Panel title="Create">
        <Button size="sm" disabled={busy} onClick={createSamplePipeline}>New sample pipeline</Button>
        {selectedPipeline ? <p className="mt-2 text-sm text-fg-muted">Selected pipeline: <span className="font-mono">{selectedPipeline}</span></p> : null}
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      </Panel>
      <Panel title="Run">
        <Button size="sm" disabled={busy || !selectedPipeline} onClick={runPipeline}>Run (idempotent)</Button>
        {!selectedPipeline ? <EmptyState icon={Play} title="No pipeline selected">Create a pipeline above, then run it. Running twice with the same key returns the stored result.</EmptyState> : null}
        {runs.data?.length ? (
          <ul className="mt-3 divide-y divide-line text-sm">
            {runs.data.map((run) => (
              <li key={run.id} className="flex items-center justify-between py-2">
                <span className="font-mono text-xs">{run.idempotencyKey}</span>
                <Badge>{run.status}</Badge>
                <span className="text-xs text-fg-muted">step {run.checkpoint.completedStepIndex + 1}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
      <Panel title="Lineage">
        <div className="flex items-end gap-2">
          <Input placeholder="Output dataset id" value={lineageDataset} onChange={(event) => setLineageDataset(event.target.value)} />
          <Button size="sm" disabled={busy || !lineageDataset.trim()} onClick={loadLineage}>Load lineage</Button>
        </div>
        {lineage && !lineage.edges.length ? <EmptyState icon={GitBranch} title="No lineage recorded">This dataset was not produced by a pipeline run.</EmptyState> : null}
        {lineage?.edges.length ? (
          <ul className="mt-3 divide-y divide-line text-sm">
            {lineage.edges.map((edge) => (
              <li key={edge.id} className="py-2 font-mono text-xs">run {edge.pipelineRunId ?? 'n/a'} &rarr; input {edge.inputDatasetId ?? 'n/a'}</li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </div>
  );
}

const DataUi: ModuleUi = {
  pages: {
    '': Overview,
    sheets: Sheets,
    sql: SqlConsole,
    pipelines: Pipelines,
  },
};

export default DataUi;

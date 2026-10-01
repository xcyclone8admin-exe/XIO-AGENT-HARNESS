'use client';

import { useCallback, useEffect, useState } from 'react';
import { Workflow, Play, RefreshCw, Ban } from 'lucide-react';
import type { ModulePageProps, ModuleUi } from '@xyra/sdk/module-ui';

type WorkflowDefinition = { id: string; name: string; steps: { id: string; handler: string }[]; enabled: boolean };
type RunState = 'running' | 'succeeded' | 'failed' | 'dead_letter' | 'canceled';
type RunStatus = { runId: string; workflowId: string; state: RunState; stepIndex: number; attempt: number; createdAt: string; endedAt: string | null };

function WorkflowsPage({ workspaceId, api }: ModulePageProps) {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [runsByWorkflow, setRunsByWorkflow] = useState<Record<string, RunStatus[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api || !workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await api.read<WorkflowDefinition[]>(workspaceId, 'flow.workflow.list');
      setWorkflows(list);
      const runs: Record<string, RunStatus[]> = {};
      for (const workflow of list) {
        runs[workflow.id] = await api.read<RunStatus[]>(workspaceId, 'flow.run.list', { workflowId: workflow.id });
      }
      setRunsByWorkflow(runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workflows');
    } finally {
      setLoading(false);
    }
  }, [api, workspaceId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const trigger = useCallback(
    async (workflowId: string) => {
      if (!api || !workspaceId) return;
      try {
        await api.write(workspaceId, 'flow.run.trigger', { workflowId, trigger: 'manual' });
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Trigger failed');
      }
    },
    [api, workspaceId, load],
  );

  const cancel = useCallback(
    async (runId: string) => {
      if (!api || !workspaceId) return;
      try {
        await api.write(workspaceId, 'flow.run.cancel', { runId });
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Cancel failed');
      }
    },
    [api, workspaceId, load],
  );

  if (!workspaceId || !api) return <div className="p-6 text-sm text-muted-foreground">Select a workspace to view workflows.</div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Workflow className="h-5 w-5" aria-hidden="true" />
          <h1 className="text-lg font-semibold">Workflows</h1>
        </div>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 text-sm" aria-label="Refresh workflows">
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
        </button>
      </div>
      {error && <div role="alert" className="text-sm text-destructive">{error}</div>}
      {loading ? (
        <div role="status" className="text-sm text-muted-foreground">Loading workflows…</div>
      ) : workflows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No workflows yet.</div>
      ) : (
        <ul className="space-y-4" aria-label="Workflows">
          {workflows.map((workflow) => (
            <li key={workflow.id} className="border rounded p-4">
              <div className="flex items-center justify-between">
                <div className="font-medium">{workflow.name}</div>
                <button type="button" onClick={() => void trigger(workflow.id)} className="inline-flex items-center gap-1 text-sm">
                  <Play className="h-4 w-4" aria-hidden="true" /> Run
                </button>
              </div>
              <ul className="mt-2 divide-y text-sm" aria-label={`Runs of ${workflow.name}`}>
                {(runsByWorkflow[workflow.id] ?? []).map((run) => (
                  <li key={run.runId} className="py-1 flex items-center justify-between">
                    <span>
                      {run.state} · step {run.stepIndex + 1}/{workflow.steps.length} · attempt {run.attempt + 1}
                    </span>
                    {run.state === 'running' && (
                      <button type="button" onClick={() => void cancel(run.runId)} className="inline-flex items-center gap-1 text-xs">
                        <Ban className="h-3 w-3" aria-hidden="true" /> Cancel
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ui: ModuleUi = { pages: { '': WorkflowsPage } };
export default ui;

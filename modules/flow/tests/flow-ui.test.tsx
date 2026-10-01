// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { createElement } from 'react';
import type { ModuleApi } from '@xyra/sdk';
import FlowUi from '../ui';

afterEach(cleanup);

type WorkflowRow = { id: string; name: string; steps: { id: string; handler: string }[]; enabled: boolean };
type RunRow = { runId: string; workflowId: string; state: string; stepIndex: number; attempt: number; createdAt: string; endedAt: string | null };

const WorkflowsPage = FlowUi.pages[''];
if (!WorkflowsPage) throw new Error('Workflows page missing');

test('prompts for a workspace instead of calling the API when none is selected', () => {
  render(createElement(WorkflowsPage, { api: null, workspaceId: null }));
  expect(screen.getByText('Select a workspace to view workflows.')).toBeTruthy();
});

test('shows a loading state, then an honest empty state with no workflows', async () => {
  const api: ModuleApi = {
    async read<T>(): Promise<T> {
      return [] as T;
    },
    async write<T>(): Promise<T> {
      throw new Error('unexpected write');
    },
  };
  render(createElement(WorkflowsPage, { api, workspaceId: 'workspace-a' }));
  expect(screen.getByRole('status')).toBeTruthy();
  expect(await screen.findByText('No workflows yet.')).toBeTruthy();
});

test('lists a workflow with its runs, each run and its cancel control accessibly labeled', async () => {
  const workflow: WorkflowRow = { id: 'wf-1', name: 'Nightly sync', steps: [{ id: 'only', handler: 'noop' }], enabled: true };
  const run: RunRow = { runId: 'run-1', workflowId: 'wf-1', state: 'running', stepIndex: 0, attempt: 0, createdAt: new Date().toISOString(), endedAt: null };
  const api: ModuleApi = {
    async read<T>(_workspaceId: string, capabilityId: string): Promise<T> {
      if (capabilityId === 'flow.workflow.list') return [workflow] as T;
      if (capabilityId === 'flow.run.list') return [run] as T;
      throw new Error(`unexpected capability: ${capabilityId}`);
    },
    async write<T>(): Promise<T> {
      return undefined as T;
    },
  };
  render(createElement(WorkflowsPage, { api, workspaceId: 'workspace-a' }));
  expect(await screen.findByText('Nightly sync')).toBeTruthy();
  const runList = await screen.findByRole('list', { name: 'Runs of Nightly sync' });
  expect(runList).toBeTruthy();
  expect(screen.getByText(/running · step 1\/1 · attempt 1/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
});

test('does not offer a cancel control for a run that already reached a terminal state', async () => {
  const workflow: WorkflowRow = { id: 'wf-1', name: 'Nightly sync', steps: [{ id: 'only', handler: 'noop' }], enabled: true };
  const run: RunRow = { runId: 'run-1', workflowId: 'wf-1', state: 'succeeded', stepIndex: 0, attempt: 0, createdAt: new Date().toISOString(), endedAt: new Date().toISOString() };
  const api: ModuleApi = {
    async read<T>(_workspaceId: string, capabilityId: string): Promise<T> {
      if (capabilityId === 'flow.workflow.list') return [workflow] as T;
      if (capabilityId === 'flow.run.list') return [run] as T;
      throw new Error(`unexpected capability: ${capabilityId}`);
    },
    async write<T>(): Promise<T> {
      throw new Error('unexpected write');
    },
  };
  render(createElement(WorkflowsPage, { api, workspaceId: 'workspace-a' }));
  await screen.findByText('Nightly sync');
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
});

test('surfaces a load failure as an accessible alert', async () => {
  const api: ModuleApi = {
    async read<T>(): Promise<T> {
      throw new Error('FLOW_WORKFLOWS_UNAVAILABLE');
    },
    async write<T>(): Promise<T> {
      throw new Error('unexpected write');
    },
  };
  render(createElement(WorkflowsPage, { api, workspaceId: 'workspace-a' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('FLOW_WORKFLOWS_UNAVAILABLE');
});

test('run button triggers the workflow and refreshes its run list', async () => {
  const workflow: WorkflowRow = { id: 'wf-1', name: 'Nightly sync', steps: [{ id: 'only', handler: 'noop' }], enabled: true };
  let triggered = false;
  const writes: Array<{ capabilityId: string; input: unknown }> = [];
  const api: ModuleApi = {
    async read<T>(_workspaceId: string, capabilityId: string): Promise<T> {
      if (capabilityId === 'flow.workflow.list') return [workflow] as T;
      if (capabilityId === 'flow.run.list') return (triggered ? [{ runId: 'run-1', workflowId: 'wf-1', state: 'running', stepIndex: 0, attempt: 0, createdAt: new Date().toISOString(), endedAt: null }] : []) as T;
      throw new Error(`unexpected capability: ${capabilityId}`);
    },
    async write<T>(_workspaceId: string, capabilityId: string, input: unknown): Promise<T> {
      writes.push({ capabilityId, input });
      triggered = true;
      return undefined as T;
    },
  };
  render(createElement(WorkflowsPage, { api, workspaceId: 'workspace-a' }));
  await screen.findByText('Nightly sync');
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  await waitFor(() => expect(triggered).toBe(true));
  expect(writes[0]).toMatchObject({ capabilityId: 'flow.run.trigger', input: { workflowId: 'wf-1', trigger: 'manual' } });
  expect(await screen.findByText(/running · step 1\/1 · attempt 1/)).toBeTruthy();
});

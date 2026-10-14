import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { TaskSnapshot, type TaskModelPort, type TaskPlan } from '@xyra/contracts';
import { startLocalSidecar } from './runtime';

async function freePort() {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
async function until(read: () => Promise<TaskSnapshot>, state: string) {
  let current = await read();
  for (let attempt = 0; current.state !== state && attempt < 150; attempt++) {
    if (current.state === 'failed') throw new Error(`Task failed: ${current.error}`);
    await new Promise((resolve) => setTimeout(resolve, 20)); current = await read();
  }
  expect(current.state).toBe(state); return current;
}

test('authenticated chat → scoped read → exact preview → durable write, replay and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xio-task-'));
  const connection = { id: 'controlled:test', provider: 'controlled', model: 'fixture-model', title: 'Controlled test model', locality: 'local' as const, available: true, detail: 'Controlled integration only' };
  let calls = 0;
  let plan: TaskPlan = { summary: 'Inspect projects and propose a procedure candidate.', actions: [
    { capabilityId: 'ops.projects.list', input: {} },
    { capabilityId: 'brain.procedures.propose', input: { title: 'Test procedure', type: 'sop', body: 'A controlled candidate awaiting review.' } },
  ] };
  const models: TaskModelPort = {
    list: async () => [connection], test: async () => connection,
    plan: async (request) => {
      calls++; expect(request.connectionId).toBe(connection.id); expect(request.capabilities.some((cap) => cap.id === 'ops.projects.create')).toBe(false);
      return structuredClone(plan);
    },
  };
  const settings = { dataDir: directory, osSubject: 'test:task-host', displayName: 'Task tester', allowedOrigins: ['http://tauri.localhost'], taskModels: models };
  let session = await startLocalSidecar({ ...settings, port: await freePort() });
  let workspaceId = '';
  const request = (path: string, input?: unknown) => fetch(`http://127.0.0.1:${session.port}${path}`, {
    ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }),
    headers: { authorization: `Bearer ${session.launchToken}`, origin: 'http://tauri.localhost', 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
  });
  const call = async (id: string, input: unknown = {}) => {
    const response = await request(`/api/v1/call/${id}`, { workspaceId, input });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    return (await response.json() as { data: unknown }).data;
  };
  try {
    const identity = await (await request('/api/v1/session')).json() as { workspaces: { id: string; kind: string }[] };
    workspaceId = identity.workspaces.find((w) => w.kind === 'standard')!.id;
    const chat = await call('command.chats.create', { title: 'Governed work' }) as { id: string };
    const input = { chatId: chat.id, instruction: 'Inspect my projects and draft a procedure.', connectionId: connection.id, requestId: crypto.randomUUID() };
    const admittedResponse = await request('/api/v1/tasks/admit', { workspaceId, input });
    expect(admittedResponse.status).toBe(202);
    const admitted = TaskSnapshot.parse(await admittedResponse.json());
    const read = async () => TaskSnapshot.parse(await (await request(`/api/v1/tasks/${admitted.taskId}?workspaceId=${workspaceId}`)).json());
    const preview = await until(read, 'waiting_approval');
    expect(preview.actions[0]?.state).toBe('succeeded');
    expect(preview.actions[1]?.state).toBe('proposed');
    expect(await call('brain.procedures.list', { limit: 50 })).toEqual([]);
    const action = preview.actions[1]!;
    const approval = { taskId: preview.taskId, revision: preview.revision, actionId: action.id, inputDigest: action.inputDigest };
    const changed = await request('/api/v1/tasks/approve', { workspaceId, input: { ...approval, inputDigest: '0'.repeat(64) } });
    expect(changed.status).toBe(409);
    const stale = await request('/api/v1/tasks/approve', { workspaceId, input: { ...approval, revision: 2 } });
    expect(stale.status).toBe(409);
    const decisions = await Promise.all([request('/api/v1/tasks/approve', { workspaceId, input: approval }), request('/api/v1/tasks/approve', { workspaceId, input: approval })]);
    expect(decisions.map((r) => r.status).sort()).toEqual([200, 409]);
    const finished = await until(read, 'completed');
    expect(finished.actions[1]?.state).toBe('succeeded');
    const procedures = await call('brain.procedures.list', { limit: 50 }) as { title: string; status: string }[];
    expect(procedures).toHaveLength(1); expect(procedures[0]?.status).toBe('candidate');
    const duplicate = TaskSnapshot.parse(await (await request('/api/v1/tasks/admit', { workspaceId, input })).json());
    expect(duplicate.taskId).toBe(finished.taskId); expect(calls).toBe(1);
    expect((await request('/api/v1/tasks/admit', { workspaceId, input: { ...input, instruction: 'Changed input' } })).status).toBe(409);
    expect((await request(`/api/v1/tasks/${finished.taskId}?workspaceId=${crypto.randomUUID()}`)).status).toBe(403);
    await session.close(); session = await startLocalSidecar({ ...settings, port: await freePort() });
    const restored = await read(); expect(restored.state).toBe('completed');
    expect(restored.actions[1]?.result).toEqual(finished.actions[1]?.result); expect(restored.events).toEqual(finished.events);
    expect(await call('brain.procedures.list', { limit: 50 })).toHaveLength(1);
    // A non-agent-callable tool must fail before preview or mutation, even when the user owns the workspace.
    plan = { summary: 'Invalid model proposal', actions: [{ capabilityId: 'ops.projects.create', input: { name: 'Must not exist' } }] };
    const denied = TaskSnapshot.parse(await (await request('/api/v1/tasks/admit', { workspaceId, input: { ...input, requestId: crypto.randomUUID() } })).json());
    let rejected = await readTask(denied.taskId);
    for (let i = 0; rejected.state !== 'failed' && i < 100; i++) { await new Promise((resolve) => setTimeout(resolve, 20)); rejected = await readTask(denied.taskId); }
    expect(rejected.error).toBe('TASK_TOOL_NOT_ALLOWED'); expect(await call('ops.projects.list')).toEqual([]);
    async function readTask(taskId: string) { return TaskSnapshot.parse(await (await request(`/api/v1/tasks/${taskId}?workspaceId=${workspaceId}`)).json()); }
  } finally {
    await session.close();
    if (!directory.startsWith(join(tmpdir(), 'xio-task-'))) throw new Error('Unexpected disposable path');
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

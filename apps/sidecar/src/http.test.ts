import { expect, test } from 'vitest';
import { z } from 'zod';
import { defineCapability, defineModule, Principal } from '@xyra/contracts';
import { CapabilityBus } from './bus';
import { createSidecarApp } from './http';

const WORKSPACE = '019a0000-0000-7000-8000-000000000011';
const principal = Principal.parse({
  kind: 'user',
  id: '019a0000-0000-7000-8000-000000000021',
  tenantId: '019a0000-0000-7000-8000-000000000001',
  workspaces: [{ id: WORKSPACE, role: 'owner', kind: 'standard' }],
});
const manifest = defineModule({
  id: 'core',
  version: '1.0.0',
  pillar: 'PLATFORM',
  title: 'Core',
  description: 'x',
  icon: 'settings',
  permissions: ['core:workspace:read'],
});
const descriptor = defineCapability({
  id: 'core.workspace.read',
  title: 'Workspace',
  description: 'Read workspace',
  kind: 'read',
  permission: 'core:workspace:read',
  input: z.object({}),
  output: z.object({ name: z.string() }),
});
const audit: string[] = [];
const bus = new CapabilityBus(
  {
    append: async (record) => {
      audit.push(record.result);
    },
  },
  { get: async () => undefined, put: async () => {} },
  { verify: async () => false },
  () => false,
  async () => new Set(),
);
bus.register(manifest, descriptor, async () => ({ name: 'Real workspace' }));
const TOKEN = 'x'.repeat(43);
const app = createSidecarApp({
  port: 43117,
  launchToken: TOKEN,
  allowedOrigins: ['http://tauri.localhost'],
  resolvePrincipal: async () => principal,
  bus,
});
const url = (path: string) => `http://127.0.0.1:43117${path}`;
const HOST = '127.0.0.1:43117';

test('host, origin and token checks reject untrusted callers', async () => {
  expect((await app.request(url('/api/health'), { headers: { host: HOST } })).status).toBe(200);
  expect((await app.request('http://evil.test/api/health', { headers: { host: 'evil.test' } })).status).toBe(
    403,
  );
  expect(
    (await app.request(url('/api/v1/catalog?workspaceId=' + WORKSPACE), { headers: { host: HOST } })).status,
  ).toBe(401);
  expect(
    (
      await app.request(url('/api/v1/catalog?workspaceId=' + WORKSPACE), {
        headers: { host: HOST, authorization: `Bearer ${TOKEN}`, origin: 'https://evil.test' },
      })
    ).status,
  ).toBe(403);
});

test('the HTTP call resolves its own principal and runs the shared bus', async () => {
  const response = await app.request(url('/api/v1/call/core.workspace.read'), {
    method: 'POST',
    headers: {
      host: HOST,
      authorization: `Bearer ${TOKEN}`,
      origin: 'http://tauri.localhost',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ workspaceId: WORKSPACE, input: {}, principal: { kind: 'system' } }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { name: 'Real workspace' } });
  expect(audit).toContain('succeeded');
});

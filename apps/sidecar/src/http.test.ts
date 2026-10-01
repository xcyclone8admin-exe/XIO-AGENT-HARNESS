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
  { verify: async () => null },
  () => false,
  async () => new Set(),
);
bus.register(manifest, descriptor, async () => ({ name: 'Real workspace' }));
const TOKEN = 'x'.repeat(43);
const NATIVE_SYNC_TOKEN = 'n'.repeat(43);
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

test('Cloud sync result callback requires a separate native-only token and validates the pair', async () => {
  const path = '/internal/native/cloud-sync/push';
  const changeId = '019a0000-0000-7000-8000-000000000061';
  const hlc = '1790000000000-0003-devicea';
  const request = {
    protocolVersion: 1,
    schemaVersion: 'cloud-sync-v1',
    nodeId: 'devicea',
    idempotencyKey: 'native-sync-00000001',
    changes: [
      {
        table: 'brain_sources',
        id: changeId,
        tenantId: principal.tenantId,
        workspaceId: WORKSPACE,
        op: 'upsert',
        fields: { title: { value: 'source', hlc, baseHlc: null } },
        hlc,
      },
    ],
  };
  const response = {
    accepted: 1,
    conflicts: 0,
    serverSeq: '1',
    rejected: [],
    conflictHistory: [],
    changeOutcomes: [
      {
        index: 0,
        changeId,
        table: 'brain_sources',
        rowId: changeId,
        outcome: 'committed',
        appliedFields: ['title'],
        unchangedFields: [],
        conflictedFields: [],
      },
    ],
    replayed: false,
  };
  let recorded = 0;
  const nativeApp = createSidecarApp({
    port: 43118,
    launchToken: TOKEN,
    nativeSyncToken: NATIVE_SYNC_TOKEN,
    allowedOrigins: ['http://tauri.localhost'],
    resolvePrincipal: async () => principal,
    bus,
    acceptCloudSyncPush: async (scope, receivedRequest, receivedResponse) => {
      expect(scope).toEqual({ tenantId: principal.tenantId, workspaceId: WORKSPACE });
      expect(receivedRequest).toEqual(request);
      expect(receivedResponse).toEqual(response);
      recorded += 1;
    },
  });
  const endpoint = `http://127.0.0.1:43118${path}`;
  const body = JSON.stringify({ request, response });
  const userTokenAttempt = await nativeApp.request(endpoint, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:43118',
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body,
  });
  expect(userTokenAttempt.status).toBe(403);
  const webviewOriginAttempt = await nativeApp.request(endpoint, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:43118',
      authorization: `Bearer ${NATIVE_SYNC_TOKEN}`,
      origin: 'http://tauri.localhost',
      'content-type': 'application/json',
    },
    body,
  });
  expect(webviewOriginAttempt.status).toBe(403);
  const accepted = await nativeApp.request(endpoint, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:43118',
      'x-xyra-native-sync-token': NATIVE_SYNC_TOKEN,
      'content-type': 'application/json',
    },
    body,
  });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ status: 'recorded' });
  expect(recorded).toBe(1);
  const missingOutcomes = await nativeApp.request(endpoint, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:43118',
      'x-xyra-native-sync-token': NATIVE_SYNC_TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ request, response: { ...response, changeOutcomes: undefined } }),
  });
  expect(missingOutcomes.status).toBe(409);
  expect(recorded).toBe(1);

  const wrongTenantRequest = {
    ...request,
    changes: [{ ...request.changes[0]!, tenantId: '019a0000-0000-7000-8000-000000000099' }],
  };
  const wrongScope = await nativeApp.request(endpoint, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:43118',
      'x-xyra-native-sync-token': NATIVE_SYNC_TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ request: wrongTenantRequest, response }),
  });
  expect(wrongScope.status).toBe(403);
  expect(recorded).toBe(1);
});

test('Cloud Invest signal handoff is native-only, scope-bound, and returns only a durable decision id', async () => {
  const path = '/internal/native/invest/signals/consume';
  const decisionId = '019a0000-0000-7000-8000-000000000081';
  const now = Date.now();
  const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
  const claim = {
    status: 'claimed',
    lease: {
      leaseId: '019a0000-0000-7000-8000-000000000082',
      fence: 3,
      expiresAt: iso(now + 20_000),
    },
    signal: {
      protocol: 'xyra.invest.signal.v1',
      eventId: 'feed:event-1',
      sourceId: '019a0000-0000-7000-8000-000000000083',
      tenantId: principal.tenantId,
      workspaceId: WORKSPACE,
      receivedAt: iso(now),
      occurredAt: iso(now - 1_000),
      expiresAt: iso(now + 60_000),
      algorithmId: 'momentum-v1',
      signalId: 'sig-1',
      symbol: 'XYRA',
      side: 'buy',
      quantity: '2.5',
      payloadDigest: 'a'.repeat(64),
      verification: {
        signature: 'verified',
        keyId: '019a0000-0000-7000-8000-000000000084',
      },
    },
  };
  let accepted = 0;
  const nativeApp = createSidecarApp({
    port: 43119,
    launchToken: TOKEN,
    nativeSyncToken: NATIVE_SYNC_TOKEN,
    allowedOrigins: ['http://tauri.localhost'],
    resolvePrincipal: async () => principal,
    bus,
    acceptCloudInvestSignal: async (scope, receivedClaim, actorId) => {
      expect(scope).toEqual({ tenantId: principal.tenantId, workspaceId: WORKSPACE });
      expect(receivedClaim).toEqual(claim);
      expect(actorId).toBe(principal.id);
      accepted += 1;
      return { decisionId };
    },
  });
  const endpoint = `http://127.0.0.1:43119${path}`;
  const headers = {
    host: '127.0.0.1:43119',
    'x-xyra-native-sync-token': NATIVE_SYNC_TOKEN,
    'content-type': 'application/json',
  };
  const forgedRendererCall = await nativeApp.request(endpoint, {
    method: 'POST',
    headers: { ...headers, origin: 'http://tauri.localhost' },
    body: JSON.stringify(claim),
  });
  expect(forgedRendererCall.status).toBe(403);
  const launchTokenCall = await nativeApp.request(endpoint, {
    method: 'POST',
    headers: { host: '127.0.0.1:43119', authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(claim),
  });
  expect(launchTokenCall.status).toBe(403);
  const valid = await nativeApp.request(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(claim),
  });
  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({ decisionId });
  expect(accepted).toBe(1);

  const badVerification = {
    ...claim,
    signal: { ...claim.signal, verification: { signature: 'unverified', keyId: claim.signal.verification.keyId } },
  };
  const rejected = await nativeApp.request(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(badVerification),
  });
  expect(rejected.status).toBe(400);
  expect(accepted).toBe(1);

  const wrongScope = {
    ...claim,
    signal: { ...claim.signal, tenantId: '019a0000-0000-7000-8000-000000000099' },
  };
  const scopeRejected = await nativeApp.request(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(wrongScope),
  });
  expect(scopeRejected.status).toBe(403);
  expect(accepted).toBe(1);
});

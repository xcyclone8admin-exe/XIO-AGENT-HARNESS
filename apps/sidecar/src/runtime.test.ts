import { createServer } from 'node:net';
import { expect, test } from 'vitest';
import { startLocalSidecar } from './runtime';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test('local runtime serves an authenticated, scoped workspace session', async () => {
  const port = await freePort();
  const session = await startLocalSidecar({
    dataDir: 'memory://',
    port,
    osSubject: 'test:local',
    displayName: 'Local test',
    allowedOrigins: ['http://tauri.localhost'],
  });
  try {
    const url = `http://127.0.0.1:${port}/api/v1/session`;
    const unauthenticated = await fetch(url);
    expect(unauthenticated.status).toBe(401);
    const authenticated = await fetch(url, {
      headers: {
        authorization: `Bearer ${session.launchToken}`,
        origin: 'http://tauri.localhost',
      },
    });
    expect(authenticated.status).toBe(200);
    const body = (await authenticated.json()) as { workspaces: Array<{ id: string; kind: string }> };
    expect(body.workspaces.map((w) => w.kind).sort()).toEqual(['sample', 'standard']);
    const workspaceId = body.workspaces.find((w) => w.kind === 'standard')?.id;
    expect(workspaceId).toBeTruthy();
    const created = await fetch(`http://127.0.0.1:${port}/api/v1/call/forge.projects.create`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.launchToken}`,
        origin: 'http://tauri.localhost',
        'content-type': 'application/json',
        'idempotency-key': 'runtime-forge-create-0001',
      },
      body: JSON.stringify({ workspaceId, input: { name: 'Runtime Forge', description: 'Integrated workflow', requirements: [] } }),
    });
    expect(created.status, JSON.stringify(await created.clone().json())).toBe(200);
    const createdBody = await created.json() as { data: { id: string; name: string } };
    expect(createdBody.data.name).toBe('Runtime Forge');
  } finally {
    await session.close();
  }
}, 60_000);

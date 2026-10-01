import { expect, test } from 'vitest';
import { applyPGliteMigrations, LocalScopedStore, prepareLocalAppRole } from '@xyra/db';
import { openLocalStore } from '@xyra/db/pglite';
import { PGliteLedgerWriter } from '@xyra/ledger';
import { bootstrapLocalIdentity } from '@xyra/mod-core/server';
import { InvestService } from '@xyra/mod-invest/server/service';
import { MIGRATIONS } from './generated/migrations';
import { MANIFESTS } from './generated/modules';
import { CapabilityBus } from './bus';
import { createSidecarApp, type CloudInvestSignalClaim } from './http';

test('native Cloud signal handoff persists one scoped PAPER decision before ACK and fences replay', async () => {
  const db = await openLocalStore();
  try {
    await applyPGliteMigrations(db, MIGRATIONS);
    await prepareLocalAppRole(db, MANIFESTS.flatMap((manifest) => manifest.tables));
    const scoped = new LocalScopedStore(db);
    const principal = await bootstrapLocalIdentity(db, 'test:signal-consumer', 'Signal consumer');
    const workspace = principal.workspaces.find((entry) => entry.kind === 'standard');
    if (!workspace) throw new Error('standard workspace missing');
    const ledger = new PGliteLedgerWriter(db);
    const invest = new InvestService(scoped, ledger, ledger, {
      getKillSwitch: async () => ({ engaged: false, reason: null, changedBy: null, changedAt: null }),
    });
    const bus = new CapabilityBus(
      { append: async () => {} },
      { get: async () => undefined, put: async () => {} },
      { verify: async () => null },
      () => false,
      async () => new Set(),
    );
    const nativeToken = 'n'.repeat(43);
    const port = 43129;
    const app = createSidecarApp({
      port,
      launchToken: 'l'.repeat(43),
      nativeSyncToken: nativeToken,
      allowedOrigins: ['http://tauri.localhost'],
      resolvePrincipal: async () => principal,
      bus,
      acceptCloudInvestSignal: (scope, claim, actorId) =>
        invest.consumeCloudInvestSignal(scope, claim.signal, claim.lease, actorId),
    });
    const now = Date.now();
    const iso = (millis: number) => new Date(millis).toISOString();
    const claim: CloudInvestSignalClaim = {
      status: 'claimed',
      lease: {
        leaseId: '019a0000-0000-7000-8000-000000000301',
        fence: 1,
        expiresAt: iso(now + 20_000),
      },
      signal: {
        protocol: 'xyra.invest.signal.v1',
        eventId: 'integration:signal-1',
        sourceId: '019a0000-0000-7000-8000-000000000302',
        tenantId: principal.tenantId,
        workspaceId: workspace.id,
        receivedAt: iso(now),
        occurredAt: iso(now - 1_000),
        expiresAt: iso(now + 60_000),
        algorithmId: 'momentum-v1',
        signalId: '019a0000-0000-7000-8000-000000000303',
        symbol: 'UNLISTED',
        side: 'buy',
        quantity: '1.25',
        payloadDigest: 'a'.repeat(64),
        verification: {
          signature: 'verified',
          keyId: '019a0000-0000-7000-8000-000000000304',
        },
      },
    };
    const endpoint = `http://127.0.0.1:${port}/internal/native/invest/signals/consume`;
    const postClaim = (value: CloudInvestSignalClaim) => app.request(endpoint, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        'x-xyra-native-sync-token': nativeToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify(value),
    });

    const first = await postClaim(claim);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { decisionId: string };
    expect(firstBody.decisionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM invest_signal_decisions WHERE tenant_id=$1 AND workspace_id=$2`,
      [principal.tenantId, workspace.id],
    ).then((result) => result.rows[0]?.count)).toBe(1);

    const replay = await postClaim(claim);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const staleLease = { ...claim, lease: { ...claim.lease, leaseId: '019a0000-0000-7000-8000-000000000305' } };
    const rejectedReplay = await postClaim(staleLease);
    expect(rejectedReplay.status).toBe(409);
    expect(await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM invest_signal_decisions WHERE tenant_id=$1 AND workspace_id=$2`,
      [principal.tenantId, workspace.id],
    ).then((result) => result.rows[0]?.count)).toBe(1);
    expect(await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM invest_orders WHERE tenant_id=$1 AND workspace_id=$2`,
      [principal.tenantId, workspace.id],
    ).then((result) => result.rows[0]?.count)).toBe(0);
  } finally {
    await db.close();
  }
}, 60_000);

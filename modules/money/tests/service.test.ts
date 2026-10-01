import { expect, test, vi } from 'vitest';
import { Principal } from '@xyra/contracts';
import type { AnyCapability, ModuleManifest } from '@xyra/contracts';
import type { LedgerApi, LedgerScope } from '@xyra/ledger/contracts';
import { ledgerCapabilities } from '@xyra/ledger/contracts';
import manifest from '../manifest';
import { MoneyService } from '../server/service';

test('Money registers the full frozen ledger capability set and derives scope from trusted principal context', async () => {
  const registered = new Map<string, {
    descriptor: AnyCapability;
    handler: (input: unknown, call: { principal: ReturnType<typeof Principal.parse>; workspaceId: string }) => Promise<unknown>;
  }>();
  const register = vi.fn((
    _manifest: ModuleManifest,
    descriptor: AnyCapability,
    handler: (input: unknown, call: { principal: ReturnType<typeof Principal.parse>; workspaceId: string }) => Promise<unknown>,
  ) => registered.set(descriptor.id, { descriptor, handler }));
  const observed: { scope?: LedgerScope; actorId?: string } = {};
  const ledger = {
    createBook: vi.fn(async (scope: LedgerScope, actorId: string) => {
      observed.scope = scope;
      observed.actorId = actorId;
      return { id: '019a0000-0000-7000-8000-000000000099' };
    }),
  } as unknown as LedgerApi;
  const service = new MoneyService(ledger);
  service.register({ register });

  expect(register).toHaveBeenCalledTimes(Object.keys(ledgerCapabilities).length);
  expect([...registered.keys()].sort()).toEqual(Object.values(ledgerCapabilities).map((x) => x.id).sort());
  expect([...registered.values()].every(({ descriptor }) => descriptor.module === manifest.id)).toBe(true);

  const principal = Principal.parse({
    kind: 'user', id: '019a0000-0000-7000-8000-000000000021', tenantId: '019a0000-0000-7000-8000-000000000001',
    workspaces: [{ id: '019a0000-0000-7000-8000-000000000011', role: 'owner', kind: 'standard' }], grants: [],
  });
  const createBook = registered.get(ledgerCapabilities.createBook.id);
  if (!createBook) throw new Error('Create-book capability missing');
  await createBook.handler({
    name: 'Trusted scope', environment: 'paper', baseAsset: 'USD', ownerModule: 'money', purpose: 'business',
    tenantId: '019a0000-0000-7000-8000-000000000099', workspaceId: '019a0000-0000-7000-8000-000000000099',
  }, { principal, workspaceId: '019a0000-0000-7000-8000-000000000011' });
  expect(observed.scope).toMatchObject({
    tenantId: principal.tenantId, workspaceId: '019a0000-0000-7000-8000-000000000011',
  });
  expect(observed.scope?.hlc).toMatch(/^\d{13}-[0-9a-f]{4}-money$/);
  expect(observed.actorId).toBe(principal.id);
});

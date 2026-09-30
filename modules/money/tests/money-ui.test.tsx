// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { createElement } from 'react';
import type { ModuleApi } from '@xyra/sdk';
import MoneyUi from '../ui';
import { ledgerCapabilities as caps } from '@xyra/ledger/contracts';

test('finance overview starts honestly empty, registers its first asset, and keeps paper visibly labeled', async () => {
  let hasUsd = false;
  const reads: Array<{ capabilityId: string; input: unknown }> = [];
  const api: ModuleApi = {
    async read<T>(_workspaceId: string, capabilityId: string, input: unknown = {}): Promise<T> {
      reads.push({ capabilityId, input });
      if (capabilityId === caps.assets.id) return (hasUsd ? [{ code: 'USD', scale: 2, kind: 'fiat', name: 'US dollar' }] : []) as T;
      if (capabilityId === caps.balances.id || capabilityId === caps.discrepancies.id) return [] as T;
      if (capabilityId === caps.transactions.id) return { items: [], nextCursor: null } as T;
      if (capabilityId === caps.totals.id) return {
        environment: 'actual', asset: 'USD', scale: 2,
        byType: { asset: '0', liability: '0', equity: '0', income: '0', expense: '0' }, bookCount: 0,
      } as T;
      throw new Error(`unexpected capability: ${capabilityId}`);
    },
    async write<T>(_workspaceId: string, capabilityId: string): Promise<T> {
      expect(capabilityId).toBe(caps.ensureAssets.id);
      hasUsd = true;
      return undefined as T;
    },
  };
  const Overview = MoneyUi.pages[''];
  if (!Overview) throw new Error('Overview page missing');
  render(createElement(Overview, { api, workspaceId: 'workspace-a' }));
  expect(await screen.findByText('Register an asset to get started')).toBeTruthy();
  expect(screen.getByText(/No default currency or financial data/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Asset code'), { target: { value: 'USD' } });
  fireEvent.change(screen.getByLabelText('Asset name'), { target: { value: 'US dollar' } });
  fireEvent.click(screen.getByRole('button', { name: 'Register asset' }));
  expect(await screen.findByText('Account balances')).toBeTruthy();
  expect(screen.getByText('External income feeds')).toBeTruthy();
  expect(screen.getByText(/No posted balances yet/)).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Environment'), { target: { value: 'paper' } });
  await waitFor(() => expect(screen.getAllByText('PAPER').length).toBeGreaterThan(0));
  await waitFor(() => expect(reads.some((entry) => (entry.input as { environment?: string }).environment === 'paper')).toBe(true));
});

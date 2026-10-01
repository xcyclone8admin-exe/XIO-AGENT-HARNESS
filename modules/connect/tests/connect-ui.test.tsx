// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { createElement } from 'react';
import type { ModuleApi } from '@xyra/sdk';
import ConnectUi from '../ui';

afterEach(cleanup);

type ConnectorRow = {
  id: string;
  name: string;
  family: string;
  state: 'CONNECTED' | 'NOT_CONFIGURED' | 'DEGRADED' | 'ERROR' | 'REAUTH_REQUIRED' | 'DISABLED';
  detail: string;
  checkedAt: string | null;
  availability: 'available' | 'not-yet-available';
  custody: 'local-keychain' | 'cloud-envelope' | 'none';
};

const CatalogPage = ConnectUi.pages[''];
if (!CatalogPage) throw new Error('Catalog page missing');

test('renders nothing destructive and prompts for a workspace when none is selected', () => {
  render(createElement(CatalogPage, { api: null, workspaceId: null }));
  expect(screen.getByText('Select a workspace to view connectors.')).toBeTruthy();
});

test('shows a loading state, then an honest empty state when the catalog has no connectors', async () => {
  const api: ModuleApi = {
    async read<T>(): Promise<T> {
      return [] as T;
    },
    async write<T>(): Promise<T> {
      throw new Error('unexpected write');
    },
  };
  render(createElement(CatalogPage, { api, workspaceId: 'workspace-a' }));
  expect(screen.getByRole('status')).toBeTruthy();
  expect(await screen.findByText('No connectors registered yet.')).toBeTruthy();
});

test('lists connectors with accessible labels and never shows CONNECTED for a not-yet-available one', async () => {
  const connectors: ConnectorRow[] = [
    { id: 'stripe', name: 'Stripe', family: 'payments', state: 'NOT_CONFIGURED', detail: 'Registered; not yet configured.', checkedAt: null, availability: 'not-yet-available', custody: 'none' },
    { id: 'github', name: 'GitHub', family: 'dev', state: 'NOT_CONFIGURED', detail: 'Registered; not yet configured.', checkedAt: null, availability: 'available', custody: 'local-keychain' },
  ];
  const api: ModuleApi = {
    async read<T>(): Promise<T> {
      return connectors as T;
    },
    async write<T>(): Promise<T> {
      return undefined as T;
    },
  };
  render(createElement(CatalogPage, { api, workspaceId: 'workspace-a' }));
  const list = await screen.findByRole('list', { name: 'Registered connectors' });
  expect(list).toBeTruthy();
  expect(screen.getByText(/Stripe/)).toBeTruthy();
  expect(screen.getByText(/Not yet available in this build/)).toBeTruthy();
  expect(screen.queryByText(/Connected/)).toBeNull();

  // The not-yet-available connector's Grant button is disabled; the available one's is not.
  const grantButtons = screen.getAllByRole('button', { name: 'Grant' });
  expect(grantButtons).toHaveLength(2);
  expect(grantButtons[0]?.hasAttribute('disabled')).toBe(true);
  expect(grantButtons[1]?.hasAttribute('disabled')).toBe(false);
});

test('surfaces a read failure as an accessible alert instead of a silent blank screen', async () => {
  const api: ModuleApi = {
    async read<T>(): Promise<T> {
      throw new Error('CONNECT_CATALOG_UNAVAILABLE');
    },
    async write<T>(): Promise<T> {
      throw new Error('unexpected write');
    },
  };
  render(createElement(CatalogPage, { api, workspaceId: 'workspace-a' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('CONNECT_CATALOG_UNAVAILABLE');
});

test('grant action calls the capability with the connector id and refreshes the catalog', async () => {
  let granted = false;
  const writes: Array<{ capabilityId: string; input: unknown }> = [];
  const connector: ConnectorRow = { id: 'github', name: 'GitHub', family: 'dev', state: 'NOT_CONFIGURED', detail: '', checkedAt: null, availability: 'available', custody: 'local-keychain' };
  const api: ModuleApi = {
    async read<T>(): Promise<T> {
      return [connector] as T;
    },
    async write<T>(_workspaceId: string, capabilityId: string, input: unknown): Promise<T> {
      writes.push({ capabilityId, input });
      granted = true;
      return undefined as T;
    },
  };
  render(createElement(CatalogPage, { api, workspaceId: 'workspace-a' }));
  const grantButton = await screen.findByRole('button', { name: 'Grant' });
  fireEvent.click(grantButton);
  await waitFor(() => expect(granted).toBe(true));
  expect(writes[0]).toMatchObject({ capabilityId: 'connect.connector.grant', input: { connectorId: 'github', action: 'grant' } });
});

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plug, RefreshCw, ShieldOff, ShieldCheck } from 'lucide-react';
import type { ModulePageProps, ModuleUi } from '@xyra/sdk/module-ui';

type ConnectorState = 'CONNECTED' | 'NOT_CONFIGURED' | 'DEGRADED' | 'ERROR' | 'REAUTH_REQUIRED' | 'DISABLED';
type ConnectorRecord = {
  id: string;
  name: string;
  family: string;
  state: ConnectorState;
  detail: string;
  checkedAt: string | null;
  availability: 'available' | 'not-yet-available';
  custody: 'local-keychain' | 'cloud-envelope' | 'none';
};

const STATE_LABEL: Record<ConnectorState, string> = {
  CONNECTED: 'Connected',
  NOT_CONFIGURED: 'Not configured',
  DEGRADED: 'Degraded',
  ERROR: 'Error',
  REAUTH_REQUIRED: 'Re-authorization required',
  DISABLED: 'Disabled',
};

function CatalogPage({ workspaceId, api }: ModulePageProps) {
  const [connectors, setConnectors] = useState<ConnectorRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api || !workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      setConnectors(await api.read<ConnectorRecord[]>(workspaceId, 'connect.catalog.list'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connector catalog');
    } finally {
      setLoading(false);
    }
  }, [api, workspaceId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const toggleGrant = useCallback(
    async (connector: ConnectorRecord, action: 'grant' | 'revoke') => {
      if (!api || !workspaceId) return;
      setBusyId(connector.id);
      try {
        await api.write(workspaceId, 'connect.connector.grant', { connectorId: connector.id, action, allowedTools: [], reason: '' });
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Grant action failed');
      } finally {
        setBusyId(null);
      }
    },
    [api, workspaceId, load],
  );

  if (!workspaceId || !api) return <div className="p-6 text-sm text-muted-foreground">Select a workspace to view connectors.</div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5" aria-hidden="true" />
          <h1 className="text-lg font-semibold">Connector catalog</h1>
        </div>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 text-sm" aria-label="Refresh catalog">
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
        </button>
      </div>
      {error && (
        <div role="alert" className="text-sm text-destructive">
          {error}
        </div>
      )}
      {loading ? (
        <div role="status" className="text-sm text-muted-foreground">Loading connectors…</div>
      ) : connectors.length === 0 ? (
        <div className="text-sm text-muted-foreground">No connectors registered yet.</div>
      ) : (
        <ul className="divide-y" aria-label="Registered connectors">
          {connectors.map((connector) => (
            <li key={connector.id} className="py-3 flex items-center justify-between gap-4">
              <div>
                <div className="font-medium">{connector.name}</div>
                <div className="text-xs text-muted-foreground">
                  {connector.family} · {STATE_LABEL[connector.state]}
                  {connector.availability === 'not-yet-available' ? ' · Not yet available in this build' : ''}
                </div>
                <div className="text-xs text-muted-foreground">{connector.detail}</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busyId === connector.id || connector.availability === 'not-yet-available'}
                  onClick={() => void toggleGrant(connector, 'grant')}
                  className="inline-flex items-center gap-1 text-sm"
                >
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Grant
                </button>
                <button
                  type="button"
                  disabled={busyId === connector.id}
                  onClick={() => void toggleGrant(connector, 'revoke')}
                  className="inline-flex items-center gap-1 text-sm"
                >
                  <ShieldOff className="h-4 w-4" aria-hidden="true" /> Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ui: ModuleUi = { pages: { '': CatalogPage } };
export default ui;

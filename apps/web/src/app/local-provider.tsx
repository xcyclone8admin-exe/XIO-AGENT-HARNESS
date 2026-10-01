'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  CloudIngestionClient,
  LocalApiClient,
  NativeCloudTransport,
  type LocalSession,
  type NativeCloudInvoker,
} from '@xyra/sdk';

interface WorkspaceChoice {
  id: string;
  name: string;
  kind: 'standard' | 'sample';
}
interface LocalState {
  api: LocalApiClient | null;
  cloudIngestion: CloudIngestionClient | null;
  session: LocalSession | null;
  workspaces: WorkspaceChoice[];
  workspaceId: string | null;
  status: 'connecting' | 'connected' | 'unavailable';
  selectWorkspace(id: string): void;
}

declare global {
  interface Window {
    /** Native host injects this bridge before or during WebView initialization. */
    xyraNative?: {
      getSession(): Promise<{ port: number; token: string }>;
      /** Native host exposes only fixed Cloud commands, never generic invoke or credentials. */
      invoke?: NativeCloudInvoker;
    };
  }
}

const LocalContext = createContext<LocalState>({
  api: null,
  cloudIngestion: null,
  session: null,
  workspaces: [],
  workspaceId: null,
  status: 'connecting',
  selectWorkspace: () => {},
});

export function useLocal(): LocalState {
  return useContext(LocalContext);
}

export function LocalProvider({ children }: { children: ReactNode }) {
  const [api, setApi] = useState<LocalApiClient | null>(null);
  const [cloudIngestion, setCloudIngestion] = useState<CloudIngestionClient | null>(null);
  const [session, setSession] = useState<LocalSession | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceChoice[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [status, setStatus] = useState<LocalState['status']>('connecting');

  useEffect(() => {
    let active = true;
    const connect = async () => {
      if (!window.xyraNative) {
        if (active) {
          setStatus('unavailable');
          setCloudIngestion(null);
        }
        return;
      }
      try {
        const { port, token } = await window.xyraNative.getSession();
        const client = new LocalApiClient(port, token);
        const identity = await client.session();
        const choices = await Promise.all(
          identity.workspaces.map(async (workspace) => {
            const row = await client.read<{ name: string } | null>(workspace.id, 'core.workspace.get');
            return { id: workspace.id, name: row?.name ?? 'Workspace', kind: workspace.kind };
          }),
        );
        if (!active) return;
        const saved = window.localStorage.getItem('xyra.workspace');
        const chosen = choices.find((w) => w.id === saved) ?? choices[0];
        setApi(client);
        setCloudIngestion(
          window.xyraNative.invoke
            ? new CloudIngestionClient(new NativeCloudTransport(window.xyraNative.invoke))
            : null,
        );
        setSession(identity);
        setWorkspaces(choices);
        setWorkspaceId(chosen?.id ?? null);
        setStatus('connected');
      } catch {
        if (active) {
          setStatus('unavailable');
          setCloudIngestion(null);
        }
      }
    };
    void connect();
    window.addEventListener('xyra:session-ready', connect);
    return () => {
      active = false;
      window.removeEventListener('xyra:session-ready', connect);
    };
  }, []);

  const selectWorkspace = (id: string) => {
    if (!workspaces.some((w) => w.id === id)) return;
    setWorkspaceId(id);
    window.localStorage.setItem('xyra.workspace', id);
  };
  return (
    <LocalContext.Provider
      value={{ api, cloudIngestion, session, workspaces, workspaceId, status, selectWorkspace }}
    >
      {children}
    </LocalContext.Provider>
  );
}

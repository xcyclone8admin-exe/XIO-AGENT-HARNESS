'use client';

import { useEffect, useState, type ComponentType } from 'react';
import type { ModulePageProps } from '@xyra/sdk/module-ui';
import { AppShell, ErrorState, LoadingState } from '@xyra/ui';
import { MANIFESTS, UI_LOADERS } from '../generated/modules';
import { useLocal } from './local-provider';

export function ModuleView({ module, route }: { module: string; route: string }) {
  const local = useLocal();
  const [Page, setPage] = useState<ComponentType<ModulePageProps> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let live = true;
    const load = UI_LOADERS[module];
    if (!load) return;
    void load().then(
      ({ default: ui }) => {
        if (live) {
          setPage(() => ui.pages[route] ?? null);
          setError(ui.pages[route] ? null : new Error('Page unavailable'));
        }
      },
      () => {
        if (live) setError(new Error('Module could not load'));
      },
    );
    return () => {
      live = false;
    };
  }, [module, route]);
  return (
    <AppShell
      manifests={MANIFESTS}
      activePath={`/${module}${route ? '/' + route : ''}/`}
      workspaceLabel={local.workspaces.find((w) => w.id === local.workspaceId)?.name}
      workspaces={local.workspaces}
      activeWorkspaceId={local.workspaceId}
      onSelectWorkspace={local.selectWorkspace}
    >
      {error ? (
        <ErrorState error={error} />
      ) : Page ? (
        <Page workspaceId={local.workspaceId} api={local.api} />
      ) : (
        <LoadingState label="Loading module" />
      )}
    </AppShell>
  );
}

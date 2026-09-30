'use client';

import { AppShell, EmptyState, PageHeader, Panel } from '@xyra/ui';
import { Compass } from 'lucide-react';
import { MANIFESTS } from '../generated/modules';
import { useLocal } from './local-provider';

export default function HomePage() {
  const local = useLocal();
  return (
    <AppShell
      manifests={MANIFESTS}
      activePath="/"
      workspaces={local.workspaces}
      activeWorkspaceId={local.workspaceId}
      onSelectWorkspace={local.selectWorkspace}
    >
      <PageHeader
        eyebrow="Command"
        title="Welcome"
        description={
          local.session
            ? `Signed in locally as ${local.session.user.displayName}.`
            : 'Choose a workspace to begin.'
        }
      />
      <Panel>
        {local.workspaces.length ? (
          <div className="space-y-3">
            <h2 className="font-semibold">Workspaces</h2>
            {local.workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                onClick={() => {
                  local.selectWorkspace(workspace.id);
                  window.location.assign('/ops/');
                }}
                className="block w-full rounded-lg border border-line p-4 text-left hover:bg-surface-2"
              >
                <span className="font-medium">{workspace.name}</span>
                <span className="ml-2 text-xs text-fg-muted">{workspace.kind}</span>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Compass}
            title={
              local.status === 'connecting' ? 'Connecting to local service' : 'Local service unavailable'
            }
          >
            {local.status === 'connecting'
              ? 'Loading your workspaces.'
              : 'Launch XYRA from the desktop app to access your workspaces.'}
          </EmptyState>
        )}
      </Panel>
    </AppShell>
  );
}

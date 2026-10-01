'use client';

import { MANIFESTS } from '../generated/modules';
import { ChatWorkspace } from './chat-workspace';
import { useLocal } from './local-provider';

export default function HomePage() {
  const local = useLocal();
  return <ChatWorkspace api={local.api} workspaceId={local.workspaceId}
    workspaceName={local.workspaces.find((workspace) => workspace.id === local.workspaceId)?.name ?? ''}
    manifests={MANIFESTS} onSelectWorkspace={local.selectWorkspace} workspaces={local.workspaces}
    sessionName={local.session?.user.displayName ?? (local.status === 'connecting' ? 'Connecting…' : 'Offline')} />;
}

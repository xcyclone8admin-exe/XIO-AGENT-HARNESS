'use client';

import { ClipboardList, FolderKanban } from 'lucide-react';
import type { ModuleUi } from '@xyra/sdk/module-ui';
import { EmptyState, PageHeader, Panel } from '@xyra/ui';

function Projects() {
  return (
    <>
      <PageHeader eyebrow="Command" title="Projects" description="Track work across teams and agents." />
      <Panel>
        <EmptyState icon={FolderKanban} title="Projects unavailable">
          Connect the local service to load projects.
        </EmptyState>
      </Panel>
    </>
  );
}
function Tasks() {
  return (
    <>
      <PageHeader eyebrow="Command" title="Tasks" description="Work items, owners and deadlines." />
      <Panel>
        <EmptyState icon={ClipboardList} title="Tasks unavailable">
          Connect the local service to load tasks.
        </EmptyState>
      </Panel>
    </>
  );
}

const ui: ModuleUi = { pages: { '': Projects, tasks: Tasks } };
export default ui;

'use client';

import { FileClock, ShieldCheck, Settings2, Users } from 'lucide-react';
import type { ModuleUi, ModulePageProps } from '@xyra/sdk/module-ui';
import { EmptyState, PageHeader, Panel } from '@xyra/ui';

function Workspace({ workspaceId }: ModulePageProps) {
  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Workspace"
        description="People, access and operating context for this workspace."
      />
      <Panel>
        <EmptyState icon={Users} title={workspaceId ? 'Workspace details are loading' : 'Choose a workspace'}>
          {workspaceId
            ? 'The local service is connecting.'
            : 'Select or create a workspace to see its members and settings.'}
        </EmptyState>
      </Panel>
    </>
  );
}
function Approvals() {
  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Approvals"
        description="Review consequential actions before they run."
      />
      <Panel>
        <EmptyState icon={ShieldCheck} title="Approval queue unavailable">
          Connect the local service to load pending requests.
        </EmptyState>
      </Panel>
    </>
  );
}
function Audit() {
  return (
    <>
      <PageHeader
        eyebrow="Governance"
        title="Audit"
        description="A chronological record of decisions and actions."
      />
      <Panel>
        <EmptyState icon={FileClock} title="Audit log unavailable">
          Connect the local service to load the audit trail.
        </EmptyState>
      </Panel>
    </>
  );
}
function Settings() {
  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Settings"
        description="Configure your local workspace and preferences."
      />
      <Panel>
        <EmptyState icon={Settings2} title="Settings unavailable">
          Connect the local service to load settings.
        </EmptyState>
      </Panel>
    </>
  );
}

const ui: ModuleUi = { pages: { '': Workspace, approvals: Approvals, audit: Audit, settings: Settings } };
export default ui;

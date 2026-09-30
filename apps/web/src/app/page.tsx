'use client';

import { AppShell, EmptyState, PageHeader, Panel } from '@xyra/ui';
import { Compass } from 'lucide-react';
import { MANIFESTS } from '../generated/modules';

export default function HomePage() {
  return (
    <AppShell manifests={MANIFESTS} activePath="/">
      <PageHeader eyebrow="Command" title="Welcome" description="Choose a workspace to begin." />
      <Panel>
        <EmptyState icon={Compass} title="Choose a workspace">
          Your work appears here after the local service connects.
        </EmptyState>
      </Panel>
    </AppShell>
  );
}

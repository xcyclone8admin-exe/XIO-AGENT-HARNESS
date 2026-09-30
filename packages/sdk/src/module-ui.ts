import type { ComponentType } from 'react';

export interface ModulePageProps {
  readonly workspaceId: string | null;
}

/** Keys match each module manifest's nav path; the empty string is its root. */
export interface ModuleUi {
  readonly pages: Readonly<Record<string, ComponentType<ModulePageProps>>>;
  readonly widgets?: Readonly<Record<string, ComponentType<ModulePageProps>>>;
}

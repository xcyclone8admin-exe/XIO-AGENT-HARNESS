import { notFound } from 'next/navigation';
import { MANIFESTS, UI_LOADERS } from '../../../generated/modules';
import { ModuleView } from '../../module-view';

export const dynamicParams = false;

export function generateStaticParams() {
  return MANIFESTS.flatMap((manifest) =>
    manifest.nav.map((entry) => ({
      module: manifest.id,
      path: entry.path ? entry.path.split('/') : [],
    })),
  );
}

export default async function ModulePage({
  params,
}: {
  params: Promise<{ module: string; path?: string[] }>;
}) {
  const { module, path = [] } = await params;
  const manifest = MANIFESTS.find((item) => item.id === module);
  const route = path.join('/');
  const load = UI_LOADERS[module];
  if (!manifest || !manifest.nav.some((item) => item.path === route) || !load) notFound();
  return <ModuleView module={module} route={route} />;
}

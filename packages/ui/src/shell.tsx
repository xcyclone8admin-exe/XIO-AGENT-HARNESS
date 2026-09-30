'use client';

import { Command } from 'cmdk';
import { Command as CommandIcon, Menu, Moon, Search, Sun, X } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ModuleManifest } from '@xyra/contracts';
import { PRODUCT_NAME } from '@xyra/brand';
import { Button, cn, Kbd } from './primitives';

type Theme = 'system' | 'light' | 'dark';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    const saved = window.localStorage.getItem('xyra.theme');
    if (saved === 'light' || saved === 'dark') {
      const frame = window.requestAnimationFrame(() => setTheme(saved));
      return () => window.cancelAnimationFrame(frame);
    }
  }, []);
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    window.localStorage.setItem('xyra.theme', theme);
  }, [theme]);
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (value: Theme) => void }>({
  theme: 'system',
  setTheme: () => {},
});
export function ThemeToggle() {
  const { theme, setTheme } = useContext(ThemeContext);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={`Theme: ${theme}`}
      onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
    >
      {theme === 'dark' ? <Moon aria-hidden className="size-4" /> : <Sun aria-hidden className="size-4" />}
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}

function pathFor(module: ModuleManifest, path: string): string {
  return `/${module.id}${path ? '/' + path : ''}/`;
}

export function AppShell({
  manifests,
  activePath,
  workspaceLabel,
  workspaces = [],
  activeWorkspaceId,
  onSelectWorkspace,
  children,
}: {
  manifests: readonly ModuleManifest[];
  activePath: string;
  workspaceLabel?: string | undefined;
  workspaces?: readonly { id: string; name: string; kind: 'standard' | 'sample' }[];
  activeWorkspaceId?: string | null;
  onSelectWorkspace?: (id: string) => void;
  children: ReactNode;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
      if (event.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const grouped = useMemo(() => {
    const byPillar = new Map<string, ModuleManifest[]>();
    for (const module of [...manifests].sort((a, b) => a.order - b.order)) {
      byPillar.set(module.pillar, [...(byPillar.get(module.pillar) ?? []), module]);
    }
    return [...byPillar];
  }, [manifests]);
  const navigation = grouped.map(([pillar, modules]) => (
    <div key={pillar} className="mb-4">
      <div className="px-2 pb-1 text-[0.714rem] font-semibold uppercase tracking-widest text-fg-subtle">
        {pillar}
      </div>
      {modules.flatMap((module) =>
        module.nav
          .filter((item) => !item.hidden)
          .map((item) => {
            const href = pathFor(module, item.path);
            return (
              <a
                key={href}
                href={href}
                aria-current={activePath === href ? 'page' : undefined}
                className={cn(
                  'mb-0.5 block rounded-md px-2.5 py-1.5 text-[0.857rem] transition-colors hover:bg-surface-2 hover:text-fg',
                  activePath === href ? 'bg-accent-soft font-medium text-accent-text' : 'text-fg-muted',
                )}
              >
                {item.title}
              </a>
            );
          }),
      )}
    </div>
  ));
  return (
    <div className="flex min-h-screen bg-bg text-fg">
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-overlay md:hidden"
        />
      ) : null}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-60 shrink-0 flex-col border-r border-line bg-surface md:sticky md:top-0 md:z-auto md:h-screen md:flex',
          sidebarOpen ? '' : 'hidden',
        )}
        aria-label="Main navigation"
      >
        <div className="flex h-14 items-center gap-2 border-b border-line px-4">
          <div
            aria-hidden
            className="flex size-7 items-center justify-center rounded-md bg-accent text-sm font-bold text-accent-fg"
          >
            X
          </div>
          <span className="truncate text-sm font-semibold tracking-tight">{PRODUCT_NAME}</span>
          <button
            type="button"
            className="ml-auto rounded p-1 md:hidden"
            aria-label="Close navigation"
            onClick={() => setSidebarOpen(false)}
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
        <div className="border-b border-line px-3 py-3">
          {workspaces.length ? (
            <select
              aria-label="Current workspace"
              value={activeWorkspaceId ?? ''}
              onChange={(event) => onSelectWorkspace?.(event.target.value)}
              className="w-full rounded-md border border-line bg-surface-2 px-2.5 py-2 text-sm"
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="rounded-md border border-line bg-surface-2 px-2.5 py-2 text-sm">
              {workspaceLabel ?? 'Choose a workspace'}
            </div>
          )}
        </div>
        <nav className="xy-scrollbar flex-1 overflow-y-auto px-2 py-3">{navigation}</nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface/95 px-4 backdrop-blur md:px-7">
          <button
            type="button"
            className="mr-3 rounded p-1 md:hidden"
            aria-label="Open navigation"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu aria-hidden className="size-5" />
          </button>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-8 w-full max-w-xs items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 text-left text-[0.857rem] text-fg-subtle hover:border-line-strong"
          >
            <Search aria-hidden className="size-3.5" /> Search or run a command{' '}
            <span className="ml-auto hidden sm:block">
              <Kbd>Ctrl K</Kbd>
            </span>
          </button>
          <div className="ml-4 flex items-center gap-2">
            <ThemeToggle />
          </div>
        </header>
        <main id="main-content" className="mx-auto max-w-[1600px] px-4 py-6 md:px-7">
          {children}
        </main>
      </div>
      {paletteOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-overlay px-4 pt-[12vh]"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPaletteOpen(false);
          }}
        >
          <Command
            label="Command palette"
            className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface shadow-2"
          >
            <div className="flex items-center gap-2 border-b border-line px-4">
              <CommandIcon aria-hidden className="size-4 text-fg-subtle" />
              <Command.Input
                autoFocus
                placeholder="Find a page…"
                className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-fg-subtle"
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-2">
              <Command.Empty className="px-3 py-8 text-center text-sm text-fg-muted">
                No matching pages
              </Command.Empty>
              {manifests.flatMap((module) =>
                module.nav
                  .filter((item) => !item.hidden)
                  .map((item) => (
                    <Command.Item
                      key={pathFor(module, item.path)}
                      value={`${module.title} ${item.title} ${item.keywords.join(' ')}`}
                      onSelect={() => {
                        window.location.assign(pathFor(module, item.path));
                      }}
                      className="cursor-pointer rounded-md px-3 py-2 text-sm text-fg aria-selected:bg-accent-soft aria-selected:text-accent-text"
                    >
                      {module.title} / {item.title}
                    </Command.Item>
                  )),
              )}
            </Command.List>
          </Command>
        </div>
      ) : null}
    </div>
  );
}

'use client';

import { Command } from 'cmdk';
import { ChevronDown, Command as CommandIcon, Moon, Search, Sun } from 'lucide-react';
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
  children,
}: {
  manifests: readonly ModuleManifest[];
  activePath: string;
  workspaceLabel?: string;
  children: ReactNode;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
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
  return (
    <div className="flex min-h-screen bg-bg text-fg">
      <aside
        className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface md:flex"
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
        </div>
        <div className="border-b border-line px-3 py-3">
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-md border border-line bg-surface-2 px-2.5 py-2 text-left text-sm"
            aria-label="Current workspace"
          >
            <span className="truncate">{workspaceLabel ?? 'Choose a workspace'}</span>
            <ChevronDown aria-hidden className="size-3.5 text-fg-muted" />
          </button>
        </div>
        <nav className="xy-scrollbar flex-1 overflow-y-auto px-2 py-3">
          {grouped.map(([pillar, modules]) => (
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
                          activePath === href
                            ? 'bg-accent-soft font-medium text-accent-text'
                            : 'text-fg-muted',
                        )}
                      >
                        {item.title}
                      </a>
                    );
                  }),
              )}
            </div>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface/95 px-4 backdrop-blur md:px-7">
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

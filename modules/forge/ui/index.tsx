import { useState } from 'react';
import { Hammer, ShieldCheck, GitBranch, ClipboardCheck, LockKeyhole } from 'lucide-react';
import type { ModulePageProps, ModuleUi } from '@xyra/sdk/module-ui';

const surfaces = [
  { title: 'Projects & hierarchy', detail: 'Plan Epics, Specs, Plans, Waves, Tickets and Subtasks with traceable acceptance criteria.', icon: GitBranch, state: 'Planning surface' },
  { title: 'Specification & context', detail: 'Compile twelve structured spec templates and a provenance-ranked minimal context manifest.', icon: ClipboardCheck, state: 'Local compiler' },
  { title: 'Review council & Gauntlet', detail: 'Record structured adversarial findings and evaluate deterministic evidence gates first.', icon: ShieldCheck, state: 'Evidence-led' },
  { title: 'Promotion records', detail: 'Request evidence-gated promotion records. Live ref changes and deployment remain disabled.', icon: LockKeyhole, state: 'Promotion disabled' },
];

function ForgePage(_props: ModulePageProps) {
    const [selected, setSelected] = useState(0);
    return (
      <main className="mx-auto w-full max-w-6xl space-y-7 p-6 md:p-10" aria-labelledby="forge-title">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <span className="rounded-xl border border-border bg-muted p-3 text-foreground"><Hammer aria-hidden="true" className="h-5 w-5" /></span>
            <div><p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Project engineering</p><h1 id="forge-title" className="mt-1 text-2xl font-semibold tracking-tight">Forge</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Requirements, project hierarchy, review and verifiable evidence in one workspace.</p></div>
          </div>
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">Local planning · execution disabled</span>
        </header>
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Forge surfaces">
          {surfaces.map((surface, index) => {
            const Icon = surface.icon;
            return <button key={surface.title} type="button" onClick={() => setSelected(index)} aria-pressed={selected === index} className={`rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected === index ? 'border-foreground/25 bg-muted/70' : 'border-border bg-card hover:bg-muted/40'}`}>
              <Icon aria-hidden="true" className="h-4 w-4 text-muted-foreground" /><h2 className="mt-4 text-sm font-semibold">{surface.title}</h2><p className="mt-2 min-h-12 text-xs leading-5 text-muted-foreground">{surface.detail}</p><span className="mt-4 inline-flex rounded-full bg-background px-2.5 py-1 text-[11px] text-muted-foreground">{surface.state}</span>
            </button>;
          })}
        </section>
        <section className="rounded-xl border border-border bg-card p-5 md:p-7" aria-live="polite">
          <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Selected surface</p><h2 className="mt-2 text-lg font-semibold">{surfaces[selected]?.title}</h2><p className="mt-1 text-sm text-muted-foreground">{surfaces[selected]?.detail}</p></div><span className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground">No project selected</span></div>
          <div className="mt-6 rounded-lg border border-dashed border-border px-5 py-10 text-center"><p className="text-sm font-medium">Choose a project to get started</p><p className="mx-auto mt-2 max-w-md text-xs leading-5 text-muted-foreground">Project creation and record management are available through the Forge contracts. No example data is shown here.</p></div>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1.5"><ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />C1 safeguards active</span><span aria-hidden="true">·</span><span>Runner unavailable for this build</span><span aria-hidden="true">·</span><span>External adapters disabled</span></div>
        </section>
      </main>
    );
}

const ForgeUi: ModuleUi = { pages: { '': ForgePage, reviews: ForgePage, gates: ForgePage, promotions: ForgePage } };

export default ForgeUi;

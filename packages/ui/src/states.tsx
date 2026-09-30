/**
 * Mandatory state primitives (ADR-0007). Every page renders exactly one of these whenever it is not
 * showing real data: no blank screens, no fabricated content (REQ-008, REQ-012).
 */
import { AlertTriangle, Copy, FlaskConical, Lock, RefreshCw, WifiOff, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, cn } from './primitives';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('xy-skeleton rounded-md', className)} />;
}

export function LoadingState({ label = 'Loading', rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3 py-2">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-9', i === 0 ? 'w-2/3' : i % 2 ? 'w-full' : 'w-5/6')} />
      ))}
    </div>
  );
}

function StateFrame({
  icon: Icon,
  tone,
  title,
  children,
  actions,
}: {
  icon: LucideIcon;
  tone: string;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center xy-enter">
      <div className={cn('mb-4 flex size-11 items-center justify-center rounded-xl', tone)}>
        <Icon aria-hidden className="size-5" />
      </div>
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {children ? <div className="mt-1.5 max-w-md text-sm text-fg-muted">{children}</div> : null}
      {actions ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

/** Explains why something is empty and offers the primary next action. */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <StateFrame icon={icon} tone="bg-surface-2 text-fg-muted" title={title} actions={action}>
      {children}
    </StateFrame>
  );
}

export interface ProblemLike {
  code?: string;
  detail?: string;
  message?: string;
  traceId?: string;
}

export function ErrorState({
  error,
  onRetry,
  title = 'Something went wrong',
}: {
  error: ProblemLike | Error | unknown;
  onRetry?: () => void;
  title?: ReactNode;
}) {
  const p = (error ?? {}) as ProblemLike;
  const code = p.code ?? 'INTERNAL';
  const detail = p.detail ?? p.message ?? 'The operation could not be completed.';
  const [copied, setCopied] = useState(false);
  const diagnostics = JSON.stringify({
    code,
    detail,
    traceId: p.traceId ?? null,
    at: new Date().toISOString(),
  });
  return (
    <div role="alert">
      <StateFrame
        icon={AlertTriangle}
        tone="bg-negative-soft text-negative"
        title={title}
        actions={
          <>
            {onRetry ? (
              <Button variant="primary" size="sm" onClick={onRetry}>
                <RefreshCw aria-hidden className="size-3.5" /> Try again
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(diagnostics).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              <Copy aria-hidden className="size-3.5" /> {copied ? 'Copied' : 'Copy diagnostics'}
            </Button>
          </>
        }
      >
        <p>{detail}</p>
        <p className="mt-1 font-mono text-[0.786rem] text-fg-subtle">{code}</p>
      </StateFrame>
    </div>
  );
}

export function OfflineState({ what = 'This view', onRetry }: { what?: string; onRetry?: () => void }) {
  return (
    <StateFrame
      icon={WifiOff}
      tone="bg-caution-soft text-caution"
      title="Local service unavailable"
      actions={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            Reconnect
          </Button>
        ) : undefined
      }
    >
      {what} needs the local agent service. Nothing was saved while it was unreachable.
    </StateFrame>
  );
}

export function PermissionDenied({ permission }: { permission?: string }) {
  return (
    <StateFrame icon={Lock} tone="bg-surface-2 text-fg-muted" title="You don't have access">
      Ask a workspace owner or admin for access.
      {permission ? (
        <span className="mt-1 block font-mono text-[0.786rem] text-fg-subtle">{permission}</span>
      ) : null}
    </StateFrame>
  );
}

/** Permanent, non-dismissable banner for sample workspaces (ADR-0011). */
export function SampleBanner() {
  return (
    <div
      role="note"
      className="flex items-center gap-2 border-b border-caution/30 bg-caution-soft px-4 py-1.5 text-[0.857rem] text-caution"
    >
      <FlaskConical aria-hidden className="size-4 shrink-0" />
      <span>
        <strong className="font-semibold">Sample workspace.</strong> Everything here is illustrative sample
        data, not real records. It is excluded from totals, sync and outbound actions.
      </span>
    </div>
  );
}

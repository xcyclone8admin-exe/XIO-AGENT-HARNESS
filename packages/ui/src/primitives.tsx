import { Slot } from '@radix-ui/react-slot';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Loader2 } from 'lucide-react';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-1',
  secondary: 'bg-surface text-fg border border-line hover:bg-surface-2 hover:border-line-strong',
  ghost: 'text-fg-muted hover:text-fg hover:bg-surface-2',
  danger: 'bg-negative text-white hover:opacity-90',
};
const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[0.857rem] gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-md',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  asChild?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    asChild = false,
    loading = false,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
      {children}
    </Comp>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(function IconButton(
  { label, className, size = 'md', variant = 'ghost', ...rest },
  ref,
) {
  return (
    <Button
      ref={ref}
      aria-label={label}
      title={label}
      variant={variant}
      size={size}
      className={cn(size === 'sm' ? 'w-7 px-0' : 'w-9 px-0', className)}
      {...rest}
    />
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle transition-colors hover:border-line-strong focus-visible:border-focus',
        className,
      )}
      {...rest}
    />
  );
});

export type Tone = 'neutral' | 'accent' | 'positive' | 'negative' | 'caution' | 'info';
const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-fg-muted',
  accent: 'bg-accent-soft text-accent-text',
  positive: 'bg-positive-soft text-positive',
  negative: 'bg-negative-soft text-negative',
  caution: 'bg-caution-soft text-caution',
  info: 'bg-info-soft text-info',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-[0.786rem] font-medium leading-none',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line bg-surface-2 px-1 font-mono text-[0.714rem] text-fg-muted">
      {children}
    </kbd>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('rounded-lg border border-line bg-surface shadow-1', className)}>
      {title || actions ? (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="truncate text-sm font-semibold text-fg">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-[0.857rem] text-fg-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 pb-5">
      <div className="min-w-0">
        {eyebrow ? (
          <div className="mb-1 text-[0.786rem] font-medium uppercase tracking-[0.08em] text-fg-subtle">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-[1.57rem] font-semibold leading-tight tracking-[-0.01em] text-fg">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <TooltipPrimitive.Root delayDuration={350}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-md bg-fg px-2 py-1 text-[0.786rem] text-bg shadow-2 xy-enter"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;

export function Stat({
  label,
  value,
  delta,
  tone,
}: {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[0.786rem] font-medium text-fg-subtle">{label}</div>
      <div className="tabular mt-1 text-[1.43rem] font-semibold leading-none tracking-[-0.01em] text-fg">
        {value}
      </div>
      {delta ? (
        <div className="mt-1.5">
          <Badge tone={tone ?? 'neutral'}>{delta}</Badge>
        </div>
      ) : null}
    </div>
  );
}

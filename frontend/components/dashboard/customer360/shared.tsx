/**
 * Customer-360 shared primitives — the small, repeated pieces every federated
 * panel leans on. Kept here so the panels stay consistent (one tone map, one
 * priority pill, one "connect" / "read-only" notice, one empty/section shell).
 *
 * All visual language is design-system tokens (no legacy `co-*` leaf classes).
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Plug, Lock } from 'lucide-react';
import { Badge, type BadgeVariant, cn } from '@/components/ui';
import { IconTile } from '@/components/ui/IconTile';
import type { Priority } from '@/lib/customers';

/* ── status tone → Badge variant ──────────────────────────────────────────── */
/** Map the data-layer status tone (`ok|warn|info|muted`) to a Badge variant. */
export function toneVariant(tone: string): BadgeVariant {
  switch (tone) {
    case 'ok':
      return 'success';
    case 'warn':
      return 'warning';
    case 'info':
      return 'info';
    default:
      return 'neutral';
  }
}

/** A status pill straight from a `{ label, tone }` status-label helper. */
export function StatusPill({ status, className }: { status: { label: string; tone: string }; className?: string }) {
  return (
    <Badge variant={toneVariant(status.tone)} className={className}>
      {status.label}
    </Badge>
  );
}

/* ── priority ─────────────────────────────────────────────────────────────── */
const PRIORITY_META: Record<Priority, { label: string; text: string; well: string; dot: string }> = {
  HIGH: { label: 'High', text: 'text-danger', well: 'bg-danger-subtle', dot: 'bg-danger' },
  MEDIUM: { label: 'Medium', text: 'text-warning', well: 'bg-warning-subtle', dot: 'bg-warning' },
  LOW: { label: 'Low', text: 'text-tertiary', well: 'bg-surface-overlay', dot: 'bg-muted' },
};

/** PriorityPill — the relationship priority as a tinted, dotted pill. */
export function PriorityPill({ priority, className }: { priority: Priority; className?: string }) {
  const m = PRIORITY_META[priority];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
        m.well,
        m.text,
        className,
      )}
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', m.dot)} />
      {m.label}
    </span>
  );
}

/* ── panel section shell ──────────────────────────────────────────────────── */
/**
 * PanelSection — a federated-panel card with a gradient IconTile header, a
 * source/connection tag on the right, and an arbitrary body. Every right-rail
 * panel uses this so the cockpit reads as one coherent stack of "app tiles".
 */
export function PanelSection({
  icon,
  gradient,
  title,
  subtitle,
  tag,
  children,
  className,
}: {
  icon: LucideIcon;
  gradient: string;
  title: string;
  subtitle?: ReactNode;
  /** Right-aligned status / source tag (e.g. "federated · accounting-ops"). */
  tag?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-token-lg border border-subtle bg-surface-raised text-secondary shadow-token',
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-subtle px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconTile icon={icon} gradient={gradient} size="sm" />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-primary">{title}</h3>
            {subtitle && <p className="truncate text-[11px] text-tertiary">{subtitle}</p>}
          </div>
        </div>
        {tag && <div className="shrink-0">{tag}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A muted "federated · X" / "X · not connected" source tag for panel headers. */
export function SourceTag({ configured, source }: { configured: boolean; source: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        configured ? 'bg-surface-overlay text-tertiary' : 'bg-warning-subtle text-warning',
      )}
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', configured ? 'bg-success' : 'bg-warning')} />
      {configured ? `federated · ${source}` : `${source} · offline`}
    </span>
  );
}

/**
 * ConnectNotice — the degrade-clean "connect X" state, shown when a federated
 * app is not configured. A calm, on-brand call-to-action (not an error).
 */
export function ConnectNotice({ app, children }: { app: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-token border border-dashed border-subtle bg-surface-overlay/40 px-3.5 py-3">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-token bg-warning-subtle text-warning">
        <Plug className="h-[15px] w-[15px]" strokeWidth={2.25} />
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-secondary">Connect {app}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-tertiary">{children}</p>
      </div>
    </div>
  );
}

/**
 * EntitlementNotice — the read-only state shown when the federated app is
 * connected but the caller lacks the SKU to act (history still renders above).
 */
export function EntitlementNotice({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 flex items-center gap-1.5 text-xs text-tertiary">
      <Lock className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
      {children}
    </p>
  );
}

/** EmptyRow — a centered, muted "nothing here yet" line inside a panel. */
export function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="py-3 text-center text-[13px] text-tertiary">{children}</p>;
}

/**
 * ListRow — the canonical federated-list row: a title + a muted meta line on the
 * left, a trailing slot (status pill / tag) on the right. Optional leading dot.
 */
export function ListRow({
  title,
  meta,
  trailing,
  leadingDot,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  leadingDot?: string;
  className?: string;
}) {
  return (
    <li
      className={cn(
        'flex items-center gap-3 rounded-token px-2.5 py-2 transition-colors hover:bg-surface-overlay/60',
        className,
      )}
    >
      {leadingDot && <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', leadingDot)} />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-primary">{title}</div>
        {meta && <div className="truncate text-xs text-tertiary">{meta}</div>}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </li>
  );
}

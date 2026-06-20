'use client';

/* =============================================================================
   OverviewShell — the shared chrome for the command-center "across the
   workspace" surfaces (Invoices · Email · Outreach).
   -----------------------------------------------------------------------------
   Each of those pages reads one backend overview endpoint and renders a table
   where every row deep-links to a customer's 360. They share the same skeleton:
   a hero header (IconTile + title + one-line description), a summary ribbon of
   tiles, and a Card-wrapped table with loading / empty / error states. This
   component owns that skeleton so the three pages stay visually identical and
   each one only describes its columns + summary.

   Visual language is design-system tokens throughout (mirrors the Pipeline hero
   + the customer-360 panels), so the surfaces read as one coherent cockpit.
   ========================================================================== */

import type { ReactNode } from 'react';
import { AlertTriangle, RotateCw, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconTile } from '@/components/ui/IconTile';
import { cn } from '@/components/ui/cn';
import { Table, THead, TBody, TH } from '@/components/ui/Table';

/* ── Header ───────────────────────────────────────────────────────────────── */

/** The hero header band — gradient IconTile, an eyebrow, the title + sub. Echoes
 *  the Pipeline page header so every command-center surface opens the same way. */
export function OverviewHeader({
  icon,
  gradient,
  eyebrow,
  title,
  description,
  onRefresh,
  refreshing,
  refreshDisabled,
}: {
  icon: LucideIcon;
  gradient: string;
  eyebrow: string;
  title: string;
  description: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshDisabled?: boolean;
}) {
  return (
    <header className="relative overflow-hidden rounded-token-xl border border-subtle bg-surface-raised/60 px-5 py-4">
      <div aria-hidden className="co-glow absolute -left-12 -top-16 h-40 w-64 opacity-60" />
      <div aria-hidden className="co-glow co-glow-cyan absolute -right-14 -top-20 h-40 w-64 opacity-40" />
      <div className="relative flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <IconTile icon={icon} gradient={gradient} size="lg" />
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-tertiary">{eyebrow}</p>
            <h1 className="text-xl font-semibold tracking-tight text-primary">{title}</h1>
            <p className="mt-0.5 text-xs leading-relaxed text-tertiary">{description}</p>
          </div>
        </div>
        {onRefresh && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={onRefresh}
            disabled={refreshDisabled || refreshing}
            leading={<RotateCw className={cn('h-4 w-4', refreshing && 'animate-spin')} strokeWidth={2.4} />}
          >
            Refresh
          </Button>
        )}
      </div>
    </header>
  );
}

/* ── Summary ribbon ───────────────────────────────────────────────────────── */

/** A compact KPI tile for the summary ribbon — a big value + a small label,
 *  optionally accented. Renders a skeleton bar while the first load resolves. */
export function RibbonStat({
  label,
  value,
  accent,
  loading,
}: {
  label: string;
  value: ReactNode;
  accent?: boolean;
  loading?: boolean;
}) {
  return (
    <div className="rounded-token-lg border border-subtle bg-surface-raised px-4 py-3 shadow-token">
      <div className="text-[11px] font-medium uppercase tracking-wide text-tertiary">{label}</div>
      {loading ? (
        <div className="mt-1.5 h-6 w-16 animate-pulse rounded bg-surface-overlay" />
      ) : (
        <div className={cn('mt-1 font-mono text-2xl font-semibold tabular-nums', accent ? 'text-accent' : 'text-primary')}>
          {value}
        </div>
      )}
    </div>
  );
}

/** The summary ribbon row — a responsive grid of tiles + an optional trailing
 *  by-status / by-type breakdown of small dotted chips. */
export function SummaryRibbon({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

/** A small "label: count" breakdown chip group for a by-status / by-type split.
 *  Lives inside its own ribbon tile so it spans gracefully. */
export function BreakdownTile({
  label,
  entries,
  loading,
}: {
  label: string;
  entries: Array<{ key: string; label: string; count: number; dot?: string }>;
  loading?: boolean;
}) {
  return (
    <div className="rounded-token-lg border border-subtle bg-surface-raised px-4 py-3 shadow-token sm:col-span-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-tertiary">{label}</div>
      {loading ? (
        <div className="mt-2 flex gap-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-5 w-20 animate-pulse rounded-full bg-surface-overlay" />)}
        </div>
      ) : entries.length === 0 ? (
        <div className="mt-1.5 text-sm text-muted">—</div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {entries.map((e) => (
            <span
              key={e.key}
              className="inline-flex items-center gap-1.5 rounded-full bg-surface-overlay px-2.5 py-0.5 text-xs font-medium text-tertiary"
            >
              {e.dot && <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', e.dot)} />}
              {e.label}
              <span className="font-mono tabular-nums text-secondary">{e.count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Table card + states ──────────────────────────────────────────────────── */

/** The table shell: a Card scroller with the sticky header the caller describes,
 *  switching between skeleton / empty / rows + an optional footer count. */
export function OverviewTableCard({
  columns,
  loading,
  isEmpty,
  empty,
  footer,
  children,
}: {
  columns: Array<{ key: string; label: string; align?: 'left' | 'right' }>;
  loading: boolean;
  isEmpty: boolean;
  empty: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden" padded={false}>
      <div className="max-h-[calc(100vh-19rem)] overflow-auto">
        <Table>
          <THead>
            <tr>
              {columns.map((c) => (
                <TH key={c.key} align={c.align ?? 'left'}>{c.label}</TH>
              ))}
            </tr>
          </THead>
          <TBody>
            {loading ? (
              <OverviewSkeletonRows columns={columns.length} />
            ) : isEmpty ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-16">{empty}</td>
              </tr>
            ) : (
              children
            )}
          </TBody>
        </Table>
      </div>
      {!loading && !isEmpty && footer && (
        <div className="flex items-center justify-between border-t border-subtle px-4 py-2.5 text-xs text-tertiary">
          {footer}
        </div>
      )}
    </Card>
  );
}

/** Generic skeleton rows for the overview tables (first cell is the contact). */
function OverviewSkeletonRows({ columns }: { columns: number }) {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} className="[&>td]:border-b [&>td]:border-subtle">
          <td className="px-4 py-2.5">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-surface-overlay" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-3 w-36 animate-pulse rounded bg-surface-overlay" />
                <div className="h-2.5 w-24 animate-pulse rounded bg-surface-overlay/70" />
              </div>
            </div>
          </td>
          {Array.from({ length: Math.max(0, columns - 1) }).map((__, j) => (
            <td key={j} className="px-3 py-2.5"><div className="h-3 w-16 animate-pulse rounded bg-surface-overlay" /></td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** The centered, on-brand empty state for an overview table (calm, not an error). */
export function OverviewEmpty({
  icon,
  gradient,
  title,
  children,
}: {
  icon: LucideIcon;
  gradient: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center text-center">
      <IconTile icon={icon} gradient={gradient} size="lg" glow />
      <h3 className="mt-4 text-sm font-semibold text-primary">{title}</h3>
      <p className="mt-1 text-sm text-tertiary">{children}</p>
    </div>
  );
}

/** The fatal error state (workspace failed / fetch failed) with a retry. */
export function OverviewError({
  message,
  onRetry,
  retrying,
  canRetry = true,
}: {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
  canRetry?: boolean;
}) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-token-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">Couldn&rsquo;t load this view</p>
        <p className="mt-0.5 break-words text-danger/85">{message}</p>
      </div>
      {canRetry && (
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto shrink-0"
          onClick={onRetry}
          disabled={retrying}
          leading={<RotateCw className={cn('h-4 w-4', retrying && 'animate-spin')} strokeWidth={2.4} />}
        >
          Retry
        </Button>
      )}
    </div>
  );
}

'use client';

import { useId, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Search, Plus, Users, AlertTriangle, X, ChevronRight, type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StageBadge } from '@/components/ui/StageBadge';
import { IconTile } from '@/components/ui/IconTile';
import { cn } from '@/components/ui/cn';
import { STAGE_META } from '@/components/ui/tokens';
import {
  Table, THead, TBody, TR, TH, TD, type SortDirection,
} from '@/components/ui/Table';
import {
  type CustomerRow, type Stage, type Priority,
  STAGES, STAGE_LABEL, contactLabel, money,
} from '@/lib/customers';

/* ── Presentational relationships data table ──────────────────────────────────
 * Owns only VIEW state (active stage filter, search query, sort) derived over the
 * `rows` it's handed; it never fetches. The page wraps it with the live data +
 * loading/empty/error chrome. World-class table affordances: stage filter chips
 * with live counts, instant text search, keyboard-operable sortable columns, a
 * sticky frosted header, zebra/hover rows, and overdue-aware next-action dates.
 * ─────────────────────────────────────────────────────────────────────────── */

export interface RelationshipsTableProps {
  rows: CustomerRow[];
  /** Streams the skeleton through the real chrome while the first load resolves. */
  loading?: boolean;
  /** Open the "new relationship" affordance (header + zero-state CTA). */
  onNew?: () => void;
}

type StageFilter = Stage | 'ALL';
type SortKey =
  | 'contact' | 'stage' | 'priority' | 'owner'
  | 'expectedValue' | 'nextAction' | 'lastActivity';

interface ColumnDef {
  key: SortKey;
  label: string;
  align: 'left' | 'right';
  sortable: boolean;
  /** Default direction when first sorting by this column. */
  initialDir: SortDirection;
}

const COLUMNS: ColumnDef[] = [
  { key: 'contact', label: 'Contact', align: 'left', sortable: true, initialDir: 'asc' },
  { key: 'stage', label: 'Stage', align: 'left', sortable: true, initialDir: 'asc' },
  { key: 'priority', label: 'Priority', align: 'left', sortable: true, initialDir: 'desc' },
  { key: 'owner', label: 'Owner', align: 'left', sortable: true, initialDir: 'asc' },
  { key: 'expectedValue', label: 'Expected value', align: 'right', sortable: true, initialDir: 'desc' },
  { key: 'nextAction', label: 'Next action', align: 'left', sortable: true, initialDir: 'asc' },
  { key: 'lastActivity', label: 'Last activity', align: 'left', sortable: true, initialDir: 'desc' },
];
// +1 for the trailing "open profile" chevron column (not in COLUMNS, which
// drives the sortable headers).
const COLSPAN = COLUMNS.length + 1;

const PRIORITY_RANK: Record<Priority, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const STAGE_RANK: Record<Stage, number> = { LEAD: 1, PROSPECT: 2, CUSTOMER: 3 };

const PRIORITY_META: Record<Priority, { label: string; dot: string; text: string }> = {
  HIGH: { label: 'High', dot: 'bg-danger', text: 'text-danger' },
  MEDIUM: { label: 'Medium', dot: 'bg-warning', text: 'text-warning' },
  LOW: { label: 'Low', dot: 'bg-muted', text: 'text-tertiary' },
};

export function RelationshipsTable({ rows, loading = false, onNew }: RelationshipsTableProps) {
  const [filter, setFilter] = useState<StageFilter>('ALL');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('nextAction');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');
  const searchId = useId();

  // Live per-stage counts for the filter chips (over the full, unfiltered set).
  const counts = useMemo(() => {
    const c: Record<StageFilter, number> = { ALL: rows.length, LEAD: 0, PROSPECT: 0, CUSTOMER: 0 };
    for (const r of rows) c[r.stage] += 1;
    return c;
  }, [rows]);

  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    let out = filter === 'ALL' ? rows : rows.filter((r) => r.stage === filter);
    if (q) {
      out = out.filter((r) => {
        const hay = [
          contactLabel(r),
          r.contact?.primaryEmail,
          r.contact?.currentOrgName,
          r.ownerUserKey,
          r.source,
        ];
        return hay.some((v) => v && v.toLowerCase().includes(q));
      });
    }
    return out;
  }, [rows, filter, q]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (r: CustomerRow): string | number => {
      switch (sortKey) {
        case 'contact': return contactLabel(r).toLowerCase();
        case 'stage': return STAGE_RANK[r.stage];
        case 'priority': return PRIORITY_RANK[r.priority];
        case 'owner': return (r.ownerUserKey ?? '').toLowerCase();
        case 'expectedValue': return r.expectedValue === null ? -Infinity : Number(r.expectedValue);
        case 'nextAction': return r.nextActionAt ? new Date(r.nextActionAt).getTime() : Infinity;
        case 'lastActivity': return new Date(r.updatedAt).getTime();
      }
    };
    return [...filtered].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Stable tiebreak so equal keys keep a deterministic, name-first order.
      return contactLabel(a).localeCompare(contactLabel(b));
    });
  }, [filtered, sortKey, sortDir]);

  const onSort = (col: ColumnDef) => {
    if (col.key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col.key);
      setSortDir(col.initialDir);
    }
  };

  const chips: { value: StageFilter; label: string }[] = [
    { value: 'ALL', label: 'All' },
    ...STAGES.map((s) => ({ value: s as StageFilter, label: STAGE_LABEL[s] })),
  ];

  return (
    <Card className="overflow-hidden" padded={false}>
      {/* ── Toolbar: stage chips + search ── */}
      <div className="flex flex-col gap-3 border-b border-subtle p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-3.5">
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Filter by stage">
          {chips.map((chip) => (
            <StageChip
              key={chip.value}
              value={chip.value}
              label={chip.label}
              count={counts[chip.value]}
              active={filter === chip.value}
              onSelect={() => setFilter(chip.value)}
            />
          ))}
        </div>

        <div className="relative sm:w-72">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
            strokeWidth={2.25}
            aria-hidden
          />
          <label htmlFor={searchId} className="sr-only">Search relationships</label>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email, org…"
            className={cn(
              'h-9 w-full rounded-token border border-subtle bg-surface-overlay/60 pl-9 pr-8 text-sm text-primary',
              'placeholder:text-muted',
              'transition-colors duration-fast ease-token',
              'hover:border-[rgb(var(--co-edge))]',
              'focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30',
            )}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-muted transition-colors hover:text-primary"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>

      {/* ── Table (sticky header lives within this scroller) ── */}
      <div className="max-h-[calc(100vh-15rem)] overflow-auto">
        <Table>
          <THead>
            <tr>
              {COLUMNS.map((col) => (
                <TH
                  key={col.key}
                  align={col.align}
                  sortable={col.sortable}
                  sortDirection={sortKey === col.key ? sortDir : null}
                  onSort={() => onSort(col)}
                >
                  {col.label}
                </TH>
              ))}
              {/* Trailing "open profile" affordance column (chevron). */}
              <TH align="right"><span className="sr-only">Open profile</span></TH>
            </tr>
          </THead>

          <TBody>
            {loading
              ? <SkeletonRows />
              : sorted.length === 0
                ? <EmptyRow filtered={rows.length > 0} query={query} onNew={onNew} onClear={() => { setFilter('ALL'); setQuery(''); }} />
                : sorted.map((r) => <RelationshipRow key={r.id} row={r} />)}
          </TBody>
        </Table>
      </div>

      {/* ── Footer count ── */}
      {!loading && sorted.length > 0 && (
        <div className="flex items-center justify-between border-t border-subtle px-4 py-2.5 text-xs text-tertiary">
          <span>
            <span className="font-mono font-semibold tabular-nums text-secondary">{sorted.length}</span>
            {sorted.length === rows.length
              ? ` relationship${sorted.length === 1 ? '' : 's'}`
              : ` of ${rows.length} shown`}
          </span>
          {onNew && (
            <button
              type="button"
              onClick={onNew}
              className="inline-flex items-center gap-1 font-medium text-accent transition-colors hover:text-accent-hover"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> New relationship
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

/* ── Row ──────────────────────────────────────────────────────────────────── */

function RelationshipRow({ row }: { row: CustomerRow }) {
  const href = `/dashboard/customers/${row.id}`;
  const name = contactLabel(row);
  const sub = row.contact?.primaryEmail ?? row.contact?.currentOrgName ?? null;
  const meta = STAGE_META[row.stage];

  return (
    <TR className={cn('cursor-pointer', row.isLost && 'opacity-60')}>
      {/* Contact — the row's primary link + identity. A stretched overlay link
          makes the whole identity cell a generous click target (avatar + name +
          sub) without hijacking text selection in the data cells. */}
      <TD className="relative cursor-pointer">
        {/* Stretched link makes the whole row clickable while keeping it a real <a>. */}
        <Link href={href} className="absolute inset-0 z-0 focus-visible:outline-none" aria-label={`Open ${name}`} tabIndex={-1} />
        <div className="relative z-[1] flex items-center gap-3">
          <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-bold', meta.well, meta.text)}>
            {initials(name)}
          </span>
          <div className="min-w-0">
            <Link
              href={href}
              className="block truncate font-medium text-primary outline-none transition-colors hover:text-accent focus-visible:text-accent"
            >
              {name}
            </Link>
            {sub && <div className="truncate text-xs text-tertiary">{sub}</div>}
          </div>
        </div>
      </TD>

      {/* Stage */}
      <TD>
        {row.isLost
          ? <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-overlay px-2.5 py-0.5 text-xs font-semibold text-muted">Lost</span>
          : <StageBadge stage={row.stage} />}
      </TD>

      {/* Priority */}
      <TD>
        <PriorityCell priority={row.priority} />
      </TD>

      {/* Owner */}
      <TD>
        {row.ownerUserKey
          ? <span className="text-secondary">{row.ownerUserKey}</span>
          : <span className="text-muted">Unassigned</span>}
      </TD>

      {/* Expected value */}
      <TD align="right" mono>
        {row.expectedValue !== null
          ? <span className="text-primary">{money(row.expectedValue, row.currency ?? 'USD')}</span>
          : <span className="text-muted">—</span>}
      </TD>

      {/* Next action (overdue-aware) */}
      <TD>
        <NextActionCell iso={row.nextActionAt} lost={row.isLost} />
      </TD>

      {/* Last activity */}
      <TD>
        <span className="text-tertiary" title={absolute(row.updatedAt)}>{relative(row.updatedAt)}</span>
      </TD>

      {/* Open-profile cue — a trailing chevron that brightens + nudges right on
          row hover. Purely a visual affordance; the stretched whole-row link
          above does the navigation (no second click target). */}
      <TD align="right" className="w-10">
        <ChevronRight
          className="ml-auto h-4 w-4 text-muted opacity-50 transition-all duration-fast ease-token group-hover/row:translate-x-0.5 group-hover/row:text-accent group-hover/row:opacity-100"
          strokeWidth={2.5}
          aria-hidden
        />
      </TD>
    </TR>
  );
}

/* ── Cells ────────────────────────────────────────────────────────────────── */

function PriorityCell({ priority }: { priority: Priority }) {
  const m = PRIORITY_META[priority];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('h-1.5 w-1.5 rounded-full', m.dot)} aria-hidden />
      <span className={cn('text-xs font-medium', m.text)}>{m.label}</span>
    </span>
  );
}

function NextActionCell({ iso, lost }: { iso: string | null; lost: boolean }) {
  if (!iso) return <span className="text-muted">—</span>;
  const due = new Date(iso).getTime();
  const overdue = !lost && Number.isFinite(due) && due < Date.now();
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-xs', overdue ? 'font-semibold text-danger' : 'text-secondary')}
      title={absolute(iso)}
    >
      {overdue && <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />}
      {relative(iso)}
    </span>
  );
}

/* ── Stage filter chip ────────────────────────────────────────────────────── */

function StageChip({
  value, label, count, active, onSelect,
}: {
  value: StageFilter;
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  const hue = value === 'ALL' ? null : STAGE_META[value];
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold',
        'border transition-colors duration-fast ease-token',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        active
          ? 'border-transparent bg-surface-elevated text-primary shadow-token'
          : 'border-subtle bg-transparent text-tertiary hover:bg-surface-overlay/60 hover:text-secondary',
      )}
    >
      {hue && <span className={cn('h-1.5 w-1.5 rounded-full', active ? hue.dot : cn(hue.dot, 'opacity-70'))} aria-hidden />}
      {label}
      <span
        className={cn(
          'min-w-[1.25rem] rounded-full px-1.5 text-center font-mono text-[11px] tabular-nums',
          active ? 'bg-surface-overlay text-secondary' : 'bg-surface-overlay/70 text-tertiary',
        )}
      >
        {count}
      </span>
    </button>
  );
}

/* ── Empty / skeleton states ──────────────────────────────────────────────── */

/** Empty state. Distinguishes "no rows at all" (cold start → create CTA) from
 *  "filters hid everything" (→ clear-filters CTA). */
function EmptyRow({
  filtered, query, onNew, onClear,
}: {
  filtered: boolean;
  query: string;
  onNew?: () => void;
  onClear: () => void;
}) {
  const noMatches = filtered; // rows exist, but the active filter/search hid them
  return (
    <tr>
      <td colSpan={COLSPAN} className="px-4 py-16">
        <div className="mx-auto flex max-w-sm flex-col items-center text-center">
          <IconTile icon={noMatches ? (Search as LucideIcon) : Users} gradient="from-violet-500 to-fuchsia-500" size="lg" glow />
          <h3 className="mt-4 text-sm font-semibold text-primary">
            {noMatches ? 'No relationships match' : 'No relationships yet'}
          </h3>
          <p className="mt-1 text-sm text-tertiary">
            {noMatches
              ? query
                ? <>Nothing matches “<span className="text-secondary">{query}</span>”. Try a different search or stage.</>
                : 'No relationships in this stage. Switch filters to see the rest.'
              : 'Start the lifecycle by adding a contact from Contact-Ops as a lead.'}
          </p>
          <div className="mt-5">
            {noMatches
              ? <Button variant="secondary" size="sm" onClick={onClear}>Clear filters</Button>
              : onNew && <Button size="sm" glow leading={<Plus className="h-4 w-4" strokeWidth={2.5} />} onClick={onNew}>New relationship</Button>}
          </div>
        </div>
      </td>
    </tr>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} className="[&>td]:border-b [&>td]:border-subtle">
          {/* Contact */}
          <td className="px-4 py-2.5">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-surface-overlay" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-3 w-40 animate-pulse rounded bg-surface-overlay" />
                <div className="h-2.5 w-28 animate-pulse rounded bg-surface-overlay/70" />
              </div>
            </div>
          </td>
          {/* Stage */}
          <td className="px-3 py-2.5"><div className="h-5 w-20 animate-pulse rounded-full bg-surface-overlay" /></td>
          {/* Priority */}
          <td className="px-3 py-2.5"><div className="h-3 w-16 animate-pulse rounded bg-surface-overlay" /></td>
          {/* Owner */}
          <td className="px-3 py-2.5"><div className="h-3 w-24 animate-pulse rounded bg-surface-overlay" /></td>
          {/* Value */}
          <td className="px-3 py-2.5"><div className="ml-auto h-3 w-16 animate-pulse rounded bg-surface-overlay" /></td>
          {/* Next action */}
          <td className="px-3 py-2.5"><div className="h-3 w-20 animate-pulse rounded bg-surface-overlay" /></td>
          {/* Last activity */}
          <td className="px-3 py-2.5"><div className="h-3 w-16 animate-pulse rounded bg-surface-overlay" /></td>
          {/* Open-profile chevron */}
          <td className="px-4 py-2.5"><div className="ml-auto h-4 w-4 animate-pulse rounded bg-surface-overlay" /></td>
        </tr>
      ))}
    </>
  );
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function initials(name: string): string {
  const parts = name.replace(/[…]/g, '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '··';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Compact relative time, both past ("3d ago") and future ("in 5d"). */
function relative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = t - Date.now();
  const past = diff < 0;
  const s = Math.abs(diff) / 1000;
  const fmt = (n: number, unit: string) => (past ? `${n}${unit} ago` : `in ${n}${unit}`);
  if (s < 45) return past ? 'just now' : 'soon';
  if (s < 3600) return fmt(Math.round(s / 60), 'm');
  if (s < 86400) return fmt(Math.round(s / 3600), 'h');
  const d = Math.round(s / 86400);
  if (d === 1) return past ? 'yesterday' : 'tomorrow';
  if (d < 30) return fmt(d, 'd');
  if (d < 365) return fmt(Math.round(d / 30), 'mo');
  return fmt(Math.round(d / 365), 'y');
}

function absolute(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

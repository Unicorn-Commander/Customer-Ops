'use client';

import { forwardRef, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Inbox, Sparkles, Plug, PlugZap, RefreshCw, Plus, X, Search, AlertTriangle,
  CheckCircle2, Clock, XCircle, Trash2, ArrowUpRight, MoreHorizontal, Zap,
  Wand2, ShieldCheck, type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Stat } from '@/components/ui/Stat';
import { IconTile } from '@/components/ui/IconTile';
import { cn } from '@/components/ui/cn';
import {
  Table, THead, TBody, TR, TH, TD,
} from '@/components/ui/Table';
import {
  type LeadIntake, type IntakeStats, type IntakeStatus, type IngestLeadInput,
  type ResolvePendingResult, type IngestResult, type Priority,
  INTAKE_STATUSES, INTAKE_STATUS_LABEL,
  sourceMeta, tallyBySource, slugifyDedupKey, relativeTime, absoluteTime,
} from '@/lib/leads';
import { useOverlay } from '@/lib/useOverlay';

/* ── Presentational lead-ingestion cockpit ────────────────────────────────────
 * The observability + control surface for the Phase-6 `ingest_lead` pipeline.
 * Pure VIEW: the parent owns data (stats + intakes) and the three actions
 * (resolvePending / ingestLead / discardIntake). The live page wires them to
 * lib/leads.ts + refetch; the preview page passes sample data + local no-ops.
 *
 * No animated header (Aaron dislikes it) — a static gradient IconTile + a live
 * Contact-Ops connection chip. The rest reads as color: KPI gradients, a
 * per-source breakdown strip, a prominent resolve-pending queue, and a filtered
 * intakes table with provisional pills + row actions.
 * ─────────────────────────────────────────────────────────────────────────── */

export interface LeadIngestionProps {
  stats: IntakeStats;
  intakes: LeadIntake[];
  /** Whether Contact-Ops resolution is currently reachable (header chip). */
  coReachable: boolean;
  /** Streams skeleton chrome while the first load resolves. */
  loading?: boolean;
  /** Sweep the open queue (re-attempt identity resolution). */
  onResolvePending?: () => Promise<ResolvePendingResult>;
  /** Manually ingest a lead (the slide-over form). */
  onIngest?: (body: IngestLeadInput) => Promise<IngestResult>;
  /** Discard an open intake. */
  onDiscard?: (id: string) => Promise<void> | void;
  /** Pull fresh data (the header Refresh button). */
  onRefresh?: () => void;
  refreshing?: boolean;
}

type StatusFilter = IntakeStatus | 'ALL';

/* Per-status visual language — colored badge + KPI gradient. Full strings. */
const STATUS_META: Record<IntakeStatus, {
  label: string;
  icon: LucideIcon;
  badge: string;   // pill text + well
  dot: string;
  gradient: string; // KPI / icon gradient
  text: string;
}> = {
  PENDING: {
    label: 'Pending', icon: Clock,
    badge: 'bg-warning/12 text-warning', dot: 'bg-warning',
    gradient: 'from-amber-400 to-orange-500', text: 'text-warning',
  },
  RESOLVED: {
    label: 'Resolved', icon: CheckCircle2,
    badge: 'bg-success/12 text-success', dot: 'bg-success',
    gradient: 'from-emerald-400 to-teal-500', text: 'text-success',
  },
  FAILED: {
    label: 'Failed', icon: XCircle,
    badge: 'bg-danger/12 text-danger', dot: 'bg-danger',
    gradient: 'from-rose-500 to-red-500', text: 'text-danger',
  },
  DISCARDED: {
    label: 'Discarded', icon: Trash2,
    badge: 'bg-surface-overlay text-muted', dot: 'bg-muted',
    gradient: 'from-slate-500 to-slate-600', text: 'text-muted',
  },
};

const PRIORITY_META: Record<Priority, { label: string; dot: string; text: string }> = {
  HIGH: { label: 'High', dot: 'bg-danger', text: 'text-danger' },
  MEDIUM: { label: 'Medium', dot: 'bg-warning', text: 'text-warning' },
  LOW: { label: 'Low', dot: 'bg-muted', text: 'text-tertiary' },
};

export function LeadIngestion({
  stats, intakes, coReachable, loading = false,
  onResolvePending, onIngest, onDiscard, onRefresh, refreshing = false,
}: LeadIngestionProps) {
  const [filter, setFilter] = useState<StatusFilter>('ALL');
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  // Resolve-pending outcome (inline result banner under the queue panel).
  const [resolving, setResolving] = useState(false);
  const [resolveResult, setResolveResult] = useState<ResolvePendingResult | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // A small toast for ingest/discard outcomes.
  const [toast, setToast] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (kind: 'ok' | 'warn' | 'err', text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  };
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      ALL: intakes.length, PENDING: 0, RESOLVED: 0, FAILED: 0, DISCARDED: 0,
    };
    for (const it of intakes) c[it.status] += 1;
    return c;
  }, [intakes]);

  const sources = useMemo(() => tallyBySource(intakes), [intakes]);
  const pendingCount = stats.byStatus.PENDING ?? 0;
  const failedCount = stats.byStatus.FAILED ?? 0;

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    let out = filter === 'ALL' ? intakes : intakes.filter((it) => it.status === filter);
    if (q) {
      out = out.filter((it) => {
        const hay = [it.displayName, it.email, it.orgName, it.source, it.sourceDedupKey, ...(it.tags ?? [])];
        return hay.some((v) => v && v.toLowerCase().includes(q));
      });
    }
    // Newest first — the firehose reads top-down.
    return [...out].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [intakes, filter, q]);

  const runResolve = async () => {
    if (!onResolvePending) return;
    setResolving(true);
    setResolveError(null);
    setResolveResult(null);
    try {
      const res = await onResolvePending();
      setResolveResult(res);
      if (res.resolved > 0 || res.provisionalUpgraded > 0) {
        showToast('ok', `Resolved ${res.resolved} · upgraded ${res.provisionalUpgraded} provisional`);
      } else if (res.scanned === 0) {
        showToast('ok', 'Queue is clear — nothing pending to resolve.');
      } else {
        showToast('warn', `Scanned ${res.scanned}; ${res.stillOpen} still awaiting identity.`);
      }
    } catch (e) {
      setResolveError(messageOf(e, 'Resolve sweep failed.'));
      showToast('err', messageOf(e, 'Resolve sweep failed.'));
    } finally {
      setResolving(false);
    }
  };

  const runDiscard = async (id: string) => {
    if (!onDiscard) return;
    try {
      await onDiscard(id);
      showToast('ok', 'Intake discarded.');
    } catch (e) {
      showToast('err', messageOf(e, 'Could not discard.'));
    }
  };

  const submitIngest = async (body: IngestLeadInput): Promise<IngestResult | null> => {
    if (!onIngest) return null;
    const res = await onIngest(body);
    const where = res.via === 'explicit' ? 'explicit contact'
      : res.via === 'contact-ops' ? 'Contact-Ops match'
        : res.via === 'provisional' ? 'a provisional record'
          : null;
    if (res.resolved && where) {
      showToast('ok', `Lead ingested — resolved via ${where}.`);
    } else if (res.provisional) {
      showToast('warn', 'Lead staged provisionally — Contact-Ops is dormant.');
    } else {
      showToast('ok', 'Lead ingested — pending identity resolution.');
    }
    return res;
  };

  return (
    <div className="mx-auto max-w-[1280px] animate-fade-up space-y-5">
      <Header
        coReachable={coReachable}
        onRefresh={onRefresh}
        refreshing={refreshing}
        onAdd={() => setAddOpen(true)}
      />

      {/* ── KPI row ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Total ingested"
          value={loading ? '—' : fmt(stats.total)}
          icon={Inbox}
          gradient="from-lime-400 to-emerald-500"
          sub="all sources, all time"
          glow
        />
        <Stat
          label="Pending"
          value={loading ? '—' : fmt(pendingCount)}
          icon={Clock}
          gradient="from-amber-400 to-orange-500"
          sub={pendingCount > 0 ? 'awaiting identity' : 'queue clear'}
        />
        <Stat
          label="Resolved"
          value={loading ? '—' : fmt(stats.byStatus.RESOLVED ?? 0)}
          icon={CheckCircle2}
          gradient="from-emerald-400 to-teal-500"
          sub="matched to a contact"
        />
        <Stat
          label="Failed"
          value={loading ? '—' : fmt(failedCount)}
          icon={XCircle}
          gradient="from-rose-500 to-red-500"
          sub={failedCount > 0 ? 'needs a retry' : 'none failing'}
        />
      </div>

      {/* ── Source breakdown strip ── */}
      <SourceBreakdown sources={sources} total={intakes.length} loading={loading} />

      {/* ── Pending queue panel ── */}
      <PendingQueue
        pendingCount={pendingCount}
        failedCount={failedCount}
        coReachable={coReachable}
        resolving={resolving}
        result={resolveResult}
        error={resolveError}
        onResolve={onResolvePending ? runResolve : undefined}
      />

      {/* ── Intakes table ── */}
      <IntakesTable
        rows={filtered}
        total={intakes.length}
        loading={loading}
        filter={filter}
        counts={counts}
        query={query}
        onFilter={setFilter}
        onQuery={setQuery}
        onDiscard={onDiscard ? runDiscard : undefined}
        onAdd={() => setAddOpen(true)}
      />

      {/* ── Add-lead slide-over ── */}
      <AddLeadDrawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={onIngest ? submitIngest : undefined}
      />

      {/* ── Toast ── */}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

/* ── Header (no animation) ───────────────────────────────────────────────────── */

function Header({
  coReachable, onRefresh, refreshing, onAdd,
}: {
  coReachable: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  onAdd: () => void;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <IconTile icon={Inbox} gradient="from-lime-400 to-emerald-500" size="lg" glow />
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-primary">Lead Ingestion</h1>
            <ConnectionChip reachable={coReachable} />
          </div>
          <p className="mt-1 max-w-2xl text-sm text-tertiary">
            The intake firehose for the lead pipeline — Northwind, Outreach, LoopNet, multistate and
            agents push graduated leads in. Resolve them to Contact-Ops identities, then promote to
            the funnel.
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {onRefresh && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            leading={<RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} strokeWidth={2.4} />}
          >
            Refresh
          </Button>
        )}
        <Button
          glow
          leading={<Plus className="h-4 w-4" strokeWidth={2.5} />}
          onClick={onAdd}
        >
          Add lead
        </Button>
      </div>
    </header>
  );
}

/** The live Contact-Ops connection chip — emerald when reachable, amber when
 *  dormant (leads stage provisionally). */
function ConnectionChip({ reachable }: { reachable: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        reachable
          ? 'bg-success/12 text-success'
          : 'bg-warning/12 text-warning',
      )}
      title={reachable
        ? 'Contact-Ops is reachable — leads resolve to real identities on ingest.'
        : 'Contact-Ops is dormant — leads are staged provisionally and upgraded on the next resolve sweep.'}
    >
      {reachable
        ? <PlugZap className="h-3.5 w-3.5" strokeWidth={2.5} />
        : <Plug className="h-3.5 w-3.5" strokeWidth={2.5} />}
      {reachable ? 'Contact-Ops connected' : 'Contact-Ops dormant · leads staged provisionally'}
    </span>
  );
}

/* ── Source breakdown strip ──────────────────────────────────────────────────── */

function SourceBreakdown({
  sources, total, loading,
}: {
  sources: ReturnType<typeof tallyBySource>;
  total: number;
  loading: boolean;
}) {
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-tertiary">By source</span>
          <span className="text-[11px] text-muted">where leads enter the pipeline</span>
        </div>
        <span className="font-mono text-xs tabular-nums text-tertiary">{fmt(total)} total</span>
      </div>
      <div className="grid grid-cols-2 gap-2.5 p-3 sm:grid-cols-3 lg:grid-cols-6">
        {sources.map((s) => {
          const share = total > 0 ? Math.round((s.count / total) * 100) : 0;
          return (
            <div
              key={s.source}
              className={cn(
                'co-lift group relative overflow-hidden rounded-token-lg border border-subtle bg-surface-raised p-3',
                s.count === 0 && 'opacity-55',
              )}
              title={`${s.meta.label}: ${s.count} lead${s.count === 1 ? '' : 's'}${total > 0 ? ` (${share}%)` : ''}`}
            >
              {/* Soft per-source bloom */}
              <div
                aria-hidden
                className={cn(
                  'pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full bg-gradient-to-br opacity-20 blur-2xl transition-opacity duration-token group-hover:opacity-40',
                  s.meta.gradient,
                )}
              />
              <div className="relative flex items-center gap-2.5">
                <span
                  className={cn(
                    'grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-gradient-to-br text-white',
                    'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.28),0_3px_8px_-2px_rgba(0,0,0,0.45)]',
                    s.meta.gradient,
                  )}
                >
                  <span className="font-mono text-sm font-bold tabular-nums">{loading ? '·' : s.count}</span>
                </span>
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-primary">{s.meta.label}</div>
                  <div className="text-[11px] text-tertiary">{total > 0 ? `${share}% of intake` : 'no leads yet'}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ── Pending queue panel ─────────────────────────────────────────────────────── */

function PendingQueue({
  pendingCount, failedCount, coReachable, resolving, result, error, onResolve,
}: {
  pendingCount: number;
  failedCount: number;
  coReachable: boolean;
  resolving: boolean;
  result: ResolvePendingResult | null;
  error: string | null;
  onResolve?: () => void;
}) {
  const hasWork = pendingCount > 0 || failedCount > 0;
  return (
    <Card glass className="overflow-hidden">
      <div className="relative p-5">
        <div aria-hidden className="co-glow absolute -left-10 -top-12 h-36 w-56 opacity-50" />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <IconTile icon={Wand2} gradient="from-violet-500 to-cyan-500" size="lg" glow />
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-primary">Identity resolution queue</h2>
              <p className="mt-0.5 max-w-xl text-sm text-tertiary">
                {hasWork ? (
                  <>
                    <span className="font-semibold text-warning">{fmt(pendingCount)}</span> pending
                    {failedCount > 0 && <> · <span className="font-semibold text-danger">{fmt(failedCount)}</span> failed</>}
                    {' '}awaiting a Contact-Ops match. Run a sweep to resolve them and upgrade any provisional records.
                  </>
                ) : (
                  <>The queue is clear — every ingested lead has been resolved to an identity.</>
                )}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {!coReachable && (
              <span className="hidden items-center gap-1.5 text-[11px] font-medium text-warning sm:inline-flex" title="Contact-Ops is dormant; a sweep can still upgrade provisional records when it returns.">
                <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2.4} /> CO dormant
              </span>
            )}
            <Button
              size="lg"
              glow
              disabled={!onResolve || resolving || !hasWork}
              onClick={onResolve}
              leading={resolving
                ? <RefreshCw className="h-4 w-4 animate-spin" strokeWidth={2.4} />
                : <Zap className="h-4 w-4" strokeWidth={2.5} />}
            >
              {resolving ? 'Resolving…' : 'Resolve pending'}
            </Button>
          </div>
        </div>

        {/* Inline result of the last sweep */}
        {result && (
          <div className="relative mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <SweepStat label="Scanned" value={result.scanned} tone="muted" icon={Search} />
            <SweepStat label="Resolved" value={result.resolved} tone="ok" icon={CheckCircle2} />
            <SweepStat label="Upgraded" value={result.provisionalUpgraded} tone="accent" icon={ShieldCheck} />
            <SweepStat label="Still open" value={result.stillOpen} tone={result.stillOpen > 0 ? 'warn' : 'muted'} icon={Clock} />
          </div>
        )}
        {error && (
          <div role="alert" className="relative mt-4 flex items-start gap-2.5 rounded-token-lg border border-danger/30 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.4} />
            <span>{error}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

function SweepStat({
  label, value, tone, icon: Icon,
}: {
  label: string;
  value: number;
  tone: 'ok' | 'warn' | 'accent' | 'muted';
  icon: LucideIcon;
}) {
  const toneCls = tone === 'ok' ? 'text-success' : tone === 'warn' ? 'text-warning' : tone === 'accent' ? 'text-accent' : 'text-tertiary';
  return (
    <div className="rounded-token-lg border border-subtle bg-surface-raised/70 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-tertiary">
        <Icon className={cn('h-3.5 w-3.5', toneCls)} strokeWidth={2.4} />
        {label}
      </div>
      <div className={cn('mt-1 font-mono text-xl font-semibold tabular-nums', toneCls)}>{fmt(value)}</div>
    </div>
  );
}

/* ── Intakes table ───────────────────────────────────────────────────────────── */

function IntakesTable({
  rows, total, loading, filter, counts, query, onFilter, onQuery, onDiscard, onAdd,
}: {
  rows: LeadIntake[];
  total: number;
  loading: boolean;
  filter: StatusFilter;
  counts: Record<StatusFilter, number>;
  query: string;
  onFilter: (f: StatusFilter) => void;
  onQuery: (q: string) => void;
  onDiscard?: (id: string) => void;
  onAdd: () => void;
}) {
  const searchId = useId();
  const chips: { value: StatusFilter; label: string }[] = [
    { value: 'ALL', label: 'All' },
    ...INTAKE_STATUSES.map((s) => ({ value: s as StatusFilter, label: INTAKE_STATUS_LABEL[s] })),
  ];

  return (
    <Card className="overflow-hidden" padded={false}>
      {/* Toolbar: status filter tabs + search */}
      <div className="flex flex-col gap-3 border-b border-subtle p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-3.5">
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Filter by status">
          {chips.map((chip) => (
            <StatusChip
              key={chip.value}
              value={chip.value}
              label={chip.label}
              count={counts[chip.value]}
              active={filter === chip.value}
              onSelect={() => onFilter(chip.value)}
            />
          ))}
        </div>

        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" strokeWidth={2.25} aria-hidden />
          <label htmlFor={searchId} className="sr-only">Search intakes</label>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search name, email, org, tag…"
            className={cn(
              'h-9 w-full rounded-token border border-subtle bg-surface-overlay/60 pl-9 pr-8 text-sm text-primary',
              'placeholder:text-muted transition-colors duration-fast ease-token',
              'hover:border-[rgb(var(--co-edge))]',
              'focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30',
            )}
          />
          {query && (
            <button
              type="button"
              onClick={() => onQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-muted transition-colors hover:text-primary"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="max-h-[calc(100vh-13rem)] overflow-auto">
        <Table>
          <THead>
            <tr>
              <TH>Status</TH>
              <TH>Lead</TH>
              <TH>Source</TH>
              <TH align="right">Score</TH>
              <TH>Created</TH>
              <TH align="right"><span className="sr-only">Actions</span></TH>
            </tr>
          </THead>
          <TBody>
            {loading
              ? <SkeletonRows />
              : rows.length === 0
                ? <EmptyRow filtered={total > 0} query={query} onAdd={onAdd} onClear={() => { onFilter('ALL'); onQuery(''); }} />
                : rows.map((it) => <IntakeRow key={it.id} intake={it} onDiscard={onDiscard} />)}
          </TBody>
        </Table>
      </div>

      {/* Footer count */}
      {!loading && rows.length > 0 && (
        <div className="flex items-center justify-between border-t border-subtle px-4 py-2.5 text-xs text-tertiary">
          <span>
            <span className="font-mono font-semibold tabular-nums text-secondary">{rows.length}</span>
            {rows.length === total ? ` intake${rows.length === 1 ? '' : 's'}` : ` of ${total} shown`}
          </span>
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex items-center gap-1 font-medium text-accent transition-colors hover:text-accent-hover"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Add lead
          </button>
        </div>
      )}
    </Card>
  );
}

function IntakeRow({ intake, onDiscard }: { intake: LeadIntake; onDiscard?: (id: string) => void }) {
  const sm = sourceMeta(intake.source);
  const meta = STATUS_META[intake.status];
  const name = intake.displayName?.trim() || null;
  const sub = intake.email ?? intake.orgName ?? null;
  const canDiscard = intake.status !== 'RESOLVED' && intake.status !== 'DISCARDED';
  const canView = !!intake.customerId;

  return (
    <TR>
      {/* Status (+ provisional pill) */}
      <TD>
        <div className="flex items-center gap-1.5">
          <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold', meta.badge)}>
            <meta.icon className="h-3.5 w-3.5" strokeWidth={2.4} />
            {meta.label}
          </span>
          {intake.provisional && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent"
              title="Resolved against a provisional placeholder while Contact-Ops was dormant — will upgrade to a real identity on the next sweep."
            >
              <Sparkles className="h-3 w-3" strokeWidth={2.5} /> provisional
            </span>
          )}
        </div>
      </TD>

      {/* Lead */}
      <TD>
        <div className="flex items-center gap-3">
          <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br text-[11px] font-bold text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)]', sm.gradient)}>
            {initials(name ?? intake.email ?? '?')}
          </span>
          <div className="min-w-0">
            <div className={cn('truncate font-medium', name ? 'text-primary' : 'italic text-muted')}>
              {name ?? '(unnamed)'}
            </div>
            {sub && <div className="truncate text-xs text-tertiary">{sub}</div>}
            {!sub && intake.orgName && <div className="truncate text-xs text-tertiary">{intake.orgName}</div>}
          </div>
        </div>
      </TD>

      {/* Source */}
      <TD>
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium', sm.well, sm.text)}>
          <span className={cn('h-1.5 w-1.5 rounded-full bg-gradient-to-br', sm.gradient)} aria-hidden />
          {sm.label}
        </span>
      </TD>

      {/* Score */}
      <TD align="right" mono>
        {intake.score !== null
          ? <ScoreChip score={intake.score} />
          : <span className="text-muted">—</span>}
      </TD>

      {/* Created */}
      <TD>
        <span className="text-tertiary" title={absoluteTime(intake.createdAt)}>{relativeTime(intake.createdAt)}</span>
      </TD>

      {/* Row actions */}
      <TD align="right">
        <RowActions
          view={canView ? `/dashboard/customers/${intake.customerId}` : null}
          onDiscard={canDiscard && onDiscard ? () => onDiscard(intake.id) : null}
        />
      </TD>
    </TR>
  );
}

/** A small score chip, hue-graded by band (warm = hot lead). */
function ScoreChip({ score }: { score: number }) {
  const band = score >= 80 ? 'text-emerald-300 bg-emerald-500/12'
    : score >= 55 ? 'text-amber-300 bg-amber-500/12'
      : score >= 30 ? 'text-sky-300 bg-sky-500/12'
        : 'text-tertiary bg-surface-overlay';
  return (
    <span className={cn('inline-flex min-w-[2.25rem] items-center justify-center rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums', band)}>
      {Math.round(score)}
    </span>
  );
}

/** Row action menu — a popover with View (when a customer exists) + Discard
 *  (for non-resolved rows). Closes on outside click / Escape. */
function RowActions({ view, onDiscard }: { view: string | null; onDiscard: (() => void) | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!view && !onDiscard) {
    return <span className="text-xs text-muted">—</span>;
  }

  return (
    <div ref={ref} className="relative inline-flex justify-end">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Row actions"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'grid h-8 w-8 place-items-center rounded-md text-muted transition-colors',
          'hover:bg-surface-overlay hover:text-primary',
          open && 'bg-surface-overlay text-primary',
        )}
      >
        <MoreHorizontal className="h-4 w-4" strokeWidth={2.4} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-30 w-44 overflow-hidden rounded-token-lg border border-[rgb(var(--co-edge))] bg-surface-elevated p-1 shadow-token-lg"
        >
          {view && (
            <Link
              href={view}
              role="menuitem"
              className="flex items-center gap-2 rounded-md px-2.5 py-2 text-xs font-medium text-secondary transition-colors hover:bg-surface-overlay hover:text-primary"
              onClick={() => setOpen(false)}
            >
              <ArrowUpRight className="h-3.5 w-3.5 text-accent" strokeWidth={2.4} />
              View customer
            </Link>
          )}
          {onDiscard && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onDiscard(); }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs font-medium text-danger transition-colors hover:bg-danger-subtle"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={2.4} />
              Discard intake
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Status filter chip ──────────────────────────────────────────────────────── */

function StatusChip({
  value, label, count, active, onSelect,
}: {
  value: StatusFilter;
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  const dot = value === 'ALL' ? null : STATUS_META[value].dot;
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
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', active ? dot : cn(dot, 'opacity-70'))} aria-hidden />}
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

/* ── Empty / skeleton ────────────────────────────────────────────────────────── */

function EmptyRow({
  filtered, query, onAdd, onClear,
}: {
  filtered: boolean;
  query: string;
  onAdd: () => void;
  onClear: () => void;
}) {
  return (
    <tr>
      <td colSpan={6} className="px-4 py-16">
        <div className="mx-auto flex max-w-sm flex-col items-center text-center">
          <IconTile icon={filtered ? Search : Inbox} gradient="from-lime-400 to-emerald-500" size="lg" glow />
          <h3 className="mt-4 text-sm font-semibold text-primary">
            {filtered ? 'No intakes match' : 'No leads ingested yet'}
          </h3>
          <p className="mt-1 text-sm text-tertiary">
            {filtered
              ? query
                ? <>Nothing matches “<span className="text-secondary">{query}</span>”. Try a different search or status.</>
                : 'No intakes in this status. Switch filters to see the rest.'
              : 'Leadgen apps and agents push leads here. Add one manually to see the pipeline in motion.'}
          </p>
          <div className="mt-5">
            {filtered
              ? <Button variant="secondary" size="sm" onClick={onClear}>Clear filters</Button>
              : <Button size="sm" glow leading={<Plus className="h-4 w-4" strokeWidth={2.5} />} onClick={onAdd}>Add lead</Button>}
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
          <td className="px-4 py-2.5"><div className="h-5 w-20 animate-pulse rounded-full bg-surface-overlay" /></td>
          <td className="px-3 py-2.5">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-surface-overlay" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-3 w-40 animate-pulse rounded bg-surface-overlay" />
                <div className="h-2.5 w-28 animate-pulse rounded bg-surface-overlay/70" />
              </div>
            </div>
          </td>
          <td className="px-3 py-2.5"><div className="h-5 w-24 animate-pulse rounded-full bg-surface-overlay" /></td>
          <td className="px-3 py-2.5"><div className="ml-auto h-5 w-9 animate-pulse rounded bg-surface-overlay" /></td>
          <td className="px-3 py-2.5"><div className="h-3 w-16 animate-pulse rounded bg-surface-overlay" /></td>
          <td className="px-4 py-2.5"><div className="ml-auto h-8 w-8 animate-pulse rounded-md bg-surface-overlay" /></td>
        </tr>
      ))}
    </>
  );
}

/* ── Add-lead slide-over ─────────────────────────────────────────────────────── */

const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH'];

function AddLeadDrawer({
  open, onClose, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit?: (body: IngestLeadInput) => Promise<IngestResult | null>;
}) {
  const [source, setSource] = useState('manual');
  const [dedupKey, setDedupKey] = useState('');
  const [dedupTouched, setDedupTouched] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [orgName, setOrgName] = useState('');
  const [tags, setTags] = useState('');
  const [expectedValue, setExpectedValue] = useState('');
  const [priority, setPriority] = useState<Priority>('MEDIUM');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<IngestResult | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Shared overlay mechanics: focus into the first field on open, Tab focus-trap,
  // body-scroll lock, Esc-to-close (gated while a submit is in flight), and focus
  // restored to the opener on close.
  const { panelRef, onKeyDown } = useOverlay({
    onClose: () => { if (!busy) onClose(); },
    closeOnEsc: !busy,
    initialFocusRef: firstFieldRef,
    enabled: open,
  });

  // Auto-suggest the dedup key from email until the operator edits it.
  useEffect(() => {
    if (!dedupTouched) setDedupKey(email.trim() ? slugifyDedupKey(email) : '');
  }, [email, dedupTouched]);

  // Clear any prior outcome/error each time the drawer opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setOutcome(null);
  }, [open]);

  const reset = () => {
    setSource('manual'); setDedupKey(''); setDedupTouched(false);
    setDisplayName(''); setEmail(''); setPhone(''); setOrgName('');
    setTags(''); setExpectedValue(''); setPriority('MEDIUM');
    setError(null); setOutcome(null);
  };

  const canSubmit = source.trim().length > 0 && dedupKey.trim().length > 0 && !busy;

  const submit = async () => {
    if (!onSubmit || !canSubmit) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    const body: IngestLeadInput = {
      source: source.trim(),
      sourceDedupKey: dedupKey.trim(),
      ...(displayName.trim() && { displayName: displayName.trim() }),
      ...(email.trim() && { email: email.trim() }),
      ...(phone.trim() && { phone: phone.trim() }),
      ...(orgName.trim() && { orgName: orgName.trim() }),
      ...(tagList.length > 0 && { tags: tagList }),
      ...(expectedValue.trim() && { expectedValue: expectedValue.trim() }),
      priority,
    };
    try {
      const res = await onSubmit(body);
      if (res) {
        // Surface the resolution outcome, then close shortly after.
        setOutcome(res);
        setTimeout(() => { onClose(); reset(); }, 1400);
      } else {
        onClose();
        reset();
      }
    } catch (e) {
      setError(messageOf(e, 'Could not ingest the lead.'));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="presentation" onKeyDown={onKeyDown}>
      {/* Scrim */}
      <button
        type="button"
        aria-label="Close"
        onClick={() => !busy && onClose()}
        className="absolute inset-0 bg-black/55 backdrop-blur-sm animate-fade-up"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add a lead"
        className="relative flex h-full w-full max-w-md flex-col border-l border-[rgb(var(--co-edge))] bg-surface-base shadow-token-lg animate-fade-up"
      >
        {/* Header */}
        <div className="relative flex items-center justify-between gap-3 border-b border-subtle px-5 py-4">
          <div aria-hidden className="co-glow absolute -left-8 -top-10 h-28 w-44 opacity-40" />
          <div className="relative flex items-center gap-3">
            <IconTile icon={Plus} gradient="from-lime-400 to-emerald-500" size="md" />
            <div>
              <h2 className="text-sm font-semibold text-primary">Add a lead</h2>
              <p className="text-xs text-tertiary">Manual ingest into the pipeline</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-primary"
          >
            <X className="h-4 w-4" strokeWidth={2.5} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Source" required>
              <TextInput value={source} onChange={setSource} placeholder="manual" ref={firstFieldRef} />
            </Field>
            <Field label="Priority">
              <div className="relative">
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as Priority)}
                  className={cn(
                    'h-10 w-full appearance-none rounded-token border border-subtle bg-surface-overlay/60 px-3 pr-8 text-sm text-primary',
                    'transition-colors duration-fast ease-token',
                    'focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30',
                  )}
                >
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p[0] + p.slice(1).toLowerCase()}</option>)}
                </select>
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                  <span className={cn('h-1.5 w-1.5 rounded-full', PRIORITY_META[priority].dot)} />
                </span>
              </div>
            </Field>
          </div>

          <Field label="Email">
            <TextInput value={email} onChange={setEmail} type="email" placeholder="lead@example.com" />
          </Field>

          <Field
            label="Dedup key"
            required
            hint="Idempotency seam — a re-push of the same source + key updates rather than duplicates."
          >
            <TextInput
              value={dedupKey}
              onChange={(v) => { setDedupTouched(true); setDedupKey(v); }}
              placeholder="auto-suggested from email"
            />
          </Field>

          <Field label="Display name">
            <TextInput value={displayName} onChange={setDisplayName} placeholder="Jane Rivera" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone">
              <TextInput value={phone} onChange={setPhone} type="tel" placeholder="+1 555 010 0143" />
            </Field>
            <Field label="Expected value">
              <TextInput value={expectedValue} onChange={setExpectedValue} placeholder="14000" mono />
            </Field>
          </div>

          <Field label="Organization">
            <TextInput value={orgName} onChange={setOrgName} placeholder="Acme Holdings" />
          </Field>

          <Field label="Tags" hint="Comma-separated.">
            <TextInput value={tags} onChange={setTags} placeholder="401(k), referral, charleston" />
          </Field>

          {/* Outcome / error */}
          {outcome && <OutcomeBanner result={outcome} />}
          {error && (
            <div role="alert" className="flex items-start gap-2.5 rounded-token-lg border border-danger/30 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.4} />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-subtle px-5 py-4">
          <p className="text-[11px] text-muted">
            Resolves to a Contact-Ops identity, or stages provisionally if dormant.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => !busy && onClose()} disabled={busy}>Cancel</Button>
            <Button
              size="sm"
              glow
              onClick={submit}
              disabled={!canSubmit || !onSubmit}
              leading={busy ? <RefreshCw className="h-4 w-4 animate-spin" strokeWidth={2.4} /> : <Zap className="h-4 w-4" strokeWidth={2.5} />}
            >
              {busy ? 'Ingesting…' : 'Ingest lead'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The resolution outcome banner shown after a successful ingest. */
function OutcomeBanner({ result }: { result: IngestResult }) {
  const via = result.via;
  const tone = result.resolved && !result.provisional ? 'ok' : result.provisional ? 'accent' : 'warn';
  const label = via === 'explicit' ? 'Resolved via explicit contact'
    : via === 'contact-ops' ? 'Resolved via Contact-Ops match'
      : via === 'provisional' ? 'Staged provisionally'
        : 'Pending identity resolution';
  const cls = tone === 'ok' ? 'border-success/30 bg-success-subtle text-success'
    : tone === 'accent' ? 'border-accent/30 bg-accent/10 text-accent'
      : 'border-warning/30 bg-warning-subtle text-warning';
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'accent' ? Sparkles : Clock;
  return (
    <div className={cn('flex items-start gap-2.5 rounded-token-lg border px-3.5 py-2.5 text-sm', cls)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.4} />
      <div className="min-w-0">
        <div className="font-semibold">{label}</div>
        {result.detail && <div className="mt-0.5 text-xs opacity-90">{result.detail}</div>}
      </div>
    </div>
  );
}

/* ── Form primitives ─────────────────────────────────────────────────────────── */

function Field({
  label, required, hint, children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-secondary">
        {label}
        {required && <span className="text-danger" aria-hidden>*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-muted">{hint}</span>}
    </label>
  );
}

interface TextInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
}

const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { value, onChange, placeholder, type = 'text', mono }, ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        'h-10 w-full rounded-token border border-subtle bg-surface-overlay/60 px-3 text-sm text-primary',
        'placeholder:text-muted transition-colors duration-fast ease-token',
        'hover:border-[rgb(var(--co-edge))]',
        'focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30',
        mono && 'font-mono tabular-nums',
      )}
    />
  );
});

/* ── Toast ───────────────────────────────────────────────────────────────────── */

function Toast({ toast, onClose }: { toast: { kind: 'ok' | 'warn' | 'err'; text: string } | null; onClose: () => void }) {
  if (!toast) return null;
  const cls = toast.kind === 'ok' ? 'border-success/40 bg-surface-elevated text-success'
    : toast.kind === 'warn' ? 'border-warning/40 bg-surface-elevated text-warning'
      : 'border-danger/40 bg-surface-elevated text-danger';
  const Icon = toast.kind === 'ok' ? CheckCircle2 : toast.kind === 'warn' ? AlertTriangle : XCircle;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex justify-center px-4">
      <div
        role="status"
        className={cn('pointer-events-auto flex items-center gap-2.5 rounded-token-lg border px-4 py-2.5 text-sm font-medium shadow-token-lg animate-fade-up', cls)}
      >
        <Icon className="h-4 w-4 shrink-0" strokeWidth={2.4} />
        <span className="text-secondary">{toast.text}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="ml-1 grid h-5 w-5 place-items-center rounded text-muted transition-colors hover:text-primary"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────────────── */

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function initials(name: string): string {
  const clean = name.replace(/[@.].*$/, ''); // emails → local part
  const parts = clean.replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '··';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function messageOf(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : '';
  return m && m.trim() ? m : fallback;
}

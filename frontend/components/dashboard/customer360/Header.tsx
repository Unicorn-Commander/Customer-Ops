'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Mail, Phone, Building2, ArrowRight, Flag, RotateCcw, Check, CircleSlash,
  CalendarClock, Banknote, UserRound, type LucideIcon,
} from 'lucide-react';
import { Button, StageBadge, Badge, cn } from '@/components/ui';
import { STAGE_META } from '@/components/ui/tokens';
import {
  money, STAGES, STAGE_LABEL, type Customer360, type Stage,
} from '@/lib/customers';
import { PriorityPill } from './shared';

/** A compact key/value chip in the header's facts strip. */
function FactChip({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-secondary">
      <Icon className="h-3.5 w-3.5 shrink-0 text-tertiary" strokeWidth={2.25} />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

export function Customer360Header({
  data,
  busy,
  onTransition,
  onMarkLost,
  onReopen,
}: {
  data: Customer360;
  busy: boolean;
  onTransition: (to: Stage) => void;
  onMarkLost: () => void;
  onReopen: () => void;
}) {
  const { relationship: rel, contact } = data;
  const name = contact?.displayName ?? `Contact ${rel.contactId.slice(0, 8)}…`;
  const initials = useMemo(() => {
    const src = contact?.displayName?.trim();
    if (!src) return '··';
    const parts = src.split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '··';
  }, [contact?.displayName]);

  const primaryEmail = contact?.emails?.find((e) => e.is_primary)?.address ?? contact?.primaryEmail ?? contact?.emails?.[0]?.address ?? null;
  const primaryPhone = contact?.phones?.find((p) => p.is_primary)?.e164 ?? contact?.phones?.[0]?.e164 ?? null;

  // The next legal forward stage (the funnel rule is forward, one step at a time).
  const idx = STAGES.indexOf(rel.stage);
  const nextStage: Stage | null = !rel.isLost && idx >= 0 && idx < STAGES.length - 1 ? STAGES[idx + 1] : null;
  const meta = STAGE_META[rel.stage];

  return (
    <section className="relative overflow-hidden rounded-token-xl border border-subtle bg-surface-raised/70">
      {/* stage-tinted bloom */}
      <div aria-hidden className={cn('pointer-events-none absolute -left-16 -top-20 h-56 w-80 rounded-full bg-gradient-to-br opacity-30 blur-3xl', meta.grad)} />
      <div className="relative p-5 sm:p-6">
        <Link
          href="/dashboard/customers"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-tertiary transition-colors hover:text-primary"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2.4} />
          Relationships
        </Link>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-5">
          {/* identity */}
          <div className="flex min-w-0 items-start gap-4">
            <span
              className={cn(
                'relative grid h-14 w-14 shrink-0 place-items-center rounded-token-lg bg-gradient-to-br text-lg font-bold text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25),0_8px_20px_-6px_rgba(0,0,0,0.5)]',
                rel.isLost ? 'from-slate-500 to-slate-600' : 'from-accent to-fuchsia',
              )}
            >
              {initials}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="truncate text-2xl font-semibold tracking-tight text-primary">{name}</h1>
                {rel.isLost ? (
                  <Badge variant="danger" dot>Lost</Badge>
                ) : (
                  <StageBadge stage={rel.stage} />
                )}
                <PriorityPill priority={rel.priority} />
              </div>
              {/* contact facts strip */}
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {contact?.currentOrgName && <FactChip icon={Building2}>{contact.currentOrgName}</FactChip>}
                {primaryEmail && (
                  <a href={`mailto:${primaryEmail}`} className="inline-flex">
                    <FactChip icon={Mail}>{primaryEmail}</FactChip>
                  </a>
                )}
                {primaryPhone && (
                  <a href={`tel:${primaryPhone}`} className="inline-flex">
                    <FactChip icon={Phone}>{primaryPhone}</FactChip>
                  </a>
                )}
                {!contact && (
                  <span className="text-[13px] text-tertiary">Contact details federate from Contact-Ops (currently unavailable)</span>
                )}
              </div>
              {/* tags */}
              {contact?.tags && contact.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {contact.tags.map((t) => (
                    <Badge key={t} variant="neutral">{t}</Badge>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* lifecycle actions */}
          <div className="flex shrink-0 flex-col items-end gap-2">
            <div className="flex flex-wrap items-center justify-end gap-2">
              {rel.isLost ? (
                <Button
                  size="sm"
                  glow
                  disabled={busy}
                  leading={<RotateCcw className="h-4 w-4" strokeWidth={2.4} />}
                  onClick={onReopen}
                >
                  Re-open
                </Button>
              ) : (
                <>
                  {nextStage && (
                    <Button
                      size="sm"
                      glow
                      disabled={busy}
                      leading={<ArrowRight className="h-4 w-4" strokeWidth={2.4} />}
                      onClick={() => onTransition(nextStage)}
                      title={`Advance to ${STAGE_LABEL[nextStage]} (funnel rules enforced server-side)`}
                    >
                      Advance to {STAGE_META[nextStage].label}
                    </Button>
                  )}
                  {!nextStage && (
                    <Badge variant="success" dot>
                      <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                      Customer
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    leading={<Flag className="h-4 w-4" strokeWidth={2.4} />}
                    onClick={onMarkLost}
                  >
                    Mark lost
                  </Button>
                </>
              )}
            </div>
            {/* stepper — the full funnel, current highlighted */}
            <div className="flex items-center gap-1">
              {STAGES.map((s, i) => {
                const m = STAGE_META[s];
                const active = s === rel.stage && !rel.isLost;
                const passed = !rel.isLost && i < idx;
                return (
                  <div key={s} className="flex items-center gap-1">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors',
                        active ? cn(m.well, m.text) : passed ? 'text-tertiary' : 'text-muted',
                      )}
                    >
                      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', active ? m.dot : passed ? 'bg-success' : 'bg-[rgb(var(--co-edge))]')} />
                      {m.label}
                    </span>
                    {i < STAGES.length - 1 && <span aria-hidden className="text-muted">·</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* lost reason banner */}
        {rel.isLost && rel.lostReason && (
          <div className="mt-4 flex items-start gap-2 rounded-token border border-danger/25 bg-danger-subtle px-3.5 py-2.5 text-[13px] text-danger">
            <CircleSlash className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} />
            <span>
              <span className="font-semibold">Marked lost.</span> {rel.lostReason}
              {rel.closedLostAt && (
                <span className="text-danger/70"> · {new Date(rel.closedLostAt).toLocaleDateString()}</span>
              )}
            </span>
          </div>
        )}

        {/* facts row — value / owner / source / next action / stage-since */}
        <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-subtle pt-4 sm:grid-cols-3 lg:grid-cols-5">
          <Fact icon={Banknote} label="Expected value" value={money(rel.expectedValue, rel.currency ?? 'USD')} emphasize />
          <Fact icon={UserRound} label="Owner" value={rel.ownerUserKey ?? 'Unassigned'} />
          <Fact icon={Flag} label="Source" value={rel.source ?? '—'} />
          <Fact icon={CalendarClock} label="Next action" value={rel.nextActionAt ? new Date(rel.nextActionAt).toLocaleDateString() : '—'} />
          <Fact icon={ArrowRight} label="In stage since" value={new Date(rel.lastStageChangeAt).toLocaleDateString()} />
        </div>
      </div>
    </section>
  );
}

function Fact({
  icon: Icon, label, value, emphasize,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-tertiary">
        <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
        {label}
      </div>
      <div className={cn('mt-1 truncate', emphasize ? 'font-mono text-base font-semibold text-primary tabular-nums' : 'text-[13px] text-secondary')}>
        {value}
      </div>
    </div>
  );
}

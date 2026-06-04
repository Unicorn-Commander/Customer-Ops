'use client';

import { useCallback, useState } from 'react';
import {
  ArrowUpRight, GripVertical, Inbox, MoveRight, CalendarClock, Flame, Minus, ChevronUp,
  type LucideIcon,
} from 'lucide-react';
import { IconTile } from '@/components/ui/IconTile';
import { cn } from '@/components/ui/cn';
import { STAGE_META } from '@/components/ui/tokens';
import {
  contactLabel, money, STAGES, STAGE_LABEL,
  type CustomerRow, type PipelineBoard as Board, type Priority, type Stage,
} from '@/lib/customers';

/**
 * PipelineBoard — the presentational kanban surface (Lead → Prospect → Customer).
 *
 * Pure UI: the parent owns data + the transition call. Drag a card to another
 * lane to move the relationship through the funnel; the parent applies the move
 * optimistically and calls the API (rejections reload the true state upstream).
 * Native HTML5 drag-and-drop only (no library). Reduced-motion safe (all motion
 * rides the design-system `co-lift` / token transitions, which the global
 * reduced-motion guard neutralises).
 */

/** The drag payload the lanes need to validate + route a drop. */
interface Dragging {
  id: string;
  from: Stage;
}

export interface PipelineBoardProps {
  board: Board;
  /** Move a card to a new stage. The parent does the optimistic update + API call. */
  onTransition: (id: string, from: Stage, to: Stage) => void;
  /** Open the customer-360 for a card (double-click / the card's open affordance). */
  onOpen?: (id: string) => void;
  /** A relationship currently mid-flight (its card shows a pending shimmer). */
  pendingId?: string | null;
}

/** Per-stage gradient for the lane header IconTile (full strings — Tailwind-safe). */
const HEAD_GRAD: Record<Stage, string> = {
  LEAD: 'from-sky-400 to-cyan-500',
  PROSPECT: 'from-violet-400 to-fuchsia-500',
  CUSTOMER: 'from-emerald-400 to-teal-500',
};

/** Soft per-stage ambient glow tint behind a lane (full strings — Tailwind-safe). */
const LANE_GLOW: Record<Stage, string> = {
  LEAD: 'bg-stage-lead/20',
  PROSPECT: 'bg-stage-prospect/20',
  CUSTOMER: 'bg-stage-customer/18',
};

const PRIORITY_META: Record<Priority, { label: string; icon: LucideIcon; cls: string }> = {
  HIGH: { label: 'High', icon: Flame, cls: 'bg-danger/12 text-danger' },
  MEDIUM: { label: 'Medium', icon: ChevronUp, cls: 'bg-warning/12 text-warning' },
  LOW: { label: 'Low', icon: Minus, cls: 'bg-surface-overlay text-tertiary' },
};

export function PipelineBoard({ board, onTransition, onOpen, pendingId }: PipelineBoardProps) {
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [overStage, setOverStage] = useState<Stage | null>(null);

  const laneOf = useCallback((s: Stage) => board.lanes.find((l) => l.stage === s), [board]);

  const handleDrop = useCallback(
    (to: Stage) => {
      const d = dragging;
      setDragging(null);
      setOverStage(null);
      if (!d || d.from === to) return; // dropped in its own lane → no-op
      onTransition(d.id, d.from, to);
    },
    [dragging, onTransition],
  );

  return (
    <div className="grid auto-rows-fr gap-4 lg:grid-cols-3">
      {STAGES.map((stage) => {
        const lane = laneOf(stage);
        const cards = lane?.cards ?? [];
        const meta = STAGE_META[stage];
        const isOver = overStage === stage;
        // A lane is a legal drop target while dragging from a DIFFERENT lane.
        const isTarget = dragging !== null && dragging.from !== stage;

        return (
          <section
            key={stage}
            aria-label={`${STAGE_LABEL[stage]} lane`}
            onDragOver={(e) => {
              if (!isTarget) return;
              e.preventDefault(); // allow drop
              e.dataTransfer.dropEffect = 'move';
              if (overStage !== stage) setOverStage(stage);
            }}
            onDragLeave={(e) => {
              // Only clear when the cursor truly leaves the lane (not child→child).
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              if (overStage === stage) setOverStage(null);
            }}
            onDrop={() => handleDrop(stage)}
            className={cn(
              'group/lane relative flex min-h-[26rem] flex-col overflow-hidden rounded-token-xl border',
              'bg-surface-raised/60 transition-[border-color,box-shadow,background-color] duration-token ease-token',
              isOver
                ? 'border-accent/60 bg-surface-raised/80 shadow-glow'
                : isTarget
                  ? 'border-dashed border-[rgb(var(--co-edge))]'
                  : 'border-subtle',
            )}
          >
            {/* Per-stage ambient bloom (brightens when targeted). */}
            <div
              aria-hidden
              className={cn(
                'pointer-events-none absolute -right-16 -top-20 h-44 w-64 rounded-full blur-[46px] transition-opacity duration-token',
                LANE_GLOW[stage],
                isOver ? 'opacity-100' : 'opacity-50',
              )}
            />

            {/* ---- Lane header: stage gradient + count + total expected value ---- */}
            <header className="relative shrink-0 border-b border-subtle px-3.5 pb-3 pt-3.5">
              <div
                aria-hidden
                className={cn('absolute inset-x-0 top-0 h-px bg-gradient-to-r', meta.grad)}
              />
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <IconTile icon={meta.icon} gradient={HEAD_GRAD[stage]} size="sm" />
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-primary">{STAGE_LABEL[stage]}</h3>
                    <p className="text-[11px] text-tertiary">
                      {money(lane?.expectedValue ?? '0')} expected
                    </p>
                  </div>
                </div>
                <span
                  className={cn(
                    'grid h-6 min-w-[1.5rem] shrink-0 place-items-center rounded-full px-1.5 text-xs font-semibold tabular-nums',
                    meta.well, meta.text,
                  )}
                >
                  {cards.length}
                </span>
              </div>
            </header>

            {/* ---- Card column (scrollable) ---- */}
            <div className="relative flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
              {cards.length === 0 ? (
                <LaneEmpty stage={stage} isTarget={isTarget} isOver={isOver} />
              ) : (
                cards.map((row) => (
                  <PipelineCard
                    key={row.id}
                    row={row}
                    pending={pendingId === row.id}
                    dragging={dragging?.id === row.id}
                    onDragStart={(e) => {
                      setDragging({ id: row.id, from: stage });
                      e.dataTransfer.effectAllowed = 'move';
                      // A payload is required for Firefox to initiate the drag.
                      try { e.dataTransfer.setData('text/plain', row.id); } catch { /* noop */ }
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOverStage(null);
                    }}
                    onOpen={onOpen ? () => onOpen(row.id) : undefined}
                  />
                ))
              )}

              {/* Drop affordance shown at the foot of a populated target lane. */}
              {isTarget && cards.length > 0 && (
                <div
                  className={cn(
                    'flex items-center justify-center gap-1.5 rounded-token border border-dashed py-2.5 text-[11px] font-medium transition-colors duration-token',
                    isOver
                      ? cn('border-accent/50', meta.text)
                      : 'border-[rgb(var(--co-edge))] text-muted',
                  )}
                >
                  <MoveRight className="h-3.5 w-3.5" strokeWidth={2.4} />
                  Drop to move to {meta.label}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** A single relationship card — draggable, hover-lifts, opens the 360. */
function PipelineCard({
  row, pending, dragging, onDragStart, onDragEnd, onOpen,
}: {
  row: CustomerRow;
  pending: boolean;
  dragging: boolean;
  onDragStart: (e: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onOpen?: () => void;
}) {
  const meta = STAGE_META[row.stage];
  const prio = PRIORITY_META[row.priority];
  const PrioIcon = prio.icon;
  const org = row.contact?.currentOrgName ?? null;
  const sub = org ?? row.contact?.primaryEmail ?? `contact ${row.contactId.slice(0, 8)}…`;
  const nextAction = formatNextAction(row.nextActionAt);

  return (
    <article
      draggable={!pending}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDoubleClick={onOpen}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={(e) => {
        if (!onOpen) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
      }}
      aria-label={`${contactLabel(row)} — ${meta.label}, ${prio.label} priority`}
      title="Drag to move stage · double-click to open the 360"
      className={cn(
        'co-lift group relative overflow-hidden rounded-token-lg border border-subtle bg-surface-raised',
        'p-3 shadow-token outline-none',
        !pending && 'cursor-grab active:cursor-grabbing',
        'focus-visible:ring-2 focus-visible:ring-accent/50',
        dragging && 'opacity-40',
        pending && 'pointer-events-none animate-pulse',
      )}
    >
      {/* Stage rail down the left edge — the card's funnel color. */}
      <div aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', meta.dot)} />

      <div className="flex items-start gap-2 pl-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="truncate text-sm font-semibold text-primary">{contactLabel(row)}</h4>
          </div>
          <p className="mt-0.5 truncate text-xs text-tertiary">{sub}</p>
        </div>

        {/* Grab handle (decorative) + open affordance on hover. */}
        <div className="flex shrink-0 items-center gap-0.5">
          {onOpen && (
            <span
              className="grid h-6 w-6 place-items-center rounded-md text-muted opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100"
              aria-hidden
            >
              <ArrowUpRight className="h-4 w-4" strokeWidth={2.4} />
            </span>
          )}
          <span aria-hidden className="grid h-6 w-5 place-items-center text-muted/70">
            <GripVertical className="h-4 w-4" />
          </span>
        </div>
      </div>

      {/* ---- Meta row: expected value + priority chip ---- */}
      <div className="mt-2.5 flex items-center justify-between gap-2 pl-1.5">
        <span className="font-mono text-sm font-semibold tabular-nums text-primary">
          {money(row.expectedValue, row.currency ?? 'USD')}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
            prio.cls,
          )}
        >
          <PrioIcon className="h-3 w-3" strokeWidth={2.6} />
          {prio.label}
        </span>
      </div>

      {/* ---- Next action (when set) ---- */}
      {nextAction && (
        <div
          className={cn(
            'mt-2 flex items-center gap-1.5 border-t border-subtle pl-1.5 pt-2 text-[11px]',
            nextAction.overdue ? 'text-danger' : 'text-tertiary',
          )}
        >
          <CalendarClock className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
          <span className="truncate">{nextAction.label}</span>
        </div>
      )}
    </article>
  );
}

/** The beautiful per-lane empty state — a tinted well, not a bare line. */
function LaneEmpty({ stage, isTarget, isOver }: { stage: Stage; isTarget: boolean; isOver: boolean }) {
  const meta = STAGE_META[stage];
  return (
    <div
      className={cn(
        'flex h-full min-h-[12rem] flex-col items-center justify-center rounded-token-lg border border-dashed px-4 py-8 text-center transition-colors duration-token',
        isOver
          ? cn('border-accent/50 bg-surface-overlay/60')
          : isTarget
            ? 'border-[rgb(var(--co-edge))] bg-surface-overlay/30'
            : 'border-subtle/70',
      )}
    >
      <span
        className={cn('grid h-9 w-9 place-items-center rounded-full', meta.well)}
      >
        {isTarget
          ? <MoveRight className={cn('h-4 w-4', meta.text)} strokeWidth={2.4} />
          : <Inbox className={cn('h-4 w-4', meta.text)} strokeWidth={2.2} />}
      </span>
      <p className="mt-2.5 text-xs font-medium text-secondary">
        {isTarget ? `Drop to move to ${meta.label}` : `No ${meta.label.toLowerCase()}s yet`}
      </p>
      {!isTarget && (
        <p className="mt-0.5 text-[11px] text-muted">Drag a card here to advance it</p>
      )}
    </div>
  );
}

/** A short, human "next action" line. Past → "overdue"; today/soon → relative. */
function formatNextAction(iso: string | null): { label: string; overdue: boolean } | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const now = Date.now();
  const dayMs = 86_400_000;
  const diffDays = Math.round((t - now) / dayMs);
  if (t < now) {
    const overdueDays = Math.max(1, Math.round((now - t) / dayMs));
    return { label: overdueDays <= 1 ? 'Follow-up overdue' : `Overdue ${overdueDays}d`, overdue: true };
  }
  if (diffDays === 0) return { label: 'Follow up today', overdue: false };
  if (diffDays === 1) return { label: 'Follow up tomorrow', overdue: false };
  if (diffDays <= 7) return { label: `Follow up in ${diffDays}d`, overdue: false };
  const label = new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return { label: `Follow up ${label}`, overdue: false };
}

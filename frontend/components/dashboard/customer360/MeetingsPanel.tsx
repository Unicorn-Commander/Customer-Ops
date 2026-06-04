'use client';

import { Video, ListChecks, CornerDownRight, Clock, CheckCircle2 } from 'lucide-react';
import { Badge, cn } from '@/components/ui';
import { meetingStatusLabel, type MeetingPanel as MeetingPanelData } from '@/lib/customers';
import { ConnectNotice, EmptyRow, ListRow, PanelSection, SourceTag, StatusPill } from './shared';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDuration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Meetings & action items — the FEDERATED Meeting-Ops panel (Phase 5). Renders
 * meetings + the latest summary + action items, resolved read-time by the backend
 * (never copied; no transcript stored). Reads are viewer-level, so the only
 * affordance is the connect state. Each action item shows whether Meeting-Ops'
 * own bridge already turned it into a Project-Ops task (a "→ task" tag) —
 * Customer-Ops never creates the task.
 */
export function MeetingsPanel({ panel }: { panel: MeetingPanelData }) {
  const empty = panel.meetings.length === 0 && panel.summaries.length === 0 && panel.actionItems.length === 0;
  const openItems = panel.actionItems.filter((a) => a.status !== 'done' && a.status !== 'completed').length;
  const subtitle = panel.configured
    ? empty
      ? 'No meetings yet'
      : `${panel.meetings.length} meeting${panel.meetings.length === 1 ? '' : 's'}${
          panel.actionItems.length ? ` · ${openItems} open action item${openItems === 1 ? '' : 's'}` : ''
        }`
    : 'Meeting-Ops';
  const latest = panel.summaries[0];

  return (
    <PanelSection
      icon={Video}
      gradient="from-teal-400 to-cyan-500"
      title="Meetings & action items"
      subtitle={subtitle}
      tag={<SourceTag configured={panel.configured} source="meeting-ops" />}
    >
      {!panel.configured ? (
        <ConnectNotice app="Meeting-Ops">
          Conversation signal is federated from Meeting-Ops — Customer-Ops never stores a transcript or summary.
        </ConnectNotice>
      ) : empty ? (
        <EmptyRow>No meetings with this contact yet.</EmptyRow>
      ) : (
        <div className="space-y-4">
          {panel.meetings.length > 0 && (
            <ul className="-mx-1 space-y-0.5">
              {panel.meetings.map((m) => {
                const s = meetingStatusLabel(m.status);
                const dur = fmtDuration(m.durationSeconds);
                return (
                  <ListRow
                    key={m.id}
                    leadingDot="bg-feat-meetings/70"
                    title={m.title ?? '(untitled meeting)'}
                    meta={
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="h-3 w-3" strokeWidth={2.25} />
                        {fmtDate(m.startedAt)}
                        {dur ? ` · ${dur}` : ''}
                        {m.actionItemCount > 0 ? ` · ${m.actionItemCount} action item${m.actionItemCount === 1 ? '' : 's'}` : ''}
                      </span>
                    }
                    trailing={<StatusPill status={s} />}
                  />
                );
              })}
            </ul>
          )}

          {latest && (latest.headline || latest.body) && (
            <div className="rounded-token border border-subtle bg-surface-overlay/50 p-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-tertiary">
                <CheckCircle2 className="h-3.5 w-3.5 text-feat-meetings" strokeWidth={2.25} />
                Latest summary
              </div>
              {latest.headline && <p className="text-[13px] font-medium text-primary">{latest.headline}</p>}
              {latest.body && <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-secondary">{latest.body}</p>}
              {latest.keyPoints?.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {latest.keyPoints.slice(0, 4).map((pt, i) => (
                    <li key={i} className="flex gap-2 text-xs text-tertiary">
                      <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-feat-meetings/70" />
                      <span className="min-w-0">{pt}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {panel.actionItems.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-tertiary">
                <ListChecks className="h-3.5 w-3.5" strokeWidth={2.25} />
                Action items
              </div>
              <ul className="space-y-1.5">
                {panel.actionItems.map((a) => {
                  const done = a.status === 'done' || a.status === 'completed';
                  return (
                    <li key={a.id} className="flex items-start gap-2.5">
                      <span
                        aria-hidden
                        className={cn(
                          'mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border',
                          done ? 'border-success bg-success-subtle' : 'border-[rgb(var(--co-edge))]',
                        )}
                      >
                        {done && <CheckCircle2 className="h-3 w-3 text-success" strokeWidth={2.5} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className={cn('text-[13px] leading-snug', done ? 'text-tertiary line-through' : 'text-secondary')}>
                          {a.text}
                        </p>
                        {(a.assigneeLabel || a.dueAt) && (
                          <p className="mt-0.5 text-[11px] text-muted">
                            {a.assigneeLabel ?? ''}
                            {a.assigneeLabel && a.dueAt ? ' · ' : ''}
                            {a.dueAt ? `due ${fmtDate(a.dueAt)}` : ''}
                          </p>
                        )}
                      </div>
                      {a.projectOpsTaskId && (
                        <Badge variant="success" className="shrink-0" title="Meeting-Ops linked this to a Project-Ops task">
                          <CornerDownRight className="h-3 w-3" strokeWidth={2.5} />
                          task
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </PanelSection>
  );
}

'use client';

import { useState } from 'react';
import {
  ArrowRightLeft, StickyNote, Bot, Flag, RotateCcw, Sparkles, Send, type LucideIcon,
} from 'lucide-react';
import { Button, StageBadge, cn } from '@/components/ui';
import { formatDateTime, relativeTime } from '@/lib/format';
import type { Stage, TimelineEntry } from '@/lib/customers';

/* ── per-kind visual meta ─────────────────────────────────────────────────── */
interface KindMeta { icon: LucideIcon; well: string; ring: string; label: string }

function metaFor(kind: string): KindMeta {
  const k = kind.toLowerCase();
  if (k.includes('stage') || k.includes('transition'))
    return { icon: ArrowRightLeft, well: 'bg-accent/12 text-accent', ring: 'ring-accent/25', label: 'Stage change' };
  if (k.includes('note'))
    return { icon: StickyNote, well: 'bg-feat-relationships/12 text-feat-relationships', ring: 'ring-feat-relationships/25', label: 'Note' };
  if (k.includes('agent'))
    return { icon: Bot, well: 'bg-feat-agents/12 text-feat-agents', ring: 'ring-feat-agents/25', label: 'Agent run' };
  if (k.includes('lost'))
    return { icon: Flag, well: 'bg-danger-subtle text-danger', ring: 'ring-danger/25', label: 'Marked lost' };
  if (k.includes('reopen'))
    return { icon: RotateCcw, well: 'bg-info-subtle text-info', ring: 'ring-info/25', label: 'Re-opened' };
  if (k.includes('email') || k.includes('outreach'))
    return { icon: Send, well: 'bg-feat-email/12 text-feat-email', ring: 'ring-feat-email/25', label: 'Outbound' };
  if (k.includes('create') || k.includes('lead'))
    return { icon: Sparkles, well: 'bg-stage-lead/12 text-stage-lead', ring: 'ring-stage-lead/25', label: 'Created' };
  return { icon: Sparkles, well: 'bg-surface-overlay text-tertiary', ring: 'ring-[rgb(var(--co-edge))]', label: kind.replace(/_/g, ' ') };
}

/* ── one entry ────────────────────────────────────────────────────────────── */
function TimelineItem({ entry, last }: { entry: TimelineEntry; last: boolean }) {
  const meta = metaFor(entry.kind);
  const Icon = meta.icon;
  const isStage = entry.fromStage && entry.toStage;

  return (
    <li className="relative flex gap-3.5 pb-5 last:pb-0">
      {/* connecting rail */}
      {!last && (
        <span
          aria-hidden
          className="absolute left-[15px] top-9 bottom-0 w-px bg-[rgb(var(--co-edge))]/60"
        />
      )}
      {/* node */}
      <span
        className={cn(
          'relative z-10 grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full ring-1',
          meta.well,
          meta.ring,
        )}
      >
        <Icon className="h-[15px] w-[15px]" strokeWidth={2.25} />
      </span>
      {/* body */}
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-semibold capitalize text-primary">{meta.label}</span>
          {isStage && (
            <span className="inline-flex items-center gap-1.5 text-xs text-tertiary">
              <StageBadge stage={entry.fromStage as Stage} className="px-2 py-0" />
              <span aria-hidden className="text-muted">→</span>
              <StageBadge stage={entry.toStage as Stage} className="px-2 py-0" />
            </span>
          )}
          <span className="ml-auto shrink-0 text-[11px] text-muted" title={formatDateTime(entry.createdAt)}>
            {relativeTime(entry.createdAt)}
          </span>
        </div>
        {entry.body && (
          <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-secondary">
            {entry.body}
          </p>
        )}
        {entry.actorUcUid && (
          <p className="mt-1 text-[11px] text-muted">by {entry.actorUcUid}</p>
        )}
      </div>
    </li>
  );
}

/* ── the panel ────────────────────────────────────────────────────────────── */
export function Timeline({
  entries,
  onAddNote,
  busy,
}: {
  entries: TimelineEntry[];
  onAddNote: (body: string) => void | Promise<void>;
  busy: boolean;
}) {
  const [note, setNote] = useState('');
  const canAdd = note.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canAdd) return;
    await onAddNote(note.trim());
    setNote('');
  };

  return (
    <div className="rounded-token-lg border border-subtle bg-surface-raised shadow-token">
      <div className="flex items-center justify-between gap-3 border-b border-subtle px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-token bg-feat-relationships/12">
            <StickyNote className="h-[15px] w-[15px] text-feat-relationships" strokeWidth={2.25} />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-primary">Activity</h3>
            <p className="text-[11px] text-tertiary">{entries.length} event{entries.length === 1 ? '' : 's'} · newest first</p>
          </div>
        </div>
      </div>

      {/* composer */}
      <div className="border-b border-subtle p-4">
        <textarea
          className={cn(
            'w-full resize-none rounded-token border border-subtle bg-surface-overlay px-3 py-2 text-[13px] text-primary',
            'placeholder:text-muted focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30',
          )}
          rows={2}
          placeholder="Add a note to the timeline…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
          }}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-muted">⌘↵ to post</span>
          <Button size="sm" disabled={!canAdd} onClick={() => void submit()}>
            {busy ? 'Posting…' : 'Add note'}
          </Button>
        </div>
      </div>

      {/* feed */}
      <div className="p-4">
        {entries.length === 0 ? (
          <div className="py-10 text-center">
            <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-surface-overlay">
              <StickyNote className="h-5 w-5 text-muted" strokeWidth={2} />
            </span>
            <p className="text-sm font-medium text-secondary">No activity yet</p>
            <p className="mt-1 text-xs text-tertiary">
              Stage changes, notes, and agent runs will appear here as the relationship moves.
            </p>
          </div>
        ) : (
          <ul className="relative">
            {entries.map((e, i) => (
              <TimelineItem key={e.id} entry={e} last={i === entries.length - 1} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

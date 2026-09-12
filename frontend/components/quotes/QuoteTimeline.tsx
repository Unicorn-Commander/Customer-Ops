/**
 * The quote timeline — `quote_events`, append-only (contract §1).
 *
 * It is the answer to "what actually happened to this piece of paper": who
 * drafted it, which version went out, when the client opened it and from
 * where, which package they clicked, the pending acceptance, the wrong codes,
 * the acceptance itself, and each federation adapter as it lands.
 *
 * The actor is the interesting column here, not the verb — `member:`,
 * `client:`, `agent:` and `system` are rendered as three visibly different
 * kinds of hand, because "an agent drafted this" and "the client accepted it"
 * must never look the same at a glance.
 */

'use client';

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  Eye,
  FilePlus2,
  FolderKanban,
  Hand,
  KeyRound,
  Layers,
  Mail,
  MousePointerClick,
  Pencil,
  Send,
  User,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/components/ui';
import type { QuoteEvent, QuoteEventKind } from '@/lib/quotes/quotes-render/quote-model';

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

interface EventMeta {
  icon: LucideIcon;
  label: string;
  tone: Tone;
}

const META: Record<QuoteEventKind, EventMeta> = {
  created: { icon: FilePlus2, label: 'Drafted', tone: 'neutral' },
  updated: { icon: Pencil, label: 'Edited', tone: 'neutral' },
  sent: { icon: Send, label: 'Sent', tone: 'accent' },
  send_approved: { icon: Mail, label: 'Send approved', tone: 'accent' },
  viewed: { icon: Eye, label: 'Opened by the client', tone: 'accent' },
  option_selected: { icon: MousePointerClick, label: 'Package chosen', tone: 'accent' },
  acceptance_pending: { icon: KeyRound, label: 'Code sent', tone: 'warn' },
  acceptance_code_failed: { icon: AlertTriangle, label: 'Wrong code', tone: 'warn' },
  accepted: { icon: CheckCircle2, label: 'Accepted', tone: 'ok' },
  declined: { icon: Ban, label: 'Declined', tone: 'danger' },
  expired: { icon: Clock, label: 'Expired', tone: 'warn' },
  superseded: { icon: Layers, label: 'Superseded', tone: 'warn' },
  revoked: { icon: Ban, label: 'Link withdrawn', tone: 'warn' },
  voided: { icon: Ban, label: 'Voided', tone: 'danger' },
  project_created: { icon: FolderKanban, label: 'Project created', tone: 'ok' },
  invoice_created: { icon: CircleDollarSign, label: 'Invoice drafted', tone: 'ok' },
  partner_invoice_created: { icon: CircleDollarSign, label: 'Partner bill drafted', tone: 'ok' },
  federation_retried: { icon: Layers, label: 'Federation retried', tone: 'warn' },
  error: { icon: AlertTriangle, label: 'Error', tone: 'danger' },
};

const TONE_RING: Record<Tone, string> = {
  neutral: 'ring-1 ring-[rgb(var(--co-edge))] text-tertiary',
  accent: 'ring-1 ring-accent/50 text-accent bg-accent/10',
  ok: 'ring-1 ring-success/50 text-success bg-success-subtle',
  warn: 'ring-1 ring-warning/50 text-warning bg-warning-subtle',
  danger: 'ring-1 ring-danger/50 text-danger bg-danger-subtle',
};

/** `member:aaron` → a person; `client:fx-order` → the other side; `agent:x` → a machine. */
function actorParts(actor: string): { icon: LucideIcon; kind: string; name: string } {
  const [kind, ...rest] = actor.split(':');
  const name = rest.join(':') || kind;
  if (kind === 'agent') return { icon: Bot, kind: 'agent', name };
  if (kind === 'client') return { icon: Hand, kind: 'client', name: `token ${name}` };
  if (kind === 'member') return { icon: User, kind: 'member', name };
  return { icon: User, kind: 'system', name: 'system' };
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** One line of plain language per event, built from its data payload. */
function detail(event: QuoteEvent): string | null {
  const d = (event.data ?? {}) as Record<string, unknown>;
  const str = (k: string): string | null => (typeof d[k] === 'string' ? (d[k] as string) : null);
  const num = (k: string): number | null => (typeof d[k] === 'number' ? (d[k] as number) : null);
  switch (event.kind) {
    case 'created':
      return str('via') ? `via ${str('via')}${str('assumed') ? ` — assumed ${str('assumed')}` : ''}` : null;
    case 'updated':
      return Array.isArray(d.fields) ? `fields: ${(d.fields as string[]).join(', ')}` : null;
    case 'sent':
    case 'send_approved':
      return num('version_no') !== null ? `version ${num('version_no')}` : null;
    case 'viewed':
      return num('version_no') !== null ? `version ${num('version_no')}` : null;
    case 'option_selected':
      return str('label') ? `chose “${str('label')}”` : null;
    case 'superseded':
      return `version ${num('from_version_no')} → ${num('to_version_no')}${str('reason') ? ` · ${str('reason')}` : ''}`;
    case 'acceptance_code_failed':
      return num('attempts_left') !== null ? `${num('attempts_left')} attempts left` : null;
    default:
      return str('detail') ?? str('reason') ?? str('message') ?? null;
  }
}

export function QuoteTimeline({ events, className, limit }: { events: QuoteEvent[]; className?: string; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  const ordered = useMemo(() => [...events].sort((a, b) => (a.at < b.at ? 1 : -1)), [events]);
  const cap = limit ?? 0;
  const shown = !expanded && cap > 0 ? ordered.slice(0, cap) : ordered;
  const hidden = ordered.length - shown.length;

  if (!ordered.length) {
    return <p className={cn('text-[13px] text-muted', className)}>Nothing has happened to this quote yet.</p>;
  }

  return (
    <div className={className}>
      <ol className="relative">
        {shown.map((event, i) => {
          const meta = META[event.kind] ?? { icon: Pencil, label: event.kind.replace(/_/g, ' '), tone: 'neutral' as Tone };
          const Icon = meta.icon;
          const actor = actorParts(event.actor);
          const ActorIcon = actor.icon;
          const line = detail(event);
          const last = i === shown.length - 1;
          return (
            <li key={event.id} className="relative flex gap-3.5 pb-4 last:pb-0">
              {!last ? <span aria-hidden="true" className="absolute bottom-0 left-[15px] top-9 w-px bg-[rgb(var(--co-edge))]/60" /> : null}
              <span className={cn('mt-0.5 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full', TONE_RING[meta.tone])}>
                <Icon className="h-[15px] w-[15px]" strokeWidth={2.25} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[13.5px] font-medium text-primary">{meta.label}</span>
                  <time className="font-mono text-[11px] tabular-nums text-muted" dateTime={event.at} title={event.at}>
                    {when(event.at)}
                  </time>
                </div>
                {line ? <p className="mt-0.5 text-[12.5px] leading-relaxed text-secondary">{line}</p> : null}
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-tertiary">
                  <ActorIcon className="h-3 w-3" strokeWidth={2.25} />
                  <span className="font-mono">{actor.name}</span>
                  {event.ip ? <span className="text-muted">· {event.ip}</span> : null}
                  {event.ua ? <span className="truncate text-muted">· {event.ua}</span> : null}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 rounded-token px-1 py-1 text-[12px] text-accent transition-colors duration-fast hover:text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
        >
          Show {hidden} earlier event{hidden === 1 ? '' : 's'}
        </button>
      ) : null}
    </div>
  );
}

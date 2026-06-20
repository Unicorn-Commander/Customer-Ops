'use client';

/* =============================================================================
   Relations Officer — the live "Agents" section
   -----------------------------------------------------------------------------
   A chat surface for the workspace's relationship agent. The Officer ADVISES by
   default (Advisor mode) and can ACT only when switched to Operator — and even
   then every write is a Confirm/Cancel card: the agent proposes, you decide.

   The transcript is a list of typed entries: plain messages, an inline
   Confirm/Cancel card (when a turn returns a `proposedAction`), and structured
   sub-agent result cards (Triage / Follow-up / Collections), which reuse the
   customer-360 AgentsPanel result-card language so the cockpit reads as one
   design system.

   Inference may be unconfigured — the backend says so per turn
   (`inferenceConfigured:false`) and the Officer's own reply carries the
   "connect inference" affordance, so the surface degrades clean (never crashes).
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Send, Sparkles, ShieldCheck, ShieldAlert, Check, X, ChevronDown,
  Gauge, PenLine, BellRing, Compass, CalendarClock, ArrowRight, Lock, Copy,
  AlertTriangle, type LucideIcon,
} from 'lucide-react';
import { Badge, Button, cn } from '@/components/ui';
import { useWorkspace } from '@/lib/useWorkspace';
import {
  listCustomers, contactLabel, money,
  runTriage, draftFollowUp, draftCollectionsNudge,
  type CustomerRow,
  type TriageResult, type FollowUpResult, type CollectionsNudgeResult,
} from '@/lib/customers';
import {
  chatRelationsOfficer, confirmRelationsOfficerAction,
  type RelationsOfficerMode, type RelationsOfficerMessage,
  type RelationsOfficerProposedAction,
} from '@/lib/relations-officer';

/* ── persona constants ─────────────────────────────────────────────────────
   The Relations Officer avatar ships as a web asset at /relations-officer.png
   (frontend/public/), rendered by OfficerAvatar. Coral #FF5D73 is the persona
   accent (people); the cyan token is "connected". */
const CORAL = '#FF5D73';

/* ── the transcript model ──────────────────────────────────────────────────── */
let ENTRY_SEQ = 0;
const nextId = () => `e${++ENTRY_SEQ}`;

type Entry =
  | { id: string; kind: 'msg'; role: 'user' | 'assistant'; text: string; inferenceOff?: boolean }
  | { id: string; kind: 'confirm'; action: RelationsOfficerProposedAction; decision: 'pending' | 'confirm' | 'cancel'; note?: string }
  | { id: string; kind: 'triage'; result: TriageResult }
  | { id: string; kind: 'follow-up'; result: FollowUpResult }
  | { id: string; kind: 'nudge'; result: CollectionsNudgeResult };

/* ── small persona avatar ──────────────────────────────────────────────────── */
function OfficerAvatar({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const dim = size === 'lg' ? 'h-11 w-11 rounded-[13px]' : size === 'sm' ? 'h-7 w-7 rounded-[9px]' : 'h-9 w-9 rounded-[11px]';
  return (
    <img
      src="/relations-officer.png"
      alt="The Relations Officer"
      className={cn(
        'shrink-0 object-cover ring-1 ring-white/10 shadow-[0_3px_8px_-2px_rgba(0,0,0,0.45)]',
        dim,
      )}
    />
  );
}

/* ── inference provenance tag (reused result-card meta) ────────────────────── */
function AgentMeta({
  result,
}: {
  result: { inferenceConfigured: boolean; entitled: boolean; tierUsed: string | null; inference: { lane: number | null } | null };
}) {
  if (!result.inferenceConfigured)
    return (
      <Badge variant="neutral">
        <Lock className="h-3 w-3" strokeWidth={2.5} />
        inference off
      </Badge>
    );
  if (!result.entitled) return <Badge variant="warning">not entitled</Badge>;
  const lane = result.inference?.lane;
  return (
    <Badge variant="accent">
      <ShieldCheck className="h-3 w-3" strokeWidth={2.5} />
      {result.tierUsed ?? 'bundled'}
      {lane != null ? ` · lane ${lane}` : ''}
    </Badge>
  );
}

/* ── a copyable read-only draft body (mirrors AgentsPanel) ─────────────────── */
function DraftBody({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — the textarea is still selectable */
    }
  };
  return (
    <div className="relative">
      <textarea
        readOnly
        value={value}
        rows={6}
        className="w-full resize-y rounded-token border border-subtle bg-surface-base/60 px-3 py-2 pr-10 font-mono text-xs leading-relaxed text-secondary focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
      <button
        type="button"
        onClick={() => void copy()}
        aria-label="Copy draft"
        className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-token border border-subtle bg-surface-raised text-tertiary transition-colors hover:text-primary"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" strokeWidth={2.5} /> : <Copy className="h-3.5 w-3.5" strokeWidth={2.25} />}
      </button>
    </div>
  );
}

/** Result-card shell: a colored left rail + a title row with the provenance tag. */
function ResultCard({
  icon, rail, title, meta, children,
}: { icon: LucideIcon; rail: string; title: string; meta: ReactNode; children: ReactNode }) {
  const Icon = icon;
  return (
    <div className="overflow-hidden rounded-token border border-subtle bg-surface-overlay/40">
      <div className={cn('border-l-2 p-3', rail)}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary">
            <Icon className="h-4 w-4 text-tertiary" strokeWidth={2.25} />
            {title}
          </span>
          {meta}
        </div>
        {children}
      </div>
    </div>
  );
}

/** The degrade-clean fallback when an agent returns context but no draft/score. */
function NoteFallback({ note }: { note: string }) {
  return (
    <p className="flex items-start gap-2 text-xs leading-relaxed text-tertiary">
      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" strokeWidth={2.25} />
      <span>{note}</span>
    </p>
  );
}

const triagePriorityVariant = (p: string | null) =>
  p === 'high' ? 'danger' : p === 'medium' ? 'warning' : 'neutral';

/* ── the structured sub-agent result cards (reuse AgentsPanel language) ─────── */
function TriageCard({ result }: { result: TriageResult }) {
  return (
    <ResultCard icon={Gauge} rail="border-feat-agents" title="Lead triage" meta={<AgentMeta result={result} />}>
      {result.score !== null ? (
        <>
          <div className="mb-2 flex items-center gap-3">
            <div className="flex items-baseline gap-1">
              <span className="font-mono text-2xl font-semibold tabular-nums text-primary">{result.score}</span>
              <span className="text-xs text-muted">/ 100</span>
            </div>
            {result.recommendedPriority && (
              <Badge variant={triagePriorityVariant(result.recommendedPriority)}>
                recommend {result.recommendedPriority}
              </Badge>
            )}
          </div>
          <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-surface-base">
            <div
              className="h-full rounded-full bg-gradient-to-r from-feat-agents to-fuchsia"
              style={{ width: `${Math.max(2, Math.min(100, result.score))}%`, transition: 'width var(--co-dur) var(--co-ease)' }}
            />
          </div>
          {result.rationale && <p className="text-xs leading-relaxed text-secondary">{result.rationale}</p>}
          {result.suggestedNextAction && (
            <p className="mt-2 flex items-start gap-1.5 text-[13px] text-primary">
              <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-feat-agents" strokeWidth={2.5} />
              <span>{result.suggestedNextAction}</span>
            </p>
          )}
        </>
      ) : (
        <NoteFallback note={result.note} />
      )}
    </ResultCard>
  );
}

function FollowUpCard({ result }: { result: FollowUpResult }) {
  return (
    <ResultCard icon={PenLine} rail="border-feat-email" title="Follow-up draft" meta={<AgentMeta result={result} />}>
      {result.subject ? (
        <>
          <p className="text-[13px] text-primary">
            <span className="text-tertiary">Subject:</span> {result.subject}
          </p>
          {result.toAddress && <p className="mb-2 mt-0.5 text-[11px] text-muted">To {result.toAddress}</p>}
          <div className={result.toAddress ? '' : 'mt-2'}>
            <DraftBody value={result.body ?? ''} />
          </div>
          {result.stagedDraft ? (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-warning-subtle px-2.5 py-1 text-[11px] font-medium text-warning">
              <AlertTriangle className="h-3 w-3" strokeWidth={2.5} />
              Staged as an Email-Ops draft — awaiting your approval, not sent
            </p>
          ) : (
            <p className="mt-2 text-[11px] text-muted">A draft. Copy it, or stage it from the Email panel — never auto-sent.</p>
          )}
        </>
      ) : (
        <NoteFallback note={result.note} />
      )}
    </ResultCard>
  );
}

function NudgeCard({ result }: { result: CollectionsNudgeResult }) {
  return (
    <ResultCard icon={BellRing} rail="border-feat-invoices" title="Payment nudge draft" meta={<AgentMeta result={result} />}>
      {result.overdueInvoices.length > 0 && (
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-danger-subtle px-2.5 py-1 text-[11px] font-medium text-danger">
          {result.overdueInvoices.length} overdue · {money(result.totalOverdue, result.overdueInvoices[0]?.currency ?? 'USD')} due
        </div>
      )}
      {result.subject ? (
        <>
          <p className="text-[13px] text-primary">
            <span className="text-tertiary">Subject:</span> {result.subject}
          </p>
          <div className="mt-2">
            <DraftBody value={result.body ?? ''} />
          </div>
          <p className="mt-2 text-[11px] text-muted">Draft only — review, then send it yourself. The agent never charges or sends.</p>
        </>
      ) : (
        <NoteFallback note={result.note} />
      )}
    </ResultCard>
  );
}

/* ── the inline Confirm / Cancel card for a proposed action ────────────────── */
function ConfirmCard({
  entry, busy, onDecision,
}: {
  entry: Extract<Entry, { kind: 'confirm' }>;
  busy: boolean;
  onDecision: (decision: 'confirm' | 'cancel') => void;
}) {
  const decided = entry.decision !== 'pending';
  return (
    <div
      className="overflow-hidden rounded-token-lg border bg-surface-overlay/50"
      style={{ borderColor: `${CORAL}66` }}
    >
      <div className="border-l-2 p-3.5" style={{ borderColor: CORAL }}>
        <div className="mb-1.5 flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-md" style={{ backgroundColor: `${CORAL}22`, color: CORAL }}>
            <ShieldAlert className="h-3.5 w-3.5" strokeWidth={2.5} />
          </span>
          <span className="text-[13px] font-semibold text-primary">{entry.action.label}</span>
          <Badge variant="neutral" className="ml-auto font-mono lowercase">{entry.action.kind}</Badge>
        </div>
        <p className="text-xs leading-relaxed text-secondary">{entry.action.detail}</p>

        {decided ? (
          <p className={cn(
            'mt-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
            entry.decision === 'confirm' ? 'bg-success-subtle text-success' : 'bg-surface-overlay text-tertiary',
          )}>
            {entry.decision === 'confirm'
              ? <><Check className="h-3 w-3" strokeWidth={2.5} /> Confirmed</>
              : <><X className="h-3 w-3" strokeWidth={2.5} /> Cancelled</>}
            {entry.note ? ` · ${entry.note}` : ''}
          </p>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <Button
              size="sm"
              disabled={busy}
              leading={busy ? <Sparkles className="h-4 w-4 motion-safe:animate-pulse" strokeWidth={2.4} /> : <Check className="h-4 w-4" strokeWidth={2.5} />}
              onClick={() => onDecision('confirm')}
              className="text-white"
              style={{ backgroundColor: CORAL }}
            >
              {busy ? 'Working…' : 'Confirm'}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} leading={<X className="h-4 w-4" strokeWidth={2.5} />} onClick={() => onDecision('cancel')}>
              Cancel
            </Button>
            <span className="ml-auto text-[11px] text-muted">The agent proposes, you decide.</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── a chat bubble ─────────────────────────────────────────────────────────── */
function Bubble({ entry }: { entry: Extract<Entry, { kind: 'msg' }> }) {
  const isUser = entry.role === 'user';
  return (
    <div className={cn('flex w-full items-start gap-2.5', isUser ? 'flex-row-reverse' : 'flex-row')}>
      {isUser
        ? <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-fuchsia text-[11px] font-bold text-white">You</span>
        : <OfficerAvatar size="sm" />}
      <div
        className={cn(
          'max-w-[78%] whitespace-pre-wrap break-words rounded-token-lg px-3.5 py-2.5 text-[13px] leading-relaxed shadow-token',
          isUser
            ? 'rounded-tr-sm bg-accent text-accent-contrast'
            : 'rounded-tl-sm border border-subtle bg-surface-raised text-secondary',
        )}
      >
        {entry.text}
        {entry.inferenceOff && (
          <span className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-tertiary">
            <Lock className="h-3 w-3" strokeWidth={2.5} /> Inference isn’t connected yet.
          </span>
        )}
      </div>
    </div>
  );
}

/* ── the typing indicator ──────────────────────────────────────────────────── */
function Typing() {
  return (
    <div className="flex items-start gap-2.5">
      <OfficerAvatar size="sm" />
      <div className="flex items-center gap-1 rounded-token-lg rounded-tl-sm border border-subtle bg-surface-raised px-3.5 py-3 shadow-token">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-tertiary motion-safe:animate-bounce"
            style={{ animationDelay: `${i * 140}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

/* ── quick-action chip ─────────────────────────────────────────────────────── */
function Chip({ icon: Icon, label, onClick, disabled }: { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-subtle bg-surface-raised px-3 py-1.5 text-xs font-medium text-secondary',
        'transition-colors duration-fast ease-token hover:border-accent/40 hover:text-primary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        'disabled:pointer-events-none disabled:opacity-40',
      )}
    >
      <Icon className="h-3.5 w-3.5 text-tertiary" strokeWidth={2.4} />
      {label}
    </button>
  );
}

const SUGGESTIONS = [
  'Which relationships need attention this week?',
  'Summarize my pipeline and where it’s stalling.',
  'Who haven’t I followed up with recently?',
];

/* ── the page ──────────────────────────────────────────────────────────────── */
export default function AgentsPage() {
  const { workspaceId, loading: wsLoading, error: wsError } = useWorkspace();

  const [mode, setMode] = useState<RelationsOfficerMode>('advisor');
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Load the workspace's relationships once (for the grounding picker).
  useEffect(() => {
    if (!workspaceId) return;
    listCustomers(workspaceId).then(setCustomers).catch(() => { /* picker just stays empty */ });
  }, [workspaceId]);

  // Auto-scroll the transcript to the newest entry / typing state.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, sending, agentBusy]);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId) ?? null,
    [customers, customerId],
  );

  // The rolling transcript the backend sees (plain messages only).
  const wireMessages = useCallback(
    (): RelationsOfficerMessage[] =>
      entries
        .filter((e): e is Extract<Entry, { kind: 'msg' }> => e.kind === 'msg')
        .map((e) => ({ role: e.role, content: e.text })),
    [entries],
  );

  const append = useCallback((entry: Entry) => setEntries((prev) => [...prev, entry]), []);

  /* ── send a chat turn ────────────────────────────────────────────────────── */
  const send = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      if (!text || !workspaceId || sending) return;
      setError(null);
      setInput('');

      const history = wireMessages();
      append({ id: nextId(), kind: 'msg', role: 'user', text });
      setSending(true);
      try {
        const res = await chatRelationsOfficer(workspaceId, {
          messages: [...history, { role: 'user', content: text }],
          mode,
          customerId,
        });
        append({ id: nextId(), kind: 'msg', role: 'assistant', text: res.reply, inferenceOff: !res.inferenceConfigured });
        if (res.proposedAction) {
          append({ id: nextId(), kind: 'confirm', action: res.proposedAction, decision: 'pending' });
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSending(false);
        requestAnimationFrame(() => composerRef.current?.focus());
      }
    },
    [input, workspaceId, sending, wireMessages, append, mode, customerId],
  );

  /* ── resolve a Confirm / Cancel decision ──────────────────────────────────── */
  const decide = useCallback(
    async (entryId: string, action: RelationsOfficerProposedAction, decision: 'confirm' | 'cancel') => {
      if (!workspaceId || confirmBusy) return;
      setConfirmBusy(entryId);
      setError(null);
      try {
        const res = await confirmRelationsOfficerAction(workspaceId, { actionId: action.id, decision });
        setEntries((prev) =>
          prev.map((e) => (e.id === entryId && e.kind === 'confirm' ? { ...e, decision, note: res.message } : e)),
        );
        append({ id: nextId(), kind: 'msg', role: 'assistant', text: res.message });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setConfirmBusy(null);
      }
    },
    [workspaceId, confirmBusy, append],
  );

  /* ── run a structured sub-agent (existing lib/customers functions) ────────── */
  const runAgent = useCallback(
    async (which: 'triage' | 'follow-up' | 'nudge') => {
      if (!workspaceId || !customerId || agentBusy) return;
      setAgentBusy(true);
      setError(null);
      try {
        if (which === 'triage') append({ id: nextId(), kind: 'triage', result: await runTriage(workspaceId, customerId) });
        if (which === 'follow-up') append({ id: nextId(), kind: 'follow-up', result: await draftFollowUp(workspaceId, customerId) });
        if (which === 'nudge') append({ id: nextId(), kind: 'nudge', result: await draftCollectionsNudge(workspaceId, customerId) });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setAgentBusy(false);
      }
    },
    [workspaceId, customerId, agentBusy, append],
  );

  const busy = sending || agentBusy;
  const ctxName = selectedCustomer ? contactLabel(selectedCustomer) : null;
  const empty = entries.length === 0;

  return (
    <div className="mx-auto flex h-[calc(100vh-8.5rem)] max-w-[920px] animate-fade-up flex-col">
      {/* ── Identity header ── */}
      <header className="co-glass co-glass-edge flex flex-col gap-3 rounded-token-lg p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <OfficerAvatar size="lg" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-primary">Relations Officer</h1>
            <p className="text-[13px] text-tertiary">Every relationship, connected.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Mode toggle — segmented control */}
          <div role="tablist" aria-label="Mode" className="inline-flex rounded-token border border-subtle bg-surface-base/60 p-0.5">
            {(['advisor', 'operator'] as const).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  'rounded-[calc(var(--co-radius)-2px)] px-3 py-1.5 text-xs font-semibold capitalize transition-colors duration-fast ease-token',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                  mode === m ? 'bg-surface-elevated text-primary shadow-token' : 'text-tertiary hover:text-secondary',
                )}
              >
                {m}
              </button>
            ))}
          </div>

          {/* Customer grounding picker */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setPickerOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              className={cn(
                'inline-flex max-w-[220px] items-center gap-1.5 rounded-token border border-subtle bg-surface-raised px-3 py-1.5 text-xs font-medium',
                'transition-colors duration-fast ease-token hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                ctxName ? 'text-primary' : 'text-tertiary',
              )}
            >
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: ctxName ? CORAL : 'rgb(var(--co-text-muted))' }} />
              <span className="truncate">{ctxName ?? 'No customer'}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" strokeWidth={2.5} />
            </button>
            {pickerOpen && (
              <>
                <div className="fixed inset-0 z-30" aria-hidden onClick={() => setPickerOpen(false)} />
                <ul
                  role="listbox"
                  className="absolute right-0 z-40 mt-1.5 max-h-72 w-64 overflow-y-auto rounded-token-lg border border-subtle bg-surface-elevated p-1 shadow-token-lg"
                >
                  <li>
                    <button
                      type="button"
                      role="option"
                      aria-selected={customerId === null}
                      onClick={() => { setCustomerId(null); setPickerOpen(false); }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-token px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-surface-overlay',
                        customerId === null ? 'text-primary' : 'text-tertiary',
                      )}
                    >
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-muted" />
                      No customer <span className="text-muted">· workspace-level</span>
                    </button>
                  </li>
                  {customers.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={customerId === c.id}
                        onClick={() => { setCustomerId(c.id); setPickerOpen(false); }}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-token px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-surface-overlay',
                          customerId === c.id ? 'bg-surface-overlay text-primary' : 'text-secondary',
                        )}
                      >
                        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: CORAL }} />
                        <span className="truncate">{contactLabel(c)}</span>
                      </button>
                    </li>
                  ))}
                  {customers.length === 0 && <li className="px-2.5 py-2 text-xs text-muted">No relationships yet.</li>}
                </ul>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Operator note */}
      {mode === 'operator' && (
        <p className="mt-2 flex items-center gap-1.5 rounded-token border border-subtle bg-surface-raised px-3 py-2 text-xs text-tertiary" style={{ borderColor: `${CORAL}40` }}>
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={2.4} style={{ color: CORAL }} />
          Can act on your behalf — every action waits for your confirm.
        </p>
      )}

      {/* ── Transcript ── */}
      <div ref={scrollRef} className="mt-3 flex-1 space-y-4 overflow-y-auto rounded-token-lg border border-subtle bg-surface-base/40 p-4">
        {empty ? (
          <div className="grid h-full place-items-center">
            <div className="max-w-md text-center">
              <div className="mb-3 inline-grid"><OfficerAvatar size="lg" /></div>
              <h2 className="text-base font-semibold text-primary">Hello — I’m your Relations Officer.</h2>
              <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-tertiary">
                Ask me about any relationship or your whole pipeline. I’ll advise first — and only act when you confirm.
              </p>
              <div className="mt-4 flex flex-col items-stretch gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
                    disabled={!workspaceId}
                    className={cn(
                      'rounded-token border border-subtle bg-surface-raised px-3.5 py-2.5 text-left text-[13px] text-secondary',
                      'transition-colors duration-fast ease-token hover:border-accent/40 hover:text-primary',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40',
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            {entries.map((e) => {
              switch (e.kind) {
                case 'msg':
                  return <Bubble key={e.id} entry={e} />;
                case 'confirm':
                  return (
                    <ConfirmCard
                      key={e.id}
                      entry={e}
                      busy={confirmBusy === e.id}
                      onDecision={(d) => void decide(e.id, e.action, d)}
                    />
                  );
                case 'triage':
                  return <TriageCard key={e.id} result={e.result} />;
                case 'follow-up':
                  return <FollowUpCard key={e.id} result={e.result} />;
                case 'nudge':
                  return <NudgeCard key={e.id} result={e.result} />;
                default:
                  return null;
              }
            })}
            {busy && <Typing />}
          </>
        )}
      </div>

      {/* ── Error ── */}
      {error && (
        <p role="alert" className="mt-2 flex items-start gap-2 rounded-token border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}

      {/* ── Sub-agent quick-actions (only with a customer in context) ── */}
      {selectedCustomer && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted">On {ctxName}:</span>
          <Chip icon={Gauge} label="Triage" onClick={() => void runAgent('triage')} disabled={busy} />
          <Chip icon={Compass} label="Next best action" onClick={() => void send(`What's the next best action for ${ctxName}?`)} disabled={busy} />
          <Chip icon={CalendarClock} label="Meeting prep" onClick={() => void send(`Help me prep for my next meeting with ${ctxName}.`)} disabled={busy} />
          <Chip icon={PenLine} label="Follow-up" onClick={() => void runAgent('follow-up')} disabled={busy} />
          <Chip icon={BellRing} label="Collections" onClick={() => void runAgent('nudge')} disabled={busy} />
        </div>
      )}

      {/* ── Composer ── */}
      <div className="mt-3 flex items-end gap-2 rounded-token-lg border border-subtle bg-surface-raised p-2 shadow-token focus-within:border-accent/50">
        <textarea
          ref={composerRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={ctxName ? `Ask about ${ctxName}…` : 'Ask the Relations Officer…'}
          disabled={!workspaceId || wsLoading}
          className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[13px] leading-relaxed text-primary placeholder:text-muted focus:outline-none disabled:opacity-50"
        />
        <Button
          size="md"
          disabled={!input.trim() || sending || !workspaceId}
          leading={sending ? <Sparkles className="h-4 w-4 motion-safe:animate-pulse" strokeWidth={2.4} /> : <Send className="h-4 w-4" strokeWidth={2.4} />}
          onClick={() => void send()}
          glow
        >
          Send
        </Button>
      </div>
      <p className="mt-1.5 px-1 text-[11px] text-muted">
        Enter to send · Shift+Enter for a new line. {mode === 'advisor' ? 'Advisor mode — I won’t act without switching to Operator.' : 'Operator mode — actions wait for your confirm.'}
      </p>

      {/* Workspace-resolution error (degrade clean — the composer is disabled above) */}
      {wsError && empty && (
        <p className="mt-2 text-center text-xs text-tertiary">{wsError}</p>
      )}
    </div>
  );
}

'use client';

import { useState, type ReactNode } from 'react';
import {
  Bot, Gauge, PenLine, BellRing, Sparkles, ShieldCheck, Copy, Check, AlertTriangle, Lock, ArrowRight,
  type LucideIcon,
} from 'lucide-react';
import { Badge, Button, cn } from '@/components/ui';
import {
  draftCollectionsNudge,
  draftFollowUp,
  money,
  runTriage,
  type CollectionsNudgeResult,
  type FollowUpResult,
  type TriageResult,
} from '@/lib/customers';
import { PanelSection } from './shared';
import { FormError } from './forms';

type Which = 'triage' | 'follow-up' | 'nudge';

/* ── inference provenance tag (per result) ────────────────────────────────── */
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

/* ── a copyable read-only draft body ──────────────────────────────────────── */
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

/** A result card shell: a colored left rail, a title row with the provenance tag. */
function ResultCard({
  icon,
  rail,
  title,
  meta,
  children,
}: {
  icon: LucideIcon;
  rail: string;
  title: string;
  meta: ReactNode;
  children: ReactNode;
}) {
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

/* ── the panel ────────────────────────────────────────────────────────────── */
/**
 * Relationship agents (Phase 5). Three run-buttons — lead-triage, follow-up
 * drafter, collections nudge. Each shows the agent's structured output INLINE for
 * HUMAN APPROVAL: the agents are DRAFT-ONLY + human-in-the-loop and never send,
 * post, or move a stage. When inference is unconfigured / not entitled the result
 * reports it (and still shows the assembled context), so the affordance degrades
 * clean.
 */
export function AgentsPanel(props: {
  workspaceId: string | null;
  customerId: string;
  onChanged: () => void | Promise<void>;
}) {
  const { workspaceId, customerId } = props;
  const [busy, setBusy] = useState<Which | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [followUp, setFollowUp] = useState<FollowUpResult | null>(null);
  const [nudge, setNudge] = useState<CollectionsNudgeResult | null>(null);

  const run = async (which: Which, fn: () => Promise<unknown>) => {
    if (!workspaceId) return;
    setBusy(which);
    setErr(null);
    try {
      const result = await fn();
      if (which === 'triage') setTriage(result as TriageResult);
      if (which === 'follow-up') setFollowUp(result as FollowUpResult);
      if (which === 'nudge') setNudge(result as CollectionsNudgeResult);
      await props.onChanged(); // the agent logged an AGENT_RUN — refresh the timeline
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const RunButton = ({ which, icon, label, fn }: { which: Which; icon: LucideIcon; label: string; fn: () => Promise<unknown> }) => {
    const Icon = icon;
    const isBusy = busy === which;
    return (
      <Button
        size="sm"
        variant="secondary"
        disabled={busy !== null || !workspaceId}
        leading={
          isBusy ? (
            <Sparkles className="h-4 w-4 motion-safe:animate-pulse" strokeWidth={2.4} />
          ) : (
            <Icon className="h-4 w-4" strokeWidth={2.4} />
          )
        }
        onClick={() => void run(which, fn)}
      >
        {isBusy ? 'Running…' : label}
      </Button>
    );
  };

  const triagePriorityVariant = (p: string | null) =>
    p === 'high' ? 'danger' : p === 'medium' ? 'warning' : 'neutral';

  return (
    <PanelSection
      icon={Bot}
      gradient="from-violet-500 to-cyan-500"
      title="Relationship agents"
      subtitle="Compose federated signal + inference"
      tag={
        <Badge variant="neutral">
          <ShieldCheck className="h-3 w-3" strokeWidth={2.5} />
          draft-only · you approve
        </Badge>
      }
    >
      <p className="mb-3 text-xs leading-relaxed text-tertiary">
        Agents read the federated signal and the 4-lane inference, then return a draft or an assessment for you to review.
        They never send, post, or move a stage on their own.
      </p>

      <FormError error={err} />

      <div className="flex flex-wrap gap-2">
        <RunButton which="triage" icon={Gauge} label="Triage lead" fn={() => runTriage(workspaceId!, customerId)} />
        <RunButton which="follow-up" icon={PenLine} label="Draft follow-up" fn={() => draftFollowUp(workspaceId!, customerId)} />
        <RunButton which="nudge" icon={BellRing} label="Draft payment nudge" fn={() => draftCollectionsNudge(workspaceId!, customerId)} />
      </div>

      {(triage || followUp || nudge) && (
        <div className="mt-4 space-y-3">
          {/* ── Lead triage — a ranked assessment (never applied) ── */}
          {triage && (
            <ResultCard icon={Gauge} rail="border-feat-agents" title="Lead triage" meta={<AgentMeta result={triage} />}>
              {triage.score !== null ? (
                <>
                  <div className="mb-2 flex items-center gap-3">
                    <div className="flex items-baseline gap-1">
                      <span className="font-mono text-2xl font-semibold tabular-nums text-primary">{triage.score}</span>
                      <span className="text-xs text-muted">/ 100</span>
                    </div>
                    {triage.recommendedPriority && (
                      <Badge variant={triagePriorityVariant(triage.recommendedPriority)}>
                        recommend {triage.recommendedPriority}
                      </Badge>
                    )}
                  </div>
                  {/* score meter */}
                  <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-surface-base">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-feat-agents to-fuchsia"
                      style={{ width: `${Math.max(2, Math.min(100, triage.score))}%`, transition: 'width var(--co-dur) var(--co-ease)' }}
                    />
                  </div>
                  {triage.rationale && <p className="text-xs leading-relaxed text-secondary">{triage.rationale}</p>}
                  {triage.suggestedNextAction && (
                    <p className="mt-2 flex items-start gap-1.5 text-[13px] text-primary">
                      <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-feat-agents" strokeWidth={2.5} />
                      <span>{triage.suggestedNextAction}</span>
                    </p>
                  )}
                </>
              ) : (
                <NoteFallback note={triage.note} />
              )}
            </ResultCard>
          )}

          {/* ── Follow-up draft — NOT sent ── */}
          {followUp && (
            <ResultCard icon={PenLine} rail="border-feat-email" title="Follow-up draft" meta={<AgentMeta result={followUp} />}>
              {followUp.subject ? (
                <>
                  <p className="text-[13px] text-primary">
                    <span className="text-tertiary">Subject:</span> {followUp.subject}
                  </p>
                  {followUp.toAddress && <p className="mb-2 mt-0.5 text-[11px] text-muted">To {followUp.toAddress}</p>}
                  <div className={followUp.toAddress ? '' : 'mt-2'}>
                    <DraftBody value={followUp.body ?? ''} />
                  </div>
                  {followUp.stagedDraft ? (
                    <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-warning-subtle px-2.5 py-1 text-[11px] font-medium text-warning">
                      <AlertTriangle className="h-3 w-3" strokeWidth={2.5} />
                      Staged as an Email-Ops draft — awaiting your approval, not sent
                    </p>
                  ) : (
                    <p className="mt-2 text-[11px] text-muted">
                      A draft. Copy it, or use the Email panel’s “Save as draft” to stage it for approval — never auto-sent.
                    </p>
                  )}
                </>
              ) : (
                <NoteFallback note={followUp.note} />
              )}
            </ResultCard>
          )}

          {/* ── Collections nudge — draft only ── */}
          {nudge && (
            <ResultCard icon={BellRing} rail="border-feat-invoices" title="Payment nudge draft" meta={<AgentMeta result={nudge} />}>
              {nudge.overdueInvoices.length > 0 && (
                <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-danger-subtle px-2.5 py-1 text-[11px] font-medium text-danger">
                  {nudge.overdueInvoices.length} overdue ·{' '}
                  {money(nudge.totalOverdue, nudge.overdueInvoices[0]?.currency ?? 'USD')} due
                </div>
              )}
              {nudge.subject ? (
                <>
                  <p className="text-[13px] text-primary">
                    <span className="text-tertiary">Subject:</span> {nudge.subject}
                  </p>
                  <div className="mt-2">
                    <DraftBody value={nudge.body ?? ''} />
                  </div>
                  <p className="mt-2 text-[11px] text-muted">
                    Draft only — review, then send it yourself. The agent never charges or sends.
                  </p>
                </>
              ) : (
                <NoteFallback note={nudge.note} />
              )}
            </ResultCard>
          )}
        </div>
      )}
    </PanelSection>
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

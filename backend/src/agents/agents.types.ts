/**
 * Shared shapes for the Customer-Ops relationship AGENTS (Phase 5).
 *
 * THE INVARIANT (binding, brief + README "agents draft-only (human-in-the-loop,
 * never auto-act)"): every agent here is DRAFT-ONLY. It assembles federated
 * context, calls the 4-lane inference seam (AgentInferencePort), returns a
 * STRUCTURED result for human approval, and logs ONE CustomerActivity(AGENT_RUN).
 * It NEVER auto-sends mail, posts an invoice, enrolls a campaign, or moves a
 * stage. The follow-up agent can OPTIONALLY hand its draft to
 * EmailOpsPort.composeEmail with mode='draft' (the agent-inbox approval surface) —
 * which is still NOT a send: a human approves before anything leaves.
 *
 * Every agent result carries the same envelope fields so the cockpit can render a
 * uniform "agent output for approval" affordance + the degrade-clean / entitlement
 * states (mirroring the federation panels' `configured`/`entitled` affordances):
 *   - `inferenceConfigured` — was the inference gateway reachable (degrade-clean)?
 *   - `entitled` / `tierUsed` — the 4-lane entitlement decision + the tier actually
 *     used (bundled vs metered);
 *   - `inference` — the lane/model/token echo for audit + metering provenance;
 *   - `draftOnly: true` — a literal, always-true marker asserting no side effect
 *     was taken (the human-in-the-loop guarantee, surfaced for the UI + tests).
 */

import { InferenceTier } from './inference/agent-inference.types';

/** The inference provenance echoed on every agent result (audit + metering). */
export interface AgentInferenceEcho {
  /** Which lane the gateway used (1-4), if it reported one. */
  lane: number | null;
  /** The model the gateway routed to (opaque; never chosen by Customer-Ops). */
  model: string | null;
  /** Whether the call hit a billable (metered) lane. */
  metered: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
}

/** Fields common to every agent result — the uniform approval/affordance envelope. */
export interface AgentResultBase {
  /** The customer-relationship the agent ran against. */
  customerId: string;
  /** The federated contact the relationship is keyed on (thin reference). */
  contactId: string;
  /** Which agent produced this. */
  agent:
    | 'lead-triage'
    | 'follow-up-draft'
    | 'collections-nudge'
    | 'next-best-action'
    | 'meeting-prep';
  /** Was the inference gateway configured/reachable? When false the agent
   *  degraded clean: it assembled context but produced no model output. */
  inferenceConfigured: boolean;
  /** Did the caller pass the 4-lane entitlement gate for the requested tier? */
  entitled: boolean;
  /** The tier actually used (a metered ask without ai-metered downgrades). */
  tierUsed: InferenceTier | null;
  /** Inference provenance (null when the gateway wasn't called). */
  inference: AgentInferenceEcho | null;
  /** ALWAYS true: a literal assertion that the agent took NO side effect
   *  (no send, no invoice, no stage move) — the human-in-the-loop guarantee. */
  draftOnly: true;
  /** A short human note about what happened (e.g. "scored 82/100", "draft ready",
   *  "inference not configured — context only"). Surfaced in the cockpit. */
  note: string;
}

/** The lead-triage agent's structured assessment (no side effects). */
export interface LeadTriageResult extends AgentResultBase {
  agent: 'lead-triage';
  /** 0-100 priority score the agent assigned (null when inference didn't run). */
  score: number | null;
  /** low|medium|high — the recommended priority bucket (maps to the cockpit's
   *  RelationshipPriority, but the agent only RECOMMENDS; it never sets it). */
  recommendedPriority: 'low' | 'medium' | 'high' | null;
  /** The agent's rationale (prose). */
  rationale: string | null;
  /** The next best action the agent suggests (prose; a human decides). */
  suggestedNextAction: string | null;
  /** The composed signal the agent reasoned over (echoed for transparency). */
  signals: LeadTriageSignals;
}

/** The compact, federated signal snapshot the triage agent reasoned over. */
export interface LeadTriageSignals {
  stage: string;
  priority: string;
  isLost: boolean;
  daysSinceLastStageChange: number | null;
  expectedValue: string | null;
  /** From Contact-Ops (federated; null when dormant). */
  contactDisplayName: string | null;
  communicationStrength: number | null;
  lastInteractionAt: string | null;
  /** From Meeting-Ops (federated signal; zeros when dormant). */
  meetingCount: number;
  lastMeetingAt: string | null;
  openActionItemCount: number;
  latestSummaryHeadline: string | null;
  /** From Outreach (federated; null/zero when dormant). */
  lastEngagementKind: string | null;
  outreachTouchCount: number;
}

/** The follow-up drafter's structured draft (a draft, never a send). */
export interface FollowUpDraftResult extends AgentResultBase {
  agent: 'follow-up-draft';
  /** The drafted subject line (null when inference didn't run). */
  subject: string | null;
  /** The drafted body (plain text; null when inference didn't run). */
  body: string | null;
  /** The recipient the draft is FOR (the federated contact's primary email),
   *  resolved read-time from Contact-Ops; null when unavailable. The agent does
   *  NOT store it. */
  toAddress: string | null;
  /** When the caller asked to stage it into the Email-Ops agent inbox, this is
   *  the resulting draft message id + status (mode='draft' — still NOT sent).
   *  null when not staged (the default: return the draft to the caller only). */
  stagedDraft: { messageId: string; threadId: string | null; status: string } | null;
}

/** The collections-nudge agent's structured draft (a draft, never a send). */
export interface CollectionsNudgeResult extends AgentResultBase {
  agent: 'collections-nudge';
  /** The drafted subject line (null when inference didn't run). */
  subject: string | null;
  /** The drafted polite payment-reminder body (null when inference didn't run). */
  body: string | null;
  /** The recipient the draft is FOR (federated contact primary email); null when
   *  unavailable. */
  toAddress: string | null;
  /** The overdue invoices the nudge is about (federated from Accounting-Ops, live
   *  status). Echoed so a human can verify before approving. */
  overdueInvoices: OverdueInvoiceView[];
  /** The summed overdue balance (decimal string), for the cockpit headline. */
  totalOverdue: string | null;
  /** Whether Accounting-Ops was reachable to read invoices (degrade-clean). */
  accountingConfigured: boolean;
}

/** One overdue invoice the collections agent reasoned over (read-only projection). */
export interface OverdueInvoiceView {
  externalRef: string;
  invoiceNumber: string | null;
  status: string | null;
  balanceDue: string | null;
  currency: string;
  dueDate: string | null;
}

/** The next-best-action agent's structured recommendation (no side effects). */
export interface NextBestActionResult extends AgentResultBase {
  agent: 'next-best-action';
  /** The single concrete next step the agent recommends (prose; a human decides). */
  nextAction: string | null;
  /** The agent's rationale (2-3 sentences). */
  rationale: string | null;
  /** low|medium|high — how urgent the agent thinks the action is. */
  priority: 'low' | 'medium' | 'high' | null;
  /** 0-1 — the agent's confidence in the recommendation (null when not parsed). */
  confidence: number | null;
  /** The composed signal the agent reasoned over (echoed for transparency). */
  signals: NextBestActionSignals;
}

/** The compact, federated signal snapshot the next-best-action agent reasoned over. */
export interface NextBestActionSignals {
  stage: string;
  priority: string;
  isLost: boolean;
  daysSinceLastStageChange: number | null;
  expectedValue: string | null;
  nextActionAt: string | null;
  /** From Contact-Ops (federated; null when dormant). */
  contactDisplayName: string | null;
  communicationStrength: number | null;
  lastInteractionAt: string | null;
  /** From Meeting-Ops (federated signal; zeros when dormant). */
  meetingCount: number;
  lastMeetingAt: string | null;
  openActionItemCount: number;
  latestSummaryHeadline: string | null;
  /** From Outreach (federated; null/zero when dormant). */
  lastEngagementKind: string | null;
  outreachTouchCount: number;
}

/** The meeting-prep agent's structured prep brief (no side effects). */
export interface MeetingPrepResult extends AgentResultBase {
  agent: 'meeting-prep';
  /** Bullet talking points to raise (empty when inference didn't run). */
  talkingPoints: string[];
  /** Open items / loose threads to close (empty when inference didn't run). */
  openItems: string[];
  /** A suggested agenda (ordered; empty when inference didn't run). */
  suggestedAgenda: string[];
  /** A 2-3 sentence prep summary (null when inference didn't run). */
  summary: string | null;
  /** The composed signal the agent reasoned over (echoed for transparency). */
  signals: MeetingPrepSignals;
}

/** The compact, federated signal snapshot the meeting-prep agent reasoned over. */
export interface MeetingPrepSignals {
  stage: string;
  contactDisplayName: string | null;
  relationshipNotes: string | null;
  /** From Meeting-Ops (federated signal; zeros/nulls when dormant). */
  meetingCount: number;
  lastMeetingAt: string | null;
  lastMeetingTitle: string | null;
  openActionItemCount: number;
  latestSummaryHeadline: string | null;
  /** A few open action-item texts (Meeting-Ops; capped). */
  openActionItems: string[];
  /** From Accounting-Ops (federated; live-status invoice context). */
  openInvoiceCount: number;
  totalOpenBalance: string | null;
  /** From Outreach (federated; the last touch's subject/engagement). */
  lastOutreachSubject: string | null;
  lastEngagementKind: string | null;
}

/**
 * The funnel rules — the lifecycle Customer-Ops OWNS (README "The funnel").
 *
 * Stages: LEAD → PROSPECT → CUSTOMER (the three load-bearing stages; richer
 * sub-stages are deferred). "Lost" is an ORTHOGONAL flag (isLost), not a fourth
 * stage, so a lost lead and a lost prospect both stay queryable by their last
 * stage. This module is pure, deterministic, side-effect-free logic — it is the
 * single source of truth for "what stage moves are legal and what they mean,"
 * and it is unit-tested directly.
 *
 * Transition policy (binding):
 *   - FORWARD by exactly one step is always allowed: LEAD→PROSPECT→CUSTOMER.
 *     This is the qualify→convert happy path.
 *   - BACKWARD by one or more steps is allowed (a demotion / re-qualification:
 *     a CUSTOMER who churns to PROSPECT, a PROSPECT that cools to LEAD). The
 *     cockpit records it; it is a legitimate relationship event.
 *   - SKIPPING FORWARD (LEAD→CUSTOMER) is REJECTED: you cannot convert a raw
 *     lead without it passing through PROSPECT (qualification is mandatory).
 *     This is the one guardrail the funnel enforces.
 *   - A no-op (same stage) is rejected as a transition (callers patch other
 *     fields without calling the transition path).
 *   - Re-opening a LOST relationship: clearing `isLost` is allowed at any stage;
 *     marking `isLost` is allowed at any stage. Lost-marking and stage-moving
 *     are separate operations.
 */

import { RelationshipStage } from '@prisma/client';

/** Funnel order. Index == rank; forward means a higher rank. */
export const STAGE_ORDER: RelationshipStage[] = [
  RelationshipStage.LEAD,
  RelationshipStage.PROSPECT,
  RelationshipStage.CUSTOMER,
];

export function stageRank(stage: RelationshipStage): number {
  return STAGE_ORDER.indexOf(stage);
}

export interface TransitionCheck {
  allowed: boolean;
  reason: string;
  direction: 'forward' | 'backward' | 'none';
}

/**
 * Decide whether `from → to` is a legal stage transition under the funnel rules.
 * Pure; no DB, no side effects. The service layer calls this before any write.
 */
export function checkTransition(from: RelationshipStage, to: RelationshipStage): TransitionCheck {
  const fromRank = stageRank(from);
  const toRank = stageRank(to);

  if (fromRank === toRank) {
    return { allowed: false, reason: `already at stage ${to}`, direction: 'none' };
  }

  const delta = toRank - fromRank;
  if (delta > 0) {
    // Forward: only one step at a time (no skipping qualification).
    if (delta === 1) {
      return { allowed: true, reason: `advance ${from}→${to}`, direction: 'forward' };
    }
    return {
      allowed: false,
      reason: `cannot skip the funnel: ${from}→${to} must pass through ${STAGE_ORDER[fromRank + 1]}`,
      direction: 'forward',
    };
  }

  // Backward by any number of steps is allowed (demotion / re-qualification).
  return { allowed: true, reason: `move back ${from}→${to}`, direction: 'backward' };
}

/** The stage that follows `stage` in the funnel, or null at the end. */
export function nextStage(stage: RelationshipStage): RelationshipStage | null {
  const r = stageRank(stage);
  return r >= 0 && r < STAGE_ORDER.length - 1 ? STAGE_ORDER[r + 1] : null;
}

// ============================================================
// Phase 4: the engagement → funnel-stage policy (pure).
//
// An inbound engagement signal from Outreach/Email-Ops (a reply/click/open, or a
// bounce) can ADVANCE the funnel. This is the single source of truth for "which
// engagement advances which stage," kept here next to the manual-transition
// rules so both paths share one funnel definition, and it is unit-tested
// directly. Binding policy:
//   - POSITIVE intent ('replied', 'clicked') advances exactly ONE step
//     (LEAD→PROSPECT, PROSPECT→CUSTOMER) — the same one-step guardrail as a
//     manual transition. A reply/click is a real qualification signal.
//   - 'opened' is a WEAK signal: recorded, but does NOT advance by default
//     (an open is not intent; advancing on it would inflate the pipeline).
//   - 'bounced' / 'unsubscribed' NEVER advance — they are data-quality /
//     suppression signals (recorded as provenance only).
//   - A LOST relationship never advances on engagement (re-open it first).
//   - A relationship already at the top of the funnel (CUSTOMER) never advances.
// ============================================================

/** The normalized engagement signal the hook reacts to (== OutreachEngagementKind). */
export type EngagementSignal = 'opened' | 'clicked' | 'replied' | 'bounced' | 'unsubscribed';

export interface EngagementDecision {
  advance: boolean;
  /** The stage to move to when advancing; null when not advancing. */
  toStage: RelationshipStage | null;
  reason: string;
}

/** The engagement signals that count as positive intent (advance the funnel). */
const POSITIVE_SIGNALS: ReadonlySet<EngagementSignal> = new Set(['replied', 'clicked']);

/**
 * Decide whether an engagement signal advances the funnel from `from`. Pure; no
 * DB, no side effects. The service calls this inside the RLS tx before writing.
 */
export function engagementAdvance(
  from: RelationshipStage,
  signal: EngagementSignal,
  isLost: boolean,
): EngagementDecision {
  if (isLost) {
    return {
      advance: false,
      toStage: null,
      reason: 'relationship is closed-lost; re-open before it can advance',
    };
  }
  if (!POSITIVE_SIGNALS.has(signal)) {
    const why =
      signal === 'opened'
        ? "an 'opened' signal is recorded but does not advance the funnel (weak intent)"
        : `a '${signal}' signal is a data-quality/suppression event and never advances the funnel`;
    return { advance: false, toStage: null, reason: why };
  }
  const to = nextStage(from);
  if (!to) {
    return { advance: false, toStage: null, reason: `already at the top of the funnel (${from})` };
  }
  return {
    advance: true,
    toStage: to,
    reason: `positive '${signal}' engagement advances ${from}→${to}`,
  };
}

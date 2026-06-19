/**
 * The SELECTABLE inference-lane resolver for the relationship agents (Phase 5+).
 *
 * Each agent runs on the 4-lane inference seam at a `tier` hint — 'bundled' (lanes
 * 1-2, in seat price; the default) or 'metered' (lanes 3-4, frontier, requires
 * `ai-metered`). Historically every agent HARD-CODED tier:'bundled'. To A/B the
 * Qwen (bundled) vs Claude (metered) lanes — and to set the production choice —
 * WITHOUT a redeploy, the tier is now resolved per call with this precedence:
 *
 *    1. a per-REQUEST override  (the POST body `tier` and/or `?tier=` query),
 *    2. a per-AGENT env default (AGENT_<NAME>_TIER, e.g. AGENT_LEAD_TRIAGE_TIER),
 *    3. the literal fallback    'bundled'.
 *
 * Anything that is not exactly 'bundled' | 'metered' is IGNORED (it falls through
 * to the next source) so a typo'd override/env never picks an invalid lane. The
 * resolved tier is the agent's TIER HINT only — the entitlement gate is untouched:
 * the client still DOWNGRADES a metered ask to bundled when the bearer lacks
 * `ai-metered`, and `UC_ENTITLEMENT_MODE=open` still bypasses the SKU check. So
 * selecting 'metered' asks for the frontier lane; the gate decides if it's allowed.
 *
 * The env var name per agent is derived from the agent task by upper-snake-casing
 * it (lead-triage → AGENT_LEAD_TRIAGE_TIER, follow-up-draft → AGENT_FOLLOW_UP_DRAFT
 * _TIER, collections-nudge → AGENT_COLLECTIONS_NUDGE_TIER, next-best-action →
 * AGENT_NEXT_BEST_ACTION_TIER, meeting-prep → AGENT_MEETING_PREP_TIER).
 */

import { ConfigService } from '@nestjs/config';
import { InferenceTier } from './inference/agent-inference.types';

/** The agent task keys the tier resolver knows (== AgentInferenceRequest['task']
 *  plus the two relationship agents added in this phase). */
export type AgentTaskKey =
  | 'lead-triage'
  | 'follow-up-draft'
  | 'collections-nudge'
  | 'next-best-action'
  | 'meeting-prep';

/** Coerce an arbitrary value to a valid InferenceTier, or null when it is neither
 *  'bundled' nor 'metered' (case/space-insensitive). Used to validate BOTH the
 *  request override and the env default before either is accepted. */
export function coerceTier(value: unknown): InferenceTier | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return v === 'bundled' || v === 'metered' ? (v as InferenceTier) : null;
}

/** The per-agent env var that sets that agent's default tier. */
export function tierEnvVar(task: AgentTaskKey): string {
  return `AGENT_${task.replace(/-/g, '_').toUpperCase()}_TIER`;
}

/**
 * Resolve the effective tier hint for an agent call: request override > per-agent
 * env default > 'bundled'. Each candidate is validated; an invalid candidate is
 * ignored and the next source is tried. NEVER throws — always returns a valid tier.
 */
export function resolveTier(
  config: ConfigService,
  task: AgentTaskKey,
  requestOverride?: unknown,
): InferenceTier {
  const fromRequest = coerceTier(requestOverride);
  if (fromRequest) return fromRequest;
  const fromEnv = coerceTier(config.get<string>(tierEnvVar(task)));
  if (fromEnv) return fromEnv;
  return 'bundled';
}

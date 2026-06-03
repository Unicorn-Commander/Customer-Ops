/**
 * The Agent-Inference PORT (the 4-lane inference seam).
 *
 * An abstract class used as a DI token + interface. The relationship AGENTS
 * (lead-triage, follow-up drafter, collections nudge) depend ONLY on this port,
 * never on the concrete client. This is the same federate-don't-fork seam as the
 * other ports, and gives the brief's required properties:
 *
 *   1. Inference is built against the control-plane gateway contract (ops-center
 *      `uchub-litellm` routing/metering, reached via Brigade's agent runtime) but
 *      MOCKED in tests — the gateway is not running during verification, so the
 *      agent tests provide a fake AgentInferencePort and assert each agent
 *      composes the right context, returns structured output, logs activity, and
 *      never auto-sends.
 *   2. The transport (an OpenAI-compatible `/v1/chat/completions` over the
 *      gateway today; a Brigade-brokered MCP/agent transport later) is swappable
 *      without touching agent logic.
 *   3. Customer-Ops never runs a model, never routes, never meters — the gateway
 *      owns the lane → model mapping + the meter. The agents only assemble a
 *      prompt + state a tier hint.
 *
 * ENTITLEMENT / METERING (binding, brief): the inference lane is entitlement/
 * metering-gated per the 4-lane model. `checkEntitlement` is the pure gate:
 *   - the `customer-ops` SKU is required to run any agent (lanes 1-2 bundled),
 *   - a 'metered' request (lanes 3-4) additionally requires `ai-metered`.
 * The agents call it to gate AND to render the affordance; `complete` re-checks
 * as defense-in-depth. `UC_ENTITLEMENT_MODE=open` is the pre-Lago bootstrap.
 *
 * DEGRADE-CLEAN (binding): when the inference gateway is not configured
 * (AGENT_INFERENCE_BASE_URL unset), `isConfigured()` is false; an agent then
 * returns a structured result flagged `inferenceConfigured:false` ("connect
 * inference") and makes NO call. Every method is also individually safe to call
 * when unconfigured (returns null / a not-configured decision), so a missing
 * config can never throw — an agent always returns a clean, draft-only result.
 */

import {
  AgentInferenceRequest,
  AgentInferenceResult,
  InferenceEntitlementDecision,
  InferenceTier,
} from './agent-inference.types';

/** The per-call inference identity: which workspace, who is acting, what they are
 *  entitled to. `entitlements` is the verified token SKU list (raw); the client
 *  normalizes it. Mirrors the AO/Outreach/Email federation context. */
export interface InferenceContext {
  /** Resolved canonical workspace id (uc-registry uuidv7); the metering dimension. */
  workspaceId: string;
  /** Acting user's uchub sub (attribution; the metering actor). */
  ucUid: string | null;
  /** Verified entitlement SKUs off the bearer token. */
  entitlements: string[];
}

export abstract class AgentInferencePort {
  /**
   * Is an inference gateway configured at all (AGENT_INFERENCE_BASE_URL set)? When
   * false the agents return a "connect inference" result and make NO call
   * (degrade-clean). Pure/synchronous so an agent can branch before any I/O.
   */
  abstract isConfigured(): boolean;

  /**
   * Decide whether this caller may run inference at the requested tier:
   *   - any agent needs `customer-ops` (bundled lanes 1-2),
   *   - a 'metered' request needs `ai-metered` too (lanes 3-4).
   * Honors `UC_ENTITLEMENT_MODE=open` (bootstrap allows with a WARN). Pure
   * (no I/O) — the agents call it to gate AND to render the affordance. Never
   * throws. `tierAllowed` reports the max tier the bearer may use.
   */
  abstract checkEntitlement(
    ctx: InferenceContext,
    requested: InferenceTier,
  ): InferenceEntitlementDecision;

  /**
   * Run one inference request through the control-plane gateway (it picks the
   * lane + meters). Returns the result, or null when not configured / not
   * entitled / the call fails (the agent decides how to surface that — always as
   * a clean, draft-only, no-side-effect result). The entitlement gate is enforced
   * INSIDE this call as defense-in-depth even though the agents also pre-check.
   * This is READ-ONLY w.r.t. the outside world — it produces text/JSON; it never
   * sends mail, posts an invoice, or mutates anything (the human-in-the-loop
   * guarantee lives above it).
   */
  abstract complete(
    ctx: InferenceContext,
    request: AgentInferenceRequest,
  ): Promise<AgentInferenceResult | null>;
}

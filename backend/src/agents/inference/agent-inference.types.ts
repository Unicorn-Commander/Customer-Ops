/**
 * The Agent-Inference contract — the shapes Customer-Ops exchanges with the
 * control-plane inference lane (ops-center `uchub-litellm` routing + metering,
 * reached via Brigade's agent runtime).
 *
 * BINDING PRINCIPLE (SUITE-ARCHITECTURE-MAP §1 "the agent runtime + LLM routing
 * live in the control plane" + §8 "AI inference — 4 lanes, all metered/routed
 * through ops-center"): Customer-Ops does NOT run a model, does NOT route, and
 * does NOT meter. The relationship agents COMPOSE federated context (Contact-Ops
 * + Accounting-Ops + Outreach + Email-Ops + Meeting-Ops + the local relationship)
 * and hand a prompt to this seam; ops-center picks the lane + meters it. This
 * file is the clean `/v1/chat`-style request/response the inference gateway
 * implements, exactly as the other federation seams mirror their apps' contracts.
 *
 * THE 4 LANES (SUITE-ARCHITECTURE-MAP §8):
 *   1. in-browser WebGPU small model (thin MCP orchestrator) — bundled, $0.
 *   2. self-hosted ~27B on local GPUs via litellm — bundled, ~nil marginal cost.
 *   3. metered open-weight API (Qwen direct / OpenRouter) — metered, UC upcharge.
 *   4. metered frontier (Claude/GPT) — metered.
 * "PM/relationship agents are bundled into seat price (lanes 1-2); only genuine
 * high-COGS workloads (lanes 3-4) are metered." The lane is the GATEWAY's choice;
 * Customer-Ops only states the agent's quality NEED (a hint) and the gateway maps
 * it to a lane + applies the entitlement/metering policy for that lane.
 *
 * ENTITLEMENT / METERING (binding, brief — "the inference lane is entitlement/
 * metering-gated per the 4-lane model; degrade-clean otherwise"): the agents
 * require the `customer-ops` SKU to run at all; a request that the gateway would
 * route to a METERED lane (3-4) additionally requires the metered-AI entitlement
 * (`ai-metered`). The bundled lanes (1-2) need only `customer-ops`. The decision
 * is surfaced via the port's `checkEntitlement` so a service can degrade-clean
 * (skip the call, return a "not entitled"/"connect inference" result) without
 * reaching into the client. `UC_ENTITLEMENT_MODE=open` is the pre-Lago bootstrap.
 */

/** The lane the agent's workload is APPROPRIATE for — a hint the gateway maps to
 *  an actual lane. Relationship agents default to 'bundled' (lanes 1-2, in seat
 *  price); a caller may request 'metered' for a high-COGS frontier draft (lanes
 *  3-4) which the entitlement gate then requires `ai-metered` for. */
export type InferenceTier = 'bundled' | 'metered';

/** One chat message handed to the inference gateway (system/user/assistant). */
export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * The inference request an agent assembles. `task` tags the agent (for the
 * gateway's metering dimensions + routing policy); `tier` is the bundled/metered
 * hint; `messages` is the assembled prompt (composed from federated context).
 * `responseFormat:'json'` asks the gateway for a structured object back (the
 * triage/score agents); 'text' for prose (the draft agents). Customer-Ops never
 * picks a model name — the gateway owns the lane → model mapping.
 */
export interface AgentInferenceRequest {
  /** The agent identity (metering dimension + routing policy key). */
  task:
    | 'lead-triage'
    | 'follow-up-draft'
    | 'collections-nudge'
    | 'next-best-action'
    | 'meeting-prep';
  /** The workload tier hint (bundled by default; metered requires ai-metered). */
  tier: InferenceTier;
  messages: AgentMessage[];
  /** 'json' asks the gateway to return a parseable object; 'text' for prose. */
  responseFormat: 'json' | 'text';
  /** Soft cap on output tokens (the gateway clamps to the lane's limit). */
  maxOutputTokens?: number;
  /** Optional sampling temperature (the gateway clamps/defaults). */
  temperature?: number;
}

/**
 * The inference result the gateway returns. `text` is the model output (prose, or
 * the raw JSON string the agent parses). `lane` + `model` + `tokens` are the
 * metering/audit echo (which lane actually ran, what it cost) so the agent can log
 * provenance. `metered` records whether this call hit a billable lane.
 */
export interface AgentInferenceResult {
  /** The model output. For responseFormat:'json' this is the JSON string. */
  text: string;
  /** Which lane the gateway actually used (1-4), echoed for audit/metering. */
  lane: number | null;
  /** The model the gateway routed to (opaque; never chosen by Customer-Ops). */
  model: string | null;
  /** Whether the call hit a billable (metered) lane (3-4). */
  metered: boolean;
  /** Token accounting echoed by the gateway (any may be null). */
  promptTokens: number | null;
  completionTokens: number | null;
}

/**
 * The entitlement decision for an inference call. `allowed` gates whether the
 * call is made at all; `tierAllowed` is the highest tier the bearer may use
 * (a bundled-only bearer can still run lanes 1-2 even if it asked for metered).
 * `reason` is logged + (on deny) surfaced; `mode` records enforce vs the open
 * bootstrap. Identical-shaped decision to the AO/Outreach/Email gates.
 */
export interface InferenceEntitlementDecision {
  allowed: boolean;
  /** The max tier the bearer is entitled to ('bundled' unless ai-metered held). */
  tierAllowed: InferenceTier;
  mode: 'enforce' | 'open';
  reason: string;
}

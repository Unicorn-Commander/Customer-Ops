/**
 * The Conversations-Ops federation PORT.
 *
 * An abstract class used as a DI token + interface. The relationship layer (the
 * customer-360 conversations slot) depends ONLY on this port, never on the
 * concrete client — the same federate-don't-fork seam as EmailOpsPort /
 * ContactOpsPort. It gives the omni-channel surface its first channel (the
 * worker's device, via UUDC) without Customer-Ops becoming a message store:
 *
 *   1. Federation is built against the UUDC `messages.*` MCP contract but MOCKED
 *      in tests (the device bridge need not be running) — tests provide a fake.
 *   2. The transport (JSON-RPC MCP to the device today; a control-plane MCP
 *      gateway / the Email-Ops Comms engine later) is swappable without touching
 *      relationship logic.
 *   3. Customer-Ops never becomes a second message store: the port only LISTS a
 *      contact's device conversations and SENDS one message (idempotently). The
 *      device owns the conversations, threads, and message bodies.
 *
 * ENTITLEMENT: a SEND requires `customer-ops` (the worker's own cockpit). The
 * bootstrap env `UC_ENTITLEMENT_MODE=open` lets it run with a loud WARN. READS
 * (list conversations) are viewer-level — no SKU — so a workspace can always see
 * its device conversation history.
 *
 * DEGRADE-CLEAN: when CONVERSATIONS_OPS_BASE_URL is unset, `isConfigured()` is
 * false; the service then renders the conversations slot as "connect" and makes
 * no call. Every method is individually safe to call when unconfigured (returns
 * empty / null / a not-configured decision), so a missing config can never throw.
 */

import {
  ConversationSendRequest,
  ConversationSendResult,
  ConversationThread,
  EntitlementDecision,
} from './conversations-ops.types';
import { SeamHealth } from '../health/seam-health';

/** The per-call federation identity: which workspace, who is acting, what they
 *  are entitled to. `entitlements` is the verified token SKU list (raw). */
export interface FederationContext {
  /** Resolved canonical workspace id. */
  workspaceId: string;
  /** Acting user's uchub sub (attribution). */
  ucUid: string | null;
  /** Verified entitlement SKUs off the bearer token (normalized by the client). */
  entitlements: string[];
}

export abstract class ConversationsOpsPort {
  /**
   * Probe this seam's transport + auth with a side-effect-free MCP `tools/list`
   * and report a SeamHealth (so a silent 401/403/unreachable becomes visible via
   * `GET /health/integrations` rather than hiding behind a degrade-clean panel).
   * Never throws.
   */
  abstract ping(): Promise<SeamHealth>;

  /**
   * Is a conversations target configured at all (CONVERSATIONS_OPS_BASE_URL set)?
   * When false the cockpit shows "connect" and NO federation call is made.
   * Pure/synchronous so the service can branch before any I/O.
   */
  abstract isConfigured(): boolean;

  /**
   * Decide whether this caller may SEND a message: requires `customer-ops`,
   * honoring `UC_ENTITLEMENT_MODE=open` (bootstrap allows with a WARN). Pure
   * (no I/O). Never throws.
   */
  abstract checkEntitlement(ctx: FederationContext): EntitlementDecision;

  /**
   * List the device CONVERSATIONS with a customer's contact, matched by the
   * contact's handles (phone e164 / email). This is the customer-360 conversation
   * history. Read-only / viewer-level. Returns [] when not configured / no handles
   * / the call fails (degrade-clean).
   */
  abstract listConversationsForContact(
    ctx: FederationContext,
    handles: string[],
  ): Promise<ConversationThread[]>;

  /**
   * Send a message to a contact's handle via the device bridge (UUDC
   * `messages.send`). Entitlement-gated (enforced INSIDE this call as
   * defense-in-depth even though the service also pre-checks). Returns the result,
   * or null when not configured / not entitled / the call fails.
   */
  abstract sendMessage(
    ctx: FederationContext,
    request: ConversationSendRequest,
  ): Promise<ConversationSendResult | null>;
}

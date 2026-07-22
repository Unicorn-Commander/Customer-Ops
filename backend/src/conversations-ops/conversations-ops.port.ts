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
 *      contact's device conversations / thread messages and SENDS one message
 *      (idempotently). The device owns the conversations, threads, and bodies.
 *
 * ENTITLEMENT: a SEND requires `customer-ops` (the worker's own cockpit). The
 * bootstrap env `UC_ENTITLEMENT_MODE=open` lets it run with a loud WARN. READS
 * (list conversations / thread messages) are viewer-level — no SKU.
 *
 * ACTIVATION (dogfood first):
 *   - Bridge: CONVERSATIONS_OPS_BASE_URL (+ mTLS material when TRANSPORT=mtls)
 *   - Per-channel: CONVERSATIONS_OPS_CHANNELS=imessage,sms
 *   - Per-workspace: CONVERSATIONS_OPS_WORKSPACE_ALLOWLIST (empty = all)
 *   - Live send: CONVERSATIONS_OPS_LIVE_SEND_ENABLED (+ optional LIVE_SEND_CHANNELS)
 * Without these, methods degrade-clean (empty / null) and never throw.
 */

import {
  ConversationMessage,
  ConversationSendRequest,
  ConversationSendResult,
  ConversationThread,
  DeviceChannel,
  DeviceMessagingActivation,
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
   * Is a conversations target configured at all (CONVERSATIONS_OPS_BASE_URL set,
   * and mTLS material present when TRANSPORT=mtls)? When false the cockpit shows
   * "connect" and NO federation call is made. Pure/synchronous.
   */
  abstract isConfigured(): boolean;

  /**
   * Pure activation snapshot (flags + blockers) for the device SMS/iMessage seam.
   * Never throws; never includes secrets.
   */
  abstract activation(): DeviceMessagingActivation;

  /**
   * True when the workspace is allowed to use the device bridge.
   * CONVERSATIONS_OPS_WORKSPACE_ALLOWLIST empty ⇒ all workspaces (once configured).
   * Pure/synchronous.
   */
  abstract isWorkspaceAllowed(workspaceId: string): boolean;

  /**
   * True when the named channel is enabled via CONVERSATIONS_OPS_CHANNELS.
   * Accepts 'iMessage' | 'SMS' | 'imessage' | 'sms' (case-insensitive).
   * Pure/synchronous.
   */
  abstract isChannelEnabled(channel: string): boolean;

  /**
   * True when a send on `channel` may leave dry-run
   * (LIVE_SEND_ENABLED + channel in LIVE_SEND_CHANNELS). Pure/synchronous.
   */
  abstract isLiveSendEnabledFor(channel: string): boolean;

  /**
   * Decide whether this caller may SEND a message: requires `customer-ops`,
   * honoring `UC_ENTITLEMENT_MODE=open` (bootstrap allows with a WARN). Pure
   * (no I/O). Never throws.
   */
  abstract checkEntitlement(ctx: FederationContext): EntitlementDecision;

  /**
   * List the device CONVERSATIONS with a customer's contact, matched by the
   * contact's handles (phone e164 / email). Filtered to enabled channels +
   * workspace allowlist. Read-only / viewer-level. Returns [] when not
   * configured / workspace not allowed / no handles / the call fails.
   */
  abstract listConversationsForContact(
    ctx: FederationContext,
    handles: string[],
  ): Promise<ConversationThread[]>;

  /**
   * List MESSAGES in one device conversation (UUDC `messages.thread`). Bodies
   * are previews only. Read-only / viewer-level. Returns [] when not configured
   * / workspace not allowed / the call fails (degrade-clean).
   */
  abstract listMessagesInConversation(
    ctx: FederationContext,
    chatIdentifier: string,
  ): Promise<ConversationMessage[]>;

  /**
   * Send a message to a contact's handle via the device bridge (UUDC
   * `messages.send`). Entitlement-gated (enforced INSIDE this call as
   * defense-in-depth). Honors channel enablement + workspace allowlist.
   * Defaults to dry_run unless live-send is explicitly enabled for the channel.
   * Returns the result, or null when not configured / not entitled / channel
   * disabled / the call fails.
   */
  abstract sendMessage(
    ctx: FederationContext,
    request: ConversationSendRequest,
  ): Promise<ConversationSendResult | null>;

  /** Enabled device channels for this deployment (from flags). */
  abstract enabledChannels(): DeviceChannel[];
}

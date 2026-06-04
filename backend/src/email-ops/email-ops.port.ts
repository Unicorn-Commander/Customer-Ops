/**
 * The Email-Ops federation PORT.
 *
 * An abstract class used as a DI token + interface. The relationship layer
 * (CustomersService / the customer-360 email slot) depends ONLY on this port,
 * never on the concrete client. This is the same federate-don't-fork seam as
 * ContactOpsPort / AccountingOpsPort / OutreachPort, and gives the brief's
 * required properties:
 *
 *   1. Federation is built against the (future) Email-Ops APP contract but
 *      MOCKED in tests (Email-Ops is not built yet) — tests provide a fake
 *      EmailOpsPort. The contract here is a clean, sensible `/mcp`-style surface
 *      for the Email-Ops app to implement (informed by Stalwart IMAP/JMAP mailbox
 *      threads, but federating the APP, not the mail server).
 *   2. The transport (JSON-RPC MCP today; a Brigade-brokered transport later) is
 *      swappable without touching relationship logic.
 *   3. Customer-Ops never becomes a second mail store: the port only LISTS
 *      threads/messages with a contact and SENDS/DRAFTS one email (idempotently).
 *      Email-Ops owns the mailboxes, threads, and message bodies; the only local
 *      state is the thin CustomerEmailLink the service writes around a compose.
 *
 * ENTITLEMENT (binding, brief): every SEND/DRAFT (the outbound compose) requires
 * BOTH `customer-ops` AND `email-ops` in the bearer's entitlements. The bootstrap
 * env `UC_ENTITLEMENT_MODE=open` lets the call run with a loud WARN before Lago
 * emits the claim. The decision is exposed via `checkEntitlement` so the service
 * can degrade-clean (show "connect Email-Ops" + make NO call) without reaching
 * into the client. READS (list threads/messages) are viewer-level — they do NOT
 * require the dual SKU, so a workspace can always see its mailbox history.
 *
 * DEGRADE-CLEAN (binding): when EMAIL_OPS_BASE_URL is unset, `isConfigured()` is
 * false; the service then renders the email slot as "connect Email-Ops" and makes
 * no call. Every method is also individually safe to call when unconfigured
 * (returns empty / null / a not-configured decision), so a missing config can
 * never throw.
 */

import {
  EmailComposeRequest,
  EmailComposeResult,
  EmailMessage,
  EmailThread,
  EntitlementDecision,
} from './email-ops.types';

/** The per-call federation identity: which workspace, who is acting, what they
 *  are entitled to. `entitlements` is the verified token SKU list (raw). */
export interface FederationContext {
  /** Resolved canonical workspace id (uc-registry uuidv7); the Email-Ops claim. */
  workspaceId: string;
  /** Acting user's uchub sub (attribution; the Email-Ops actor). */
  ucUid: string | null;
  /** Verified entitlement SKUs off the bearer token (normalized by the client). */
  entitlements: string[];
}

export abstract class EmailOpsPort {
  /**
   * Is an Email-Ops target configured at all (EMAIL_OPS_BASE_URL set)? When false
   * the cockpit shows "connect Email-Ops" and NO federation call is made
   * (degrade-clean). Pure/synchronous so the service can branch before any I/O.
   */
  abstract isConfigured(): boolean;

  /**
   * Decide whether this caller may SEND/DRAFT outbound mail: requires BOTH
   * `customer-ops` AND `email-ops` entitlements, honoring `UC_ENTITLEMENT_MODE=
   * open` (bootstrap allows with a WARN). Pure (no I/O) — the service calls it to
   * gate AND to render the "not entitled" affordance. Never throws.
   */
  abstract checkEntitlement(ctx: FederationContext): EntitlementDecision;

  /**
   * List mailbox THREADS with a customer's contact (Email-Ops
   * `list_threads_with_contact`). This is the customer-360 email history.
   * Read-only / viewer-level. Returns [] when not configured / unknown / the call
   * fails (degrade-clean). Does NOT require the dual SKU.
   */
  abstract listThreadsWithContact(
    ctx: FederationContext,
    contactId: string,
  ): Promise<EmailThread[]>;

  /**
   * List the MESSAGES in one thread (Email-Ops `list_thread_messages`), bodies as
   * previews only. Used when the cockpit expands a thread. Read-only /
   * viewer-level. Returns [] when not configured / unknown / the call fails.
   */
  abstract listThreadMessages(ctx: FederationContext, threadId: string): Promise<EmailMessage[]>;

  /**
   * Compose an outbound email to a customer's contact (Email-Ops `compose_email`)
   * — `mode:'send'` queues delivery now; `mode:'draft'` stages it into the
   * agent-inbox approval surface. IDEMPOTENT on (workspaceId, externalSource,
   * externalRef): a repeat returns the EXISTING message and queues NO second
   * send. Returns the message view, or null when not configured / not entitled /
   * the call fails (the service decides how to surface that). The entitlement
   * gate is enforced INSIDE this call as defense-in-depth even though the service
   * also pre-checks.
   */
  abstract composeEmail(
    ctx: FederationContext,
    request: EmailComposeRequest,
  ): Promise<EmailComposeResult | null>;
}

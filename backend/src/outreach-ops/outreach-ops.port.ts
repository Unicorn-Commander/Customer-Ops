/**
 * The Outreach federation PORT.
 *
 * An abstract class used as a DI token + interface. The relationship layer
 * (CustomersService / the customer-360 outreach slot) depends ONLY on this port,
 * never on the concrete client. This is the same federate-don't-fork seam as
 * ContactOpsPort / AccountingOpsPort, and gives the brief's required properties:
 *
 *   1. Federation is built against the (future) Outreach APP contract but MOCKED
 *      in tests (Outreach is not built yet) — tests provide a fake OutreachPort.
 *      The contract here is a clean, sensible `/mcp`-style surface for the
 *      Outreach app to implement (informed by Listmonk campaigns/lists/sends +
 *      Postiz scheduled social posts, but federating the APP, not the engines).
 *   2. The transport (JSON-RPC MCP today; a Brigade-brokered transport later) is
 *      swappable without touching relationship logic.
 *   3. Customer-Ops never becomes a second campaign engine: the port only LISTS
 *      campaigns/touches for a contact and TRIGGERS an enrollment / social touch
 *      (idempotently). Outreach owns the lists, sends, and deliverability lanes;
 *      the only local state is the thin CustomerOutreachLink the service writes
 *      around these calls.
 *
 * ENTITLEMENT (binding, brief): every TRIGGER (enroll / schedule) requires BOTH
 * `customer-ops` AND `outreach` in the bearer's entitlements. The bootstrap env
 * `UC_ENTITLEMENT_MODE=open` lets the call run with a loud WARN before Lago emits
 * the claim. The decision is exposed via `checkEntitlement` so the service can
 * degrade-clean (show "connect Outreach" + make NO call) without reaching into
 * the client. READS (list campaigns/touches) are viewer-level — they do NOT
 * require the dual SKU, so a workspace can always see its outreach history.
 *
 * DEGRADE-CLEAN (binding): when OUTREACH_BASE_URL is unset, `isConfigured()` is
 * false; the service then renders the outreach slot as "connect Outreach" and
 * makes no call. Every method is also individually safe to call when unconfigured
 * (returns empty / null / a not-configured decision), so a missing config can
 * never throw.
 */

import {
  CampaignEnrollment,
  EntitlementDecision,
  OutreachCampaign,
  OutreachEnrollmentResult,
  OutreachTouch,
  SocialTouchRequest,
} from './outreach-ops.types';

/** The per-call federation identity: which workspace, who is acting, what they
 *  are entitled to. `entitlements` is the verified token SKU list (raw). */
export interface FederationContext {
  /** Resolved canonical workspace id (uc-registry uuidv7); the Outreach claim. */
  workspaceId: string;
  /** Acting user's uchub sub (attribution; the Outreach actor). */
  ucUid: string | null;
  /** Verified entitlement SKUs off the bearer token (normalized by the client). */
  entitlements: string[];
}

export abstract class OutreachPort {
  /**
   * Is an Outreach target configured at all (OUTREACH_BASE_URL set)? When false
   * the cockpit shows "connect Outreach" and NO federation call is made
   * (degrade-clean). Pure/synchronous so the service can branch before any I/O.
   */
  abstract isConfigured(): boolean;

  /**
   * Decide whether this caller may TRIGGER outreach (enroll / schedule a touch):
   * requires BOTH `customer-ops` AND `outreach` entitlements, honoring
   * `UC_ENTITLEMENT_MODE=open` (bootstrap allows with a WARN). Pure (no I/O) —
   * the service calls it to gate AND to render the "not entitled" affordance.
   * Never throws.
   */
  abstract checkEntitlement(ctx: FederationContext): EntitlementDecision;

  /**
   * List the campaigns/sequences available in the workspace to enroll a contact
   * into (Outreach `list_campaigns`). Read-only / viewer-level — used to populate
   * the "start a campaign" picker. Returns [] when not configured / the call
   * fails (degrade-clean). Does NOT require the dual SKU.
   */
  abstract listCampaigns(ctx: FederationContext): Promise<OutreachCampaign[]>;

  /**
   * List the outreach TOUCHES (sends / scheduled social posts) for a customer's
   * contact (Outreach `list_touches_for_contact`). This is the customer-360
   * outreach history. Read-only / viewer-level. Returns [] when not configured /
   * unknown / the call fails. Does NOT require the dual SKU.
   */
  abstract listTouchesForContact(
    ctx: FederationContext,
    contactId: string,
  ): Promise<OutreachTouch[]>;

  /**
   * Enroll a customer's contact into a campaign/sequence (Outreach
   * `enroll_contact`). IDEMPOTENT on (workspaceId, externalSource, externalRef):
   * a repeat returns the EXISTING enrollment and queues NO second send. Returns
   * the enrollment view, or null when not configured / not entitled / the call
   * fails (the service decides how to surface that). The entitlement gate is
   * enforced INSIDE this call as defense-in-depth even though the service also
   * pre-checks.
   */
  abstract enrollContact(
    ctx: FederationContext,
    enrollment: CampaignEnrollment,
  ): Promise<OutreachEnrollmentResult | null>;

  /**
   * Schedule a single SOCIAL touch (Postiz) attributed to a customer's contact
   * (Outreach `schedule_social_touch`). Same idempotency tuple + dual-SKU gate +
   * degrade-clean semantics as enrollContact. Returns the touch view or null.
   */
  abstract scheduleSocialTouch(
    ctx: FederationContext,
    request: SocialTouchRequest,
  ): Promise<OutreachEnrollmentResult | null>;
}

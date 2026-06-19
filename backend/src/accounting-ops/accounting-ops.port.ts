/**
 * The Accounting-Ops federation PORT.
 *
 * An abstract class used as a DI token + interface. The relationship layer
 * (CustomersService / the customer-360 invoice slot) depends ONLY on this port,
 * never on the concrete client. This is the same federate-don't-fork seam as
 * ContactOpsPort, and gives the brief's required properties:
 *
 *   1. Federation is built against the Accounting-Ops contract but MOCKED in
 *      tests (AO is not running during verification) — tests provide a fake
 *      AccountingOpsPort.
 *   2. The transport (JSON-RPC MCP today; a Brigade-brokered transport later) is
 *      swappable without touching relationship logic.
 *   3. Customer-Ops never becomes a second invoicing engine: the port only
 *      CREATES an invoice in AO (idempotently) and POLLS its status. AO owns the
 *      ledger; the only local state is the thin CustomerInvoiceLink the service
 *      writes around these calls.
 *
 * ENTITLEMENT (binding, README "Accounting-Ops AR"): every create/poll requires
 * BOTH `customer-ops` AND `accounting-ops` in the bearer's entitlements. The
 * bootstrap env `UC_ENTITLEMENT_MODE=open` lets the call run with a loud WARN
 * before Lago emits the claim. The decision is exposed via `checkEntitlement` so
 * the service can degrade-clean (show "connect Accounting-Ops" + make NO call)
 * without reaching into the client.
 *
 * DEGRADE-CLEAN (binding): when AO_BASE_URL is unset, `isConfigured()` is false;
 * the service then renders the invoice slot as "connect Accounting-Ops" and
 * makes no call. Every method is also individually safe to call when unconfigured
 * (returns null / a not-configured decision), so a missing config can never throw.
 */

import { EntitlementDecision, FederatedInvoice, InvoiceDraft } from './accounting-ops.types';
import { SeamHealth } from '../health/seam-health';

/** The per-call federation identity: which workspace, who is acting, what they
 *  are entitled to. `entitlements` is the verified token SKU list (raw). */
export interface FederationContext {
  /** Resolved canonical workspace id (uc-registry uuidv7); the AO wire claim. */
  workspaceId: string;
  /** Acting user's uchub sub (attribution; the AO actor). */
  ucUid: string | null;
  /** Verified entitlement SKUs off the bearer token (normalized by the client). */
  entitlements: string[];
}

export abstract class AccountingOpsPort {
  /**
   * Probe this seam's transport + auth with a lightweight, side-effect-free MCP
   * `tools/list` and report a SeamHealth (so a silent 401/403 becomes visible via
   * `GET /health/integrations` rather than hiding behind a degrade-clean panel).
   * Never throws — every failure is folded into the returned SeamHealth.
   */
  abstract ping(): Promise<SeamHealth>;

  /**
   * Is an Accounting-Ops target configured at all (AO_BASE_URL set)? When false
   * the cockpit shows "connect Accounting-Ops" and NO federation call is made
   * (degrade-clean). Pure/synchronous so the service can branch before any I/O.
   */
  abstract isConfigured(): boolean;

  /**
   * Decide whether this caller may invoice via AO: requires BOTH `customer-ops`
   * AND `accounting-ops` entitlements, honoring `UC_ENTITLEMENT_MODE=open`
   * (bootstrap allows with a WARN). Pure (no I/O) — the service calls it to gate
   * AND to render the "not entitled" affordance. Never throws.
   */
  abstract checkEntitlement(ctx: FederationContext): EntitlementDecision;

  /**
   * Create + post an AR invoice in Accounting-Ops from an assembled draft (AO
   * `create_invoice_from_draft`). IDEMPOTENT on (workspaceId, externalSource,
   * externalRef): a repeat returns the EXISTING AO invoice and posts no second
   * ledger entry. Returns the AO invoice view, or null when not configured /
   * not entitled / the call fails (the service decides how to surface that). The
   * entitlement gate is enforced INSIDE this call as defense-in-depth even
   * though the service also pre-checks.
   */
  abstract createInvoice(
    ctx: FederationContext,
    draft: InvoiceDraft,
  ): Promise<FederatedInvoice | null>;

  /**
   * Poll one AO invoice by its idempotency key (AO `get_invoice(external_source,
   * external_ref)`) for live status + balance_due. NO webhooks — this is the
   * status surface. Returns null when not configured / unknown / the call fails.
   * Reads do NOT require the dual SKU (viewer-level on AO) — a workspace that
   * already has linked invoices can always see their status.
   */
  abstract getInvoiceByRef(
    ctx: FederationContext,
    externalSource: string,
    externalRef: string,
  ): Promise<FederatedInvoice | null>;

  /**
   * Poll one AO invoice by its AO id (AO `get_invoice(invoice_id)`). Same
   * semantics as getInvoiceByRef; used when the link already resolved the AO id.
   */
  abstract getInvoiceById(
    ctx: FederationContext,
    invoiceId: string,
  ): Promise<FederatedInvoice | null>;
}

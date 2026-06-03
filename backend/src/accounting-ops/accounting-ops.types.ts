/**
 * The Accounting-Ops federation contract — the shapes Customer-Ops exchanges
 * with the canonical AR / invoicing engine.
 *
 * BINDING PRINCIPLE (README "What it owns vs federates" + golden rule):
 * Customer-Ops FEDERATES invoicing; Accounting-Ops is the ONE AR engine and the
 * system-of-record for every invoice (the ledger, the double-entry hash chain,
 * the authoritative balance). Customer-Ops never posts a ledger entry and never
 * stores invoice line detail. The only invoicing data it persists is the thin
 * CustomerInvoiceLink (the idempotency tuple + a cached status); everything in
 * this file is the WIRE shape resolved over the federation seam at read/write
 * time.
 *
 * These types mirror Accounting-Ops's own MCP tool I/O verbatim so the wire
 * contract is explicit and the client's mapping is auditable:
 *   - the create input == AO `create_invoice_from_draft` arguments
 *     (app/tools/ar_invoicing.py: workspace_id, entity_id, external_source,
 *      external_ref, customer{}, line_items[], currency, issue_date, due_date,
 *      net_terms, discount, notes, po_number, auto_send).
 *   - `FederatedInvoice` == the AO invoice view returned by both
 *     create_invoice_from_draft and get_invoice (id, invoice_number, status,
 *      currency, subtotal, tax_total, total, balance_due, issue_date, due_date,
 *      external_source, external_ref, pdf_url, hosted_pay_url, ...).
 *
 * MONEY (binding, README "Accounting-Ops AR"): all amounts are NUMERIC(20,4)
 * DECIMAL STRINGS on the wire — never float. We keep them as strings end-to-end
 * (DTO → client → AO → cached link column) so no precision is lost.
 */

/** A customer block for AO `create_invoice_from_draft` (AO CustomerBody). */
export interface InvoiceCustomerInput {
  /** Display name (AO requires this). */
  name: string;
  /** The federated Contact-Ops contact id — a thin reference AO stores in
   *  external_refs; the contact record itself is NEVER copied (golden rule). */
  contactId?: string | null;
  email?: string | null;
  billingAddress?: string | null;
}

/**
 * One invoice line for AO `create_invoice_from_draft` (AO LineItemBody). Money
 * fields are decimal strings. `amount` defaults (AO-side) to quantity*unit_price
 * when omitted; `taxAmount` defaults to 0.
 */
export interface InvoiceLineInput {
  description: string;
  /** Decimal string (e.g. "1", "2.5"). */
  quantity?: string;
  /** Decimal string (e.g. "150.0000"). */
  unitPrice?: string;
  /** Decimal string; AO computes quantity*unitPrice when omitted. */
  amount?: string | null;
  taxCode?: string | null;
  /** Decimal string. */
  taxAmount?: string | null;
  /** Optional AO revenue account UUID; AO falls back to a default when omitted. */
  revenueAccountId?: string | null;
  sourceRef?: string | null;
}

/**
 * The assembled draft Customer-Ops hands to AO. `externalSource` is always
 * 'customer-ops' for this app; `externalRef` is the DETERMINISTIC idempotency
 * key (AO is idempotent on (workspace_id, external_source, external_ref)).
 */
export interface InvoiceDraft {
  /** AO billing entity UUID (AO's; carried through, resolved per workspace). */
  entityId: string;
  /** Always 'customer-ops' for links this app creates. */
  externalSource: string;
  /** Deterministic idempotency key minted by Customer-Ops. */
  externalRef: string;
  customer: InvoiceCustomerInput;
  lineItems: InvoiceLineInput[];
  currency?: string;
  /** ISO date (YYYY-MM-DD). */
  issueDate?: string | null;
  /** ISO date (YYYY-MM-DD). Derived from netTerms (AO-side) when omitted. */
  dueDate?: string | null;
  netTerms?: number | null;
  /** Invoice-level discount; decimal string. */
  discount?: string | null;
  notes?: string | null;
  poNumber?: string | null;
  /** When true the invoice starts 'sent'; else 'draft'. */
  autoSend?: boolean;
}

/**
 * The AO invoice projection returned by create_invoice_from_draft / get_invoice.
 * Money fields are decimal strings exactly as AO emits them. We surface the
 * load-bearing header fields the cockpit renders + polls; line/payment detail
 * stays in AO (we don't re-render the ledger).
 */
export interface FederatedInvoice {
  /** AO invoice UUID. */
  id: string;
  invoiceNumber: string | null;
  /** draft|sent|partial|paid|void (AO invoice.status). */
  status: string;
  currency: string;
  /** Decimal strings (NUMERIC(20,4)). */
  subtotal: string | null;
  taxTotal: string | null;
  total: string | null;
  balanceDue: string | null;
  issueDate: string | null;
  dueDate: string | null;
  externalSource: string | null;
  externalRef: string | null;
  /** AO-relative URLs (server-rendered PDF / hosted pay link); may be null. */
  pdfUrl: string | null;
  hostedPayUrl: string | null;
}

/**
 * The result of the entitlement decision for an AO invoicing call. `allowed`
 * gates whether the federation call is made at all; `reason` is logged + (on
 * deny) surfaced to the caller. `mode` records which posture decided it
 * (enforce vs the open bootstrap) for auditability.
 */
export interface EntitlementDecision {
  allowed: boolean;
  mode: 'enforce' | 'open';
  reason: string;
}

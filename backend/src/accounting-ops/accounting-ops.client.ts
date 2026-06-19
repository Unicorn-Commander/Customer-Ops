/**
 * The concrete Accounting-Ops federation client.
 *
 * Speaks the AR/invoicing surface Accounting-Ops exposes over MCP (verified in
 * the AO tree: app/tools/ar_invoicing.py + app/ar/):
 *
 *   1. MCP — JSON-RPC 2.0 over `POST {AO_BASE_URL}/mcp`. AO resolves the tenant
 *      from the bearer's `workspace_id` claim (re-gated server-side), never a
 *      trusted header. Tools used:
 *        - create_invoice_from_draft(workspace_id, entity_id, external_source,
 *            external_ref, customer{}, line_items[], currency, issue_date,
 *            due_date, net_terms, discount, notes, po_number, auto_send)
 *          -> the AO invoice view. IDEMPOTENT on
 *             (workspace_id, external_source, external_ref): a repeat returns the
 *             EXISTING invoice and posts NO second journal entry.
 *        - get_invoice(workspace_id, invoice_id? | external_source?+external_ref?)
 *          -> the AO invoice view (status, balance_due, ...). The POLL surface —
 *             AO emits NO webhooks.
 *      Tool-call envelope: result.structuredContent (preferred) | content[0].text.
 *      Application errors come back HTTP 200 with result.isError=true OR a
 *      JSON-RPC `error` — both handled.
 *
 * AUTH: Customer-Ops calls Accounting-Ops as a service. The bearer is a
 * federation token carrying the addressed `workspace_id` claim + `aud=accounting-ops`.
 * The auth MODE is selectable (mirrors the Contact-Ops / Meeting-Ops clients):
 *   - `static` (default): forward a configured service token (AO_SERVICE_TOKEN);
 *   - `brigade-sts`: mint a customer-ops client-credentials token and exchange it
 *     at Brigade (RFC-8693) for an `aud=accounting-ops`, workspace-bound token.
 * The workspace is addressed via the documented precedence (X-Workspace-Id header,
 * which AO re-gates against membership). The mint seam is isolated in
 * `authHeaders()` / `bearerFor()` so the mode is a one-knob change — exactly like
 * the Contact-Ops client.
 *
 * ENTITLEMENT (binding): invoicing requires BOTH `customer-ops` AND
 * `accounting-ops` on the bearer. `checkEntitlement` is the pure gate; create
 * also re-checks (defense-in-depth). `UC_ENTITLEMENT_MODE=open` is the pre-Lago
 * bootstrap escape hatch (allow + WARN); it falls back to AO's own legacy var
 * `AO_CROSS_APP_ENTITLEMENT_MODE` so one knob configures both apps. The suite
 * verb "enforce" == strict claim check; "open" == bootstrap.
 *
 * DEGRADE-CLEAN (binding): when AO_BASE_URL is unset, `isConfigured()` is false
 * and every method returns null without any fetch. The cockpit then renders the
 * invoice slot as "connect Accounting-Ops" and makes no call. This keeps
 * Customer-Ops fully functional without a hard AO dependency (Phase-1/2 dogfood,
 * verification, or any node where AR isn't wired), and is what the tests assert.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';
import { AccountingOpsPort, FederationContext } from './accounting-ops.port';
import { EntitlementDecision, FederatedInvoice, InvoiceDraft } from './accounting-ops.types';

interface JsonRpcResult {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: JsonRpcResult;
  error?: { code: number; message: string };
}

/** Canonical suite SKU strings (must match Lago/Keycloak + AO's PRODUCT_*). */
export const SKU_CUSTOMER_OPS = 'customer-ops';
export const SKU_ACCOUNTING_OPS = 'accounting-ops';

/** SKU spelling/alias tolerance — mirrors AO's `_ALIASES` so we accept whatever
 *  shape the upstream claim eventually lands. Normalized on read only. */
const SKU_ALIASES: Record<string, string> = {
  'customer-ops': SKU_CUSTOMER_OPS,
  customer_ops: SKU_CUSTOMER_OPS,
  customerops: SKU_CUSTOMER_OPS,
  co: SKU_CUSTOMER_OPS,
  'accounting-ops': SKU_ACCOUNTING_OPS,
  accounting_ops: SKU_ACCOUNTING_OPS,
  accountingops: SKU_ACCOUNTING_OPS,
  ao: SKU_ACCOUNTING_OPS,
};

function normalizeSku(code: string): string {
  const key = (code || '').trim().toLowerCase();
  return SKU_ALIASES[key] ?? key;
}

@Injectable()
export class AccountingOpsClient extends AccountingOpsPort {
  private readonly logger = new Logger(AccountingOpsClient.name);
  private rpcId = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly brigade: BrigadeTokenSource,
  ) {
    super();
    if (!this.baseUrl) {
      this.logger.warn(
        'AO_BASE_URL unset — Accounting-Ops federation is DORMANT; the ' +
          'customer-360 invoice slot shows "connect Accounting-Ops" and no ' +
          'invoicing call is made until configured.',
      );
    } else {
      this.logger.log(
        `Accounting-Ops federation target: ${this.baseUrl} ` +
          `(entitlement=${this.mode()}, auth=${this.authMode})`,
      );
    }
  }

  // --- configuration seam -------------------------------------------------

  private get baseUrl(): string | null {
    const raw = this.config.get<string>('AO_BASE_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('AO_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10000;
  }

  /**
   * Entitlement mode. Suite var `UC_ENTITLEMENT_MODE` wins, falling back to AO's
   * own legacy `AO_CROSS_APP_ENTITLEMENT_MODE` so one knob configures both apps.
   * Maps the suite vocabulary to this gate: "open" => bootstrap (allow+WARN);
   * anything else (including "enforce"/"claim", the default) => strict.
   */
  private mode(): 'enforce' | 'open' {
    const raw =
      this.config.get<string>('UC_ENTITLEMENT_MODE') ??
      this.config.get<string>('AO_CROSS_APP_ENTITLEMENT_MODE') ??
      'enforce';
    return raw.trim().toLowerCase() === 'open' ? 'open' : 'enforce';
  }

  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  /**
   * Build the auth headers for a federation call to Accounting-Ops. This is the
   * Brigade token-mint seam: in `static` mode it forwards a configured service
   * token; in `brigade-sts` mode it mints a per-request token via an RFC-8693
   * exchange with `aud=accounting-ops` + the addressed `workspace_id` claim.
   * X-Workspace-Id rides along for AO's per-request addressing; AO re-gates
   * membership server-side, so the header is a hint, never the authz boundary.
   */
  private async authHeaders(ctx: FederationContext): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const bearer = await this.bearerFor(ctx.workspaceId);
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    headers['X-Workspace-Id'] = ctx.workspaceId;
    if (ctx.ucUid) headers['X-Uc-Uid'] = ctx.ucUid;
    return headers;
  }

  /** The auth mode: `static` forwards AO_SERVICE_TOKEN (legacy / dev); `brigade-sts`
   *  mints a customer-ops client-credentials token and exchanges it at Brigade
   *  (RFC-8693) for an accounting-ops-audience, workspace-bound token. DEFAULT
   *  `static` so behavior is unchanged when AO_AUTH_MODE is unset. */
  private get authMode(): 'static' | 'brigade-sts' {
    return this.config.get<string>('AO_AUTH_MODE')?.trim() === 'brigade-sts'
      ? 'brigade-sts'
      : 'static';
  }

  /** Resolve the bearer for a federation call (per the auth mode). `static`
   *  forwards AO_SERVICE_TOKEN; `brigade-sts` delegates to the shared
   *  BrigadeTokenSource (mint customer-ops CC → exchange for aud=accounting-ops).
   *  Degrade-clean: a failed exchange returns null and the caller sends no bearer. */
  private async bearerFor(workspaceId: string): Promise<string | null> {
    if (this.authMode === 'static') {
      const t = this.config.get<string>('AO_SERVICE_TOKEN');
      return t && t.trim() ? t.trim() : null;
    }
    return this.brigade.exchangedToken({
      audience: this.config.get<string>('AO_AUDIENCE')?.trim() || 'accounting-ops',
      scope: 'invoices:read invoices:write',
      workspaceId,
    });
  }

  // --- entitlement gate (pure) -------------------------------------------

  checkEntitlement(ctx: FederationContext): EntitlementDecision {
    const have = new Set((ctx.entitlements ?? []).map(normalizeSku));
    const hasBoth = have.has(SKU_CUSTOMER_OPS) && have.has(SKU_ACCOUNTING_OPS);
    const mode = this.mode();

    if (hasBoth) {
      return {
        allowed: true,
        mode,
        reason: 'entitled: bearer carries both customer-ops and accounting-ops',
      };
    }

    if (mode === 'open') {
      // Pre-Lago bootstrap: allow but log loudly so operators see the gate is
      // running open until the billing claim is wired. Mirrors AO's open mode.
      this.logger.warn(
        `AO entitlement gate is OPEN (UC_ENTITLEMENT_MODE=open) — allowing an ` +
          `invoicing call for workspace=${ctx.workspaceId} WITHOUT the dual ` +
          `customer-ops+accounting-ops SKU check. Set the mode to 'enforce' ` +
          `once Lago emits entitlements.`,
      );
      return {
        allowed: true,
        mode,
        reason: 'open bootstrap: dual-SKU check bypassed (UC_ENTITLEMENT_MODE=open)',
      };
    }

    return {
      allowed: false,
      mode,
      reason:
        'not entitled: invoicing via Accounting-Ops requires a subscription with ' +
        'BOTH customer-ops and accounting-ops; the bearer does not carry both.',
    };
  }

  // --- MCP JSON-RPC transport --------------------------------------------

  /**
   * Invoke one Accounting-Ops MCP tool via JSON-RPC `tools/call`. Returns the
   * tool's structuredContent, or null on any transport/application failure
   * (logged). Never throws — federation is best-effort by design; the service
   * surfaces a clean "couldn't reach AO" rather than a 500.
   */
  private async callTool(
    ctx: FederationContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const base = this.baseUrl;
    if (!base) return null;

    const body = {
      jsonrpc: '2.0',
      id: ++this.rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    };

    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${base}/mcp`, {
        method: 'POST',
        headers: await this.authHeaders(ctx),
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.warn(`Accounting-Ops MCP ${name} transport error: ${(err as Error).message}`);
      return null;
    }

    if (!res.ok) {
      this.logger.warn(`Accounting-Ops MCP ${name} HTTP ${res.status}`);
      return null;
    }

    let payload: JsonRpcResponse;
    try {
      payload = (await res.json()) as JsonRpcResponse;
    } catch (err) {
      this.logger.warn(`Accounting-Ops MCP ${name} non-JSON response: ${(err as Error).message}`);
      return null;
    }

    if (payload.error) {
      this.logger.warn(`Accounting-Ops MCP ${name} JSON-RPC error: ${payload.error.message}`);
      return null;
    }

    const result = payload.result;
    if (!result || result.isError) {
      const text = result?.content?.[0]?.text;
      this.logger.warn(`Accounting-Ops MCP ${name} tool error: ${text ?? 'unknown'}`);
      return null;
    }

    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.find((c) => c.type === 'text')?.text;
    if (text) {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // --- mapping: AO wire shape -> Customer-Ops federation projection -------

  /**
   * Money fields stay as DECIMAL STRINGS — never coerced to number. AO emits
   * them as strings (its `_jsonable` stringifies Decimal); we keep them verbatim
   * so NUMERIC(20,4) precision survives end-to-end into the cached link column.
   */
  private toMoney(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    // Defensive: if AO ever emits a JSON number, render it without float games.
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return null;
  }

  private toInvoice(raw: Record<string, unknown>): FederatedInvoice | null {
    const id = raw['id'];
    if (typeof id !== 'string' || !id) return null;
    const str = (k: string): string | null => {
      const v = raw[k];
      return typeof v === 'string' && v.length > 0 ? v : null;
    };
    return {
      id,
      invoiceNumber: str('invoice_number'),
      status: (raw['status'] as string) ?? 'draft',
      currency: (raw['currency'] as string) ?? 'USD',
      subtotal: this.toMoney(raw['subtotal']),
      taxTotal: this.toMoney(raw['tax_total']),
      total: this.toMoney(raw['total']),
      balanceDue: this.toMoney(raw['balance_due']),
      issueDate: str('issue_date'),
      dueDate: str('due_date'),
      externalSource: str('external_source'),
      externalRef: str('external_ref'),
      pdfUrl: str('pdf_url'),
      hostedPayUrl: str('hosted_pay_url'),
    };
  }

  /** Map a Customer-Ops draft to AO `create_invoice_from_draft` arguments. */
  private toCreateArgs(ctx: FederationContext, draft: InvoiceDraft): Record<string, unknown> {
    const customer: Record<string, unknown> = { name: draft.customer.name };
    if (draft.customer.contactId != null) customer['contact_id'] = draft.customer.contactId;
    if (draft.customer.email != null) customer['email'] = draft.customer.email;
    if (draft.customer.billingAddress != null)
      customer['billing_address'] = draft.customer.billingAddress;

    const line_items = draft.lineItems.map((li) => {
      const out: Record<string, unknown> = { description: li.description };
      // Money/quantity stay as decimal strings; AO parses them exactly.
      if (li.quantity != null) out['quantity'] = li.quantity;
      if (li.unitPrice != null) out['unit_price'] = li.unitPrice;
      if (li.amount != null) out['amount'] = li.amount;
      if (li.taxCode != null) out['tax_code'] = li.taxCode;
      if (li.taxAmount != null) out['tax_amount'] = li.taxAmount;
      if (li.revenueAccountId != null) out['revenue_account_id'] = li.revenueAccountId;
      if (li.sourceRef != null) out['source_ref'] = li.sourceRef;
      return out;
    });

    const args: Record<string, unknown> = {
      workspace_id: ctx.workspaceId,
      entity_id: draft.entityId,
      external_source: draft.externalSource,
      external_ref: draft.externalRef,
      customer,
      line_items,
      currency: draft.currency ?? 'USD',
      auto_send: draft.autoSend ?? false,
    };
    if (draft.issueDate != null) args['issue_date'] = draft.issueDate;
    if (draft.dueDate != null) args['due_date'] = draft.dueDate;
    if (draft.netTerms != null) args['net_terms'] = draft.netTerms;
    if (draft.discount != null) args['discount'] = draft.discount;
    if (draft.notes != null) args['notes'] = draft.notes;
    if (draft.poNumber != null) args['po_number'] = draft.poNumber;
    return args;
  }

  // --- AccountingOpsPort implementation ----------------------------------

  async createInvoice(
    ctx: FederationContext,
    draft: InvoiceDraft,
  ): Promise<FederatedInvoice | null> {
    if (!this.baseUrl) return null;
    // Defense-in-depth: the service pre-checks, but never make the call without
    // the dual-SKU gate (or the open bootstrap) passing.
    const gate = this.checkEntitlement(ctx);
    if (!gate.allowed) {
      this.logger.warn(
        `Accounting-Ops createInvoice DENIED for workspace=${ctx.workspaceId}: ${gate.reason}`,
      );
      return null;
    }
    const raw = await this.callTool(
      ctx,
      'create_invoice_from_draft',
      this.toCreateArgs(ctx, draft),
    );
    if (!raw) return null;
    return this.toInvoice(raw);
  }

  async getInvoiceByRef(
    ctx: FederationContext,
    externalSource: string,
    externalRef: string,
  ): Promise<FederatedInvoice | null> {
    if (!this.baseUrl) return null;
    const raw = await this.callTool(ctx, 'get_invoice', {
      workspace_id: ctx.workspaceId,
      external_source: externalSource,
      external_ref: externalRef,
    });
    if (!raw) return null;
    return this.toInvoice(raw);
  }

  async getInvoiceById(
    ctx: FederationContext,
    invoiceId: string,
  ): Promise<FederatedInvoice | null> {
    if (!this.baseUrl) return null;
    const raw = await this.callTool(ctx, 'get_invoice', {
      workspace_id: ctx.workspaceId,
      invoice_id: invoiceId,
    });
    if (!raw) return null;
    return this.toInvoice(raw);
  }
}

/**
 * The concrete Outreach federation client.
 *
 * Speaks the campaign / social-touch surface the (future) Outreach APP will
 * expose over MCP. Outreach is NOT built yet — this client is written against a
 * clean, sensible `/mcp`-style contract (informed by the engines' real shapes:
 * Listmonk = lists/campaigns/sends; Postiz = scheduled social posts) so the
 * Outreach app can implement it verbatim, exactly as the Contact-Ops/Accounting-
 * Ops clients were written against those apps' contracts before wiring.
 *
 *   1. MCP — JSON-RPC 2.0 over `POST {OUTREACH_BASE_URL}/mcp`. Outreach resolves
 *      the tenant from the bearer's `workspace_id` claim (re-gated server-side),
 *      never a trusted header. Tools the contract defines:
 *        - list_campaigns(workspace_id)
 *            -> { campaigns: Campaign[] }   (the enroll picker; viewer-level)
 *        - list_touches_for_contact(workspace_id, contact_id)
 *            -> { touches: Touch[] }        (the 360 history; viewer-level)
 *        - enroll_contact(workspace_id, campaign_id, contact_id, contact_email?,
 *            external_source, external_ref, merge_fields?)
 *            -> Enrollment. IDEMPOTENT on (workspace_id, external_source,
 *            external_ref): a repeat returns the EXISTING enrollment, queues NO
 *            second send.
 *        - schedule_social_touch(workspace_id, channel_id, contact_id, body,
 *            scheduled_at?, external_source, external_ref)
 *            -> Enrollment (a Postiz scheduled post). Same idempotency tuple.
 *      Tool-call envelope: result.structuredContent (preferred) | content[0].text.
 *      Application errors come back HTTP 200 with result.isError=true OR a
 *      JSON-RPC `error` — both handled.
 *
 * AUTH: Customer-Ops calls Outreach as a service. The bearer is a federation
 * token carrying the addressed `workspace_id` claim + `aud=outreach`. Minting
 * that token is Brigade's job (RFC-8693 exchange); until that seam is wired this
 * client forwards a configured service token (OUTREACH_SERVICE_TOKEN) and
 * addresses the workspace via the documented precedence (X-Workspace-Id header,
 * which Outreach re-gates against membership). The mint seam is isolated in
 * `authHeaders()` so swapping to Brigade is a one-method change — exactly like
 * the Contact-Ops / Accounting-Ops clients.
 *
 * ENTITLEMENT (binding): triggering outreach (enroll / schedule) requires BOTH
 * `customer-ops` AND `outreach` on the bearer. `checkEntitlement` is the pure
 * gate; the triggers also re-check (defense-in-depth). `UC_ENTITLEMENT_MODE=open`
 * is the pre-Lago bootstrap escape hatch (allow + WARN). READS (list campaigns /
 * touches) are viewer-level — no dual SKU. The suite verb "enforce" == strict
 * claim check; "open" == bootstrap.
 *
 * DEGRADE-CLEAN (binding): when OUTREACH_BASE_URL is unset, `isConfigured()` is
 * false and every method returns empty/null without any fetch. The cockpit then
 * renders the outreach slot as "connect Outreach" and makes no call. This keeps
 * Customer-Ops fully functional without a hard Outreach dependency (the Outreach
 * app doesn't exist yet, plus verification / any node where outreach isn't
 * wired), and is what the tests assert.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutreachPort, FederationContext } from './outreach-ops.port';
import {
  CampaignEnrollment,
  EntitlementDecision,
  OutreachCampaign,
  OutreachChannel,
  OutreachEnrollmentResult,
  OutreachTouch,
  SocialTouchRequest,
} from './outreach-ops.types';

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

/** Canonical suite SKU strings (must match Lago/Keycloak). */
export const SKU_CUSTOMER_OPS = 'customer-ops';
export const SKU_OUTREACH = 'outreach';

/** SKU spelling/alias tolerance — accept whatever shape the upstream claim
 *  eventually lands. Normalized on read only (mirrors the AO client). */
const SKU_ALIASES: Record<string, string> = {
  'customer-ops': SKU_CUSTOMER_OPS,
  customer_ops: SKU_CUSTOMER_OPS,
  customerops: SKU_CUSTOMER_OPS,
  co: SKU_CUSTOMER_OPS,
  outreach: SKU_OUTREACH,
  'outreach-ops': SKU_OUTREACH,
  outreach_ops: SKU_OUTREACH,
  outreachops: SKU_OUTREACH,
};

function normalizeSku(code: string): string {
  const key = (code || '').trim().toLowerCase();
  return SKU_ALIASES[key] ?? key;
}

function channelOf(v: unknown): OutreachChannel {
  return v === 'social' ? 'social' : 'email';
}

@Injectable()
export class OutreachClient extends OutreachPort {
  private readonly logger = new Logger(OutreachClient.name);
  private rpcId = 0;

  constructor(private readonly config: ConfigService) {
    super();
    if (!this.baseUrl) {
      this.logger.warn(
        'OUTREACH_BASE_URL unset — Outreach federation is DORMANT; the ' +
          'customer-360 outreach slot shows "connect Outreach" and no ' +
          'campaign/touch call is made until configured. (The Outreach app is ' +
          'the next track; this seam is mockable + degrade-clean until it lands.)',
      );
    } else {
      this.logger.log(`Outreach federation target: ${this.baseUrl} (mode=${this.mode()})`);
    }
  }

  // --- configuration seam -------------------------------------------------

  private get baseUrl(): string | null {
    const raw = this.config.get<string>('OUTREACH_BASE_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('OUTREACH_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10000;
  }

  /**
   * Entitlement mode. Suite var `UC_ENTITLEMENT_MODE` wins, falling back to an
   * Outreach-specific `OUTREACH_CROSS_APP_ENTITLEMENT_MODE` so one knob can
   * configure the app pair. Maps the suite vocabulary to this gate: "open" =>
   * bootstrap (allow+WARN); anything else (incl. "enforce", the default) =>
   * strict.
   */
  private mode(): 'enforce' | 'open' {
    const raw =
      this.config.get<string>('UC_ENTITLEMENT_MODE') ??
      this.config.get<string>('OUTREACH_CROSS_APP_ENTITLEMENT_MODE') ??
      'enforce';
    return raw.trim().toLowerCase() === 'open' ? 'open' : 'enforce';
  }

  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  /**
   * Build the auth headers for a federation call to Outreach. This is the
   * Brigade token-mint seam: today it forwards a configured service token; the
   * Brigade change swaps in an RFC-8693 exchange minting a per-request token with
   * `aud=outreach` + the addressed `workspace_id` claim. X-Workspace-Id rides
   * along for Outreach's per-request addressing; Outreach re-gates membership
   * server-side, so the header is a hint, never the authz boundary.
   */
  private authHeaders(ctx: FederationContext): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.config.get<string>('OUTREACH_SERVICE_TOKEN');
    if (token && token.trim()) headers['Authorization'] = `Bearer ${token.trim()}`;
    headers['X-Workspace-Id'] = ctx.workspaceId;
    if (ctx.ucUid) headers['X-Uc-Uid'] = ctx.ucUid;
    return headers;
  }

  // --- entitlement gate (pure) -------------------------------------------

  checkEntitlement(ctx: FederationContext): EntitlementDecision {
    const have = new Set((ctx.entitlements ?? []).map(normalizeSku));
    const hasBoth = have.has(SKU_CUSTOMER_OPS) && have.has(SKU_OUTREACH);
    const mode = this.mode();

    if (hasBoth) {
      return {
        allowed: true,
        mode,
        reason: 'entitled: bearer carries both customer-ops and outreach',
      };
    }

    if (mode === 'open') {
      // Pre-Lago bootstrap: allow but log loudly so operators see the gate is
      // running open until the billing claim is wired.
      this.logger.warn(
        `Outreach entitlement gate is OPEN (UC_ENTITLEMENT_MODE=open) — allowing ` +
          `an outreach trigger for workspace=${ctx.workspaceId} WITHOUT the dual ` +
          `customer-ops+outreach SKU check. Set the mode to 'enforce' once Lago ` +
          `emits entitlements.`,
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
        'not entitled: triggering outreach requires a subscription with BOTH ' +
        'customer-ops and outreach; the bearer does not carry both.',
    };
  }

  // --- MCP JSON-RPC transport --------------------------------------------

  /**
   * Invoke one Outreach MCP tool via JSON-RPC `tools/call`. Returns the tool's
   * structuredContent, or null on any transport/application failure (logged).
   * Never throws — federation is best-effort by design; the service surfaces a
   * clean "couldn't reach Outreach" rather than a 500.
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
        headers: this.authHeaders(ctx),
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.warn(`Outreach MCP ${name} transport error: ${(err as Error).message}`);
      return null;
    }

    if (!res.ok) {
      this.logger.warn(`Outreach MCP ${name} HTTP ${res.status}`);
      return null;
    }

    let payload: JsonRpcResponse;
    try {
      payload = (await res.json()) as JsonRpcResponse;
    } catch (err) {
      this.logger.warn(`Outreach MCP ${name} non-JSON response: ${(err as Error).message}`);
      return null;
    }

    if (payload.error) {
      this.logger.warn(`Outreach MCP ${name} JSON-RPC error: ${payload.error.message}`);
      return null;
    }

    const result = payload.result;
    if (!result || result.isError) {
      const text = result?.content?.[0]?.text;
      this.logger.warn(`Outreach MCP ${name} tool error: ${text ?? 'unknown'}`);
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

  // --- mapping: Outreach wire shape -> Customer-Ops federation projection --

  private str(raw: Record<string, unknown>, k: string): string | null {
    const v = raw[k];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }

  private toCampaign(raw: Record<string, unknown>): OutreachCampaign | null {
    const id = raw['id'];
    if (typeof id !== 'string' || !id) return null;
    return {
      id,
      name: this.str(raw, 'name') ?? '(unnamed campaign)',
      channel: channelOf(raw['channel']),
      status: (raw['status'] as string) ?? 'draft',
      isSequence: raw['is_sequence'] === true,
      listId: this.str(raw, 'list_id'),
      createdAt: this.str(raw, 'created_at'),
    };
  }

  private toTouch(raw: Record<string, unknown>): OutreachTouch | null {
    const id = raw['id'];
    if (typeof id !== 'string' || !id) return null;
    const lastKind = this.str(raw, 'last_engagement_kind');
    return {
      id,
      channel: channelOf(raw['channel']),
      campaignId: this.str(raw, 'campaign_id'),
      campaignName: this.str(raw, 'campaign_name'),
      status: (raw['status'] as string) ?? 'queued',
      subject: this.str(raw, 'subject'),
      scheduledAt: this.str(raw, 'scheduled_at'),
      sentAt: this.str(raw, 'sent_at'),
      lastEngagementKind: (lastKind as OutreachTouch['lastEngagementKind']) ?? null,
      lastEngagementAt: this.str(raw, 'last_engagement_at'),
    };
  }

  private toEnrollment(raw: Record<string, unknown>): OutreachEnrollmentResult | null {
    const id = raw['id'];
    if (typeof id !== 'string' || !id) return null;
    return {
      id,
      channel: channelOf(raw['channel']),
      campaignId: this.str(raw, 'campaign_id'),
      campaignName: this.str(raw, 'campaign_name'),
      status: (raw['status'] as string) ?? 'queued',
      externalSource: this.str(raw, 'external_source'),
      externalRef: this.str(raw, 'external_ref'),
      createdAt: this.str(raw, 'created_at'),
    };
  }

  // --- OutreachPort implementation ---------------------------------------

  async listCampaigns(ctx: FederationContext): Promise<OutreachCampaign[]> {
    if (!this.baseUrl) return [];
    const raw = await this.callTool(ctx, 'list_campaigns', { workspace_id: ctx.workspaceId });
    if (!raw) return [];
    const items = Array.isArray(raw['campaigns'])
      ? (raw['campaigns'] as Record<string, unknown>[])
      : [];
    const out: OutreachCampaign[] = [];
    for (const it of items) {
      const c = this.toCampaign(it);
      if (c) out.push(c);
    }
    return out;
  }

  async listTouchesForContact(ctx: FederationContext, contactId: string): Promise<OutreachTouch[]> {
    if (!this.baseUrl) return [];
    const raw = await this.callTool(ctx, 'list_touches_for_contact', {
      workspace_id: ctx.workspaceId,
      contact_id: contactId,
    });
    if (!raw) return [];
    const items = Array.isArray(raw['touches'])
      ? (raw['touches'] as Record<string, unknown>[])
      : [];
    const out: OutreachTouch[] = [];
    for (const it of items) {
      const t = this.toTouch(it);
      if (t) out.push(t);
    }
    return out;
  }

  async enrollContact(
    ctx: FederationContext,
    enrollment: CampaignEnrollment,
  ): Promise<OutreachEnrollmentResult | null> {
    if (!this.baseUrl) return null;
    // Defense-in-depth: the service pre-checks, but never make the call without
    // the dual-SKU gate (or the open bootstrap) passing.
    const gate = this.checkEntitlement(ctx);
    if (!gate.allowed) {
      this.logger.warn(
        `Outreach enrollContact DENIED for workspace=${ctx.workspaceId}: ${gate.reason}`,
      );
      return null;
    }
    const args: Record<string, unknown> = {
      workspace_id: ctx.workspaceId,
      campaign_id: enrollment.campaignId,
      contact_id: enrollment.contactId,
      external_source: enrollment.externalSource,
      external_ref: enrollment.externalRef,
    };
    if (enrollment.contactEmail != null) args['contact_email'] = enrollment.contactEmail;
    if (enrollment.mergeFields != null) args['merge_fields'] = enrollment.mergeFields;

    const raw = await this.callTool(ctx, 'enroll_contact', args);
    if (!raw) return null;
    return this.toEnrollment(raw);
  }

  async scheduleSocialTouch(
    ctx: FederationContext,
    request: SocialTouchRequest,
  ): Promise<OutreachEnrollmentResult | null> {
    if (!this.baseUrl) return null;
    const gate = this.checkEntitlement(ctx);
    if (!gate.allowed) {
      this.logger.warn(
        `Outreach scheduleSocialTouch DENIED for workspace=${ctx.workspaceId}: ${gate.reason}`,
      );
      return null;
    }
    const args: Record<string, unknown> = {
      workspace_id: ctx.workspaceId,
      channel_id: request.channelId,
      contact_id: request.contactId,
      body: request.body,
      external_source: request.externalSource,
      external_ref: request.externalRef,
    };
    if (request.scheduledAt != null) args['scheduled_at'] = request.scheduledAt;

    const raw = await this.callTool(ctx, 'schedule_social_touch', args);
    if (!raw) return null;
    return this.toEnrollment(raw);
  }
}

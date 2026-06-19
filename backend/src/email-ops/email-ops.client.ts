/**
 * The concrete Email-Ops federation client.
 *
 * Speaks the mailbox / thread surface the (future) Email-Ops APP will expose over
 * MCP. Email-Ops is NOT built yet — this client is written against a clean,
 * sensible `/mcp`-style contract (informed by Stalwart's IMAP/JMAP thread shape:
 * threads, messages, send) so the Email-Ops app can implement it verbatim,
 * exactly as the Contact-Ops/Accounting-Ops clients were written against those
 * apps' contracts before wiring.
 *
 *   1. MCP — JSON-RPC 2.0 over `POST {EMAIL_OPS_BASE_URL}/mcp`. Email-Ops
 *      resolves the tenant from the bearer's `workspace_id` claim (re-gated
 *      server-side), never a trusted header. Tools the contract defines:
 *        - list_threads_with_contact(workspace_id, contact_id)
 *            -> { threads: Thread[] }   (the 360 history; viewer-level)
 *        - list_thread_messages(workspace_id, thread_id)
 *            -> { messages: Message[] } (previews only; viewer-level)
 *        - compose_email(workspace_id, contact_id, to_address, subject, body,
 *            mode, in_reply_to_thread_id?, external_source, external_ref)
 *            -> Message. mode='send' queues delivery; mode='draft' stages the
 *            agent-inbox approval surface. IDEMPOTENT on (workspace_id,
 *            external_source, external_ref): a repeat returns the EXISTING
 *            message, queues NO second send.
 *      Tool-call envelope: result.structuredContent (preferred) | content[0].text.
 *      Application errors come back HTTP 200 with result.isError=true OR a
 *      JSON-RPC `error` — both handled.
 *
 * AUTH: Customer-Ops calls Email-Ops as a service. The bearer is a federation
 * token carrying the addressed `workspace_id` claim + `aud=email-ops`. The auth
 * MODE is selectable (mirrors the Contact-Ops / Meeting-Ops clients):
 *   - `static` (default): forward a configured service token (EMAIL_OPS_SERVICE_TOKEN);
 *   - `brigade-sts`: mint a customer-ops client-credentials token and exchange it
 *     at Brigade (RFC-8693) for an `aud=email-ops`, workspace-bound token.
 * The workspace is addressed via the documented precedence (X-Workspace-Id header,
 * which Email-Ops re-gates against membership). The mint seam is isolated in
 * `authHeaders()` / `bearerFor()` so the mode is a one-knob change — exactly like
 * the Contact-Ops / Accounting-Ops clients.
 *
 * ENTITLEMENT (binding): sending/drafting outbound mail requires BOTH
 * `customer-ops` AND `email-ops` on the bearer. `checkEntitlement` is the pure
 * gate; compose also re-checks (defense-in-depth). `UC_ENTITLEMENT_MODE=open` is
 * the pre-Lago bootstrap escape hatch (allow + WARN). READS (list threads /
 * messages) are viewer-level — no dual SKU. The suite verb "enforce" == strict
 * claim check; "open" == bootstrap.
 *
 * DEGRADE-CLEAN (binding): when EMAIL_OPS_BASE_URL is unset, `isConfigured()` is
 * false and every method returns empty/null without any fetch. The cockpit then
 * renders the email slot as "connect Email-Ops" and makes no call. This keeps
 * Customer-Ops fully functional without a hard Email-Ops dependency (the
 * Email-Ops app doesn't exist yet, plus verification / any node where mail isn't
 * wired), and is what the tests assert.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';
import { EmailOpsPort, FederationContext } from './email-ops.port';
import {
  EmailComposeRequest,
  EmailComposeResult,
  EmailMessage,
  EmailParticipant,
  EmailThread,
  EntitlementDecision,
} from './email-ops.types';

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
export const SKU_EMAIL_OPS = 'email-ops';

/** SKU spelling/alias tolerance — accept whatever shape the upstream claim
 *  eventually lands. Normalized on read only (mirrors the AO client). */
const SKU_ALIASES: Record<string, string> = {
  'customer-ops': SKU_CUSTOMER_OPS,
  customer_ops: SKU_CUSTOMER_OPS,
  customerops: SKU_CUSTOMER_OPS,
  co: SKU_CUSTOMER_OPS,
  'email-ops': SKU_EMAIL_OPS,
  email_ops: SKU_EMAIL_OPS,
  emailops: SKU_EMAIL_OPS,
  mail: SKU_EMAIL_OPS,
};

function normalizeSku(code: string): string {
  const key = (code || '').trim().toLowerCase();
  return SKU_ALIASES[key] ?? key;
}

@Injectable()
export class EmailOpsClient extends EmailOpsPort {
  private readonly logger = new Logger(EmailOpsClient.name);
  private rpcId = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly brigade: BrigadeTokenSource,
  ) {
    super();
    if (!this.baseUrl) {
      this.logger.warn(
        'EMAIL_OPS_BASE_URL unset — Email-Ops federation is DORMANT; the ' +
          'customer-360 email slot shows "connect Email-Ops" and no mailbox/send ' +
          'call is made until configured. (The Email-Ops app is the next track; ' +
          'this seam is mockable + degrade-clean until it lands.)',
      );
    } else {
      this.logger.log(
        `Email-Ops federation target: ${this.baseUrl} ` +
          `(entitlement=${this.mode()}, auth=${this.authMode})`,
      );
    }
  }

  // --- configuration seam -------------------------------------------------

  private get baseUrl(): string | null {
    const raw = this.config.get<string>('EMAIL_OPS_BASE_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('EMAIL_OPS_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10000;
  }

  /**
   * Entitlement mode. Suite var `UC_ENTITLEMENT_MODE` wins, falling back to an
   * Email-Ops-specific `EMAIL_OPS_CROSS_APP_ENTITLEMENT_MODE`. Maps the suite
   * vocabulary to this gate: "open" => bootstrap (allow+WARN); anything else
   * (incl. "enforce", the default) => strict.
   */
  private mode(): 'enforce' | 'open' {
    const raw =
      this.config.get<string>('UC_ENTITLEMENT_MODE') ??
      this.config.get<string>('EMAIL_OPS_CROSS_APP_ENTITLEMENT_MODE') ??
      'enforce';
    return raw.trim().toLowerCase() === 'open' ? 'open' : 'enforce';
  }

  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  /**
   * Build the auth headers for a federation call to Email-Ops. This is the
   * Brigade token-mint seam: in `static` mode it forwards a configured service
   * token; in `brigade-sts` mode it mints a per-request token via an RFC-8693
   * exchange with `aud=email-ops` + the addressed `workspace_id` claim.
   * X-Workspace-Id rides along for Email-Ops's per-request addressing; Email-Ops
   * re-gates membership server-side, so the header is a hint, never the authz
   * boundary.
   */
  private async authHeaders(ctx: FederationContext): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const bearer = await this.bearerFor(ctx.workspaceId);
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    headers['X-Workspace-Id'] = ctx.workspaceId;
    if (ctx.ucUid) headers['X-Uc-Uid'] = ctx.ucUid;
    return headers;
  }

  /** The auth mode: `static` forwards EMAIL_OPS_SERVICE_TOKEN (legacy / dev);
   *  `brigade-sts` mints a customer-ops client-credentials token and exchanges it
   *  at Brigade (RFC-8693) for an email-ops-audience, workspace-bound token.
   *  DEFAULT `static` so behavior is unchanged when EMAIL_OPS_AUTH_MODE is unset. */
  private get authMode(): 'static' | 'brigade-sts' {
    return this.config.get<string>('EMAIL_OPS_AUTH_MODE')?.trim() === 'brigade-sts'
      ? 'brigade-sts'
      : 'static';
  }

  /** Resolve the bearer for a federation call (per the auth mode). `static`
   *  forwards EMAIL_OPS_SERVICE_TOKEN; `brigade-sts` delegates to the shared
   *  BrigadeTokenSource (mint customer-ops CC → exchange for aud=email-ops).
   *  Degrade-clean: a failed exchange returns null and the caller sends no bearer. */
  private async bearerFor(workspaceId: string): Promise<string | null> {
    if (this.authMode === 'static') {
      const t = this.config.get<string>('EMAIL_OPS_SERVICE_TOKEN');
      return t && t.trim() ? t.trim() : null;
    }
    return this.brigade.exchangedToken({
      audience: this.config.get<string>('EMAIL_OPS_AUDIENCE')?.trim() || 'email-ops',
      scope: 'mail:read mail:send',
      workspaceId,
    });
  }

  // --- entitlement gate (pure) -------------------------------------------

  checkEntitlement(ctx: FederationContext): EntitlementDecision {
    const have = new Set((ctx.entitlements ?? []).map(normalizeSku));
    const hasBoth = have.has(SKU_CUSTOMER_OPS) && have.has(SKU_EMAIL_OPS);
    const mode = this.mode();

    if (hasBoth) {
      return {
        allowed: true,
        mode,
        reason: 'entitled: bearer carries both customer-ops and email-ops',
      };
    }

    if (mode === 'open') {
      this.logger.warn(
        `Email-Ops entitlement gate is OPEN (UC_ENTITLEMENT_MODE=open) — allowing ` +
          `an outbound mail call for workspace=${ctx.workspaceId} WITHOUT the dual ` +
          `customer-ops+email-ops SKU check. Set the mode to 'enforce' once Lago ` +
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
        'not entitled: sending/drafting mail via Email-Ops requires a ' +
        'subscription with BOTH customer-ops and email-ops; the bearer does not ' +
        'carry both.',
    };
  }

  // --- MCP JSON-RPC transport --------------------------------------------

  /**
   * Invoke one Email-Ops MCP tool via JSON-RPC `tools/call`. Returns the tool's
   * structuredContent, or null on any transport/application failure (logged).
   * Never throws — federation is best-effort by design; the service surfaces a
   * clean "couldn't reach Email-Ops" rather than a 500.
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
      this.logger.warn(`Email-Ops MCP ${name} transport error: ${(err as Error).message}`);
      return null;
    }

    if (!res.ok) {
      this.logger.warn(`Email-Ops MCP ${name} HTTP ${res.status}`);
      return null;
    }

    let payload: JsonRpcResponse;
    try {
      payload = (await res.json()) as JsonRpcResponse;
    } catch (err) {
      this.logger.warn(`Email-Ops MCP ${name} non-JSON response: ${(err as Error).message}`);
      return null;
    }

    if (payload.error) {
      this.logger.warn(`Email-Ops MCP ${name} JSON-RPC error: ${payload.error.message}`);
      return null;
    }

    const result = payload.result;
    if (!result || result.isError) {
      const text = result?.content?.[0]?.text;
      this.logger.warn(`Email-Ops MCP ${name} tool error: ${text ?? 'unknown'}`);
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

  // --- mapping: Email-Ops wire shape -> Customer-Ops federation projection -

  private str(raw: Record<string, unknown>, k: string): string | null {
    const v = raw[k];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }

  private toParticipant(raw: unknown): EmailParticipant | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const address = r['address'];
    if (typeof address !== 'string' || !address) return null;
    return { address, name: typeof r['name'] === 'string' ? (r['name'] as string) : null };
  }

  private toParticipants(raw: unknown): EmailParticipant[] {
    if (!Array.isArray(raw)) return [];
    const out: EmailParticipant[] = [];
    for (const p of raw) {
      const parsed = this.toParticipant(p);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  private toThread(raw: Record<string, unknown>): EmailThread | null {
    const id = raw['id'];
    if (typeof id !== 'string' || !id) return null;
    const count = raw['message_count'];
    return {
      id,
      subject: this.str(raw, 'subject'),
      messageCount: typeof count === 'number' && Number.isFinite(count) ? count : 0,
      unread: raw['unread'] === true,
      lastMessageAt: this.str(raw, 'last_message_at'),
      lastSnippet: this.str(raw, 'last_snippet'),
      participants: this.toParticipants(raw['participants']),
    };
  }

  private toMessage(raw: Record<string, unknown>): EmailMessage | null {
    const id = raw['id'];
    if (typeof id !== 'string' || !id) return null;
    return {
      id,
      threadId: this.str(raw, 'thread_id') ?? '',
      from: this.toParticipant(raw['from']),
      to: this.toParticipants(raw['to']),
      subject: this.str(raw, 'subject'),
      sentAt: this.str(raw, 'sent_at'),
      preview: this.str(raw, 'preview'),
      direction: (raw['direction'] as string) ?? 'received',
    };
  }

  private toComposeResult(raw: Record<string, unknown>): EmailComposeResult | null {
    const id = raw['id'];
    if (typeof id !== 'string' || !id) return null;
    return {
      id,
      threadId: this.str(raw, 'thread_id'),
      status: (raw['status'] as string) ?? 'queued',
      mode: (raw['mode'] as string) ?? 'send',
      externalSource: this.str(raw, 'external_source'),
      externalRef: this.str(raw, 'external_ref'),
      createdAt: this.str(raw, 'created_at'),
    };
  }

  // --- EmailOpsPort implementation ---------------------------------------

  async listThreadsWithContact(ctx: FederationContext, contactId: string): Promise<EmailThread[]> {
    if (!this.baseUrl) return [];
    const raw = await this.callTool(ctx, 'list_threads_with_contact', {
      workspace_id: ctx.workspaceId,
      contact_id: contactId,
    });
    if (!raw) return [];
    const items = Array.isArray(raw['threads'])
      ? (raw['threads'] as Record<string, unknown>[])
      : [];
    const out: EmailThread[] = [];
    for (const it of items) {
      const t = this.toThread(it);
      if (t) out.push(t);
    }
    return out;
  }

  async listThreadMessages(ctx: FederationContext, threadId: string): Promise<EmailMessage[]> {
    if (!this.baseUrl) return [];
    const raw = await this.callTool(ctx, 'list_thread_messages', {
      workspace_id: ctx.workspaceId,
      thread_id: threadId,
    });
    if (!raw) return [];
    const items = Array.isArray(raw['messages'])
      ? (raw['messages'] as Record<string, unknown>[])
      : [];
    const out: EmailMessage[] = [];
    for (const it of items) {
      const m = this.toMessage(it);
      if (m) out.push(m);
    }
    return out;
  }

  async composeEmail(
    ctx: FederationContext,
    request: EmailComposeRequest,
  ): Promise<EmailComposeResult | null> {
    if (!this.baseUrl) return null;
    // Defense-in-depth: the service pre-checks, but never make the call without
    // the dual-SKU gate (or the open bootstrap) passing.
    const gate = this.checkEntitlement(ctx);
    if (!gate.allowed) {
      this.logger.warn(
        `Email-Ops composeEmail DENIED for workspace=${ctx.workspaceId}: ${gate.reason}`,
      );
      return null;
    }
    const args: Record<string, unknown> = {
      workspace_id: ctx.workspaceId,
      contact_id: request.contactId,
      to_address: request.toAddress,
      subject: request.subject,
      body: request.body,
      mode: request.mode,
      external_source: request.externalSource,
      external_ref: request.externalRef,
    };
    if (request.inReplyToThreadId != null) {
      args['in_reply_to_thread_id'] = request.inReplyToThreadId;
    }

    const raw = await this.callTool(ctx, 'compose_email', args);
    if (!raw) return null;
    return this.toComposeResult(raw);
  }
}

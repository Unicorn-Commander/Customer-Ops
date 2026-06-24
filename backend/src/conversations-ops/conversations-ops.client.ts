/**
 * The concrete Conversations-Ops federation client.
 *
 * Speaks the device messaging surface the UUDA/UUDC agent exposes over MCP
 * (Streamable HTTP, JSON-RPC 2.0 at `POST {CONVERSATIONS_OPS_BASE_URL}{MCP_PATH}`,
 * default path `/mcp/v1`). Tools the contract uses:
 *   - messages.list -> { conversations: Conversation[] }  (read; viewer-level)
 *   - messages.send(to, body, service, dry_run) -> { changeSet, serviceUsed }
 * UUDC returns each tool result as the MCP `content[0].text` JSON string; this
 * client parses both that and `structuredContent`, exactly like the Email-Ops
 * client, so the same callTool works against either server.
 *
 * AUTH: the auth MODE mirrors the Email-Ops / Contact-Ops clients —
 *   - `static` (default): forward a configured service token
 *     (CONVERSATIONS_OPS_SERVICE_TOKEN);
 *   - `brigade-sts`: mint a customer-ops client-credentials token and exchange it
 *     at Brigade (RFC-8693) for an addressed, workspace-bound token.
 * (Direct mTLS to a device's :47000 is the eventual transport once the live agent
 * is stood up — a Phase-2b add behind a `mtls` mode; the seam is dormant until
 * then so this v1 ships the bearer transport only.)
 *
 * ENTITLEMENT: sending a message requires `customer-ops` (the worker's own
 * cockpit + device). `checkEntitlement` is the pure gate; send re-checks
 * (defense-in-depth). `UC_ENTITLEMENT_MODE=open` is the pre-Lago bootstrap escape
 * hatch (allow + WARN). READS are viewer-level — no SKU.
 *
 * DEGRADE-CLEAN: when CONVERSATIONS_OPS_BASE_URL is unset, `isConfigured()` is
 * false and every method returns empty/null without any fetch. The cockpit then
 * renders the conversations slot as "connect" and makes no call.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';
import { ConversationsOpsPort, FederationContext } from './conversations-ops.port';
import {
  ConversationSendRequest,
  ConversationSendResult,
  ConversationThread,
  EntitlementDecision,
} from './conversations-ops.types';
import { SeamHealth } from '../health/seam-health';
import { shortBody } from '../health/probe-util';

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

/** Canonical suite SKU string (must match Lago/Keycloak). */
export const SKU_CUSTOMER_OPS = 'customer-ops';

/** SKU spelling/alias tolerance (normalized on read only; mirrors the AO client). */
const SKU_ALIASES: Record<string, string> = {
  'customer-ops': SKU_CUSTOMER_OPS,
  customer_ops: SKU_CUSTOMER_OPS,
  customerops: SKU_CUSTOMER_OPS,
  co: SKU_CUSTOMER_OPS,
};

function normalizeSku(code: string): string {
  const key = (code || '').trim().toLowerCase();
  return SKU_ALIASES[key] ?? key;
}

@Injectable()
export class ConversationsOpsClient extends ConversationsOpsPort {
  private readonly logger = new Logger(ConversationsOpsClient.name);
  private rpcId = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly brigade: BrigadeTokenSource,
  ) {
    super();
    if (!this.baseUrl) {
      this.logger.warn(
        'CONVERSATIONS_OPS_BASE_URL unset — the device messaging seam is DORMANT; ' +
          'the customer-360 conversations slot shows "connect" and no device ' +
          'message call is made until configured. (The UUDC agent + live transport ' +
          'is the next track; this seam is mockable + degrade-clean until it lands.)',
      );
    } else {
      this.logger.log(
        `Conversations federation target: ${this.baseUrl}${this.mcpPath} ` +
          `(entitlement=${this.mode()}, auth=${this.authMode})`,
      );
    }
  }

  // --- configuration seam -------------------------------------------------

  private get baseUrl(): string | null {
    const raw = this.config.get<string>('CONVERSATIONS_OPS_BASE_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  /** The MCP path on the device agent (UUDC serves Streamable HTTP at /mcp/v1). */
  private get mcpPath(): string {
    const raw = this.config.get<string>('CONVERSATIONS_OPS_MCP_PATH');
    const p = raw && raw.trim() ? raw.trim() : '/mcp/v1';
    return p.startsWith('/') ? p : `/${p}`;
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('CONVERSATIONS_OPS_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10000;
  }

  /** Entitlement mode. Suite var `UC_ENTITLEMENT_MODE` wins, falling back to a
   *  seam-specific `CONVERSATIONS_OPS_CROSS_APP_ENTITLEMENT_MODE`. "open" =>
   *  bootstrap (allow+WARN); anything else (incl. "enforce", the default) => strict. */
  private mode(): 'enforce' | 'open' {
    const raw =
      this.config.get<string>('UC_ENTITLEMENT_MODE') ??
      this.config.get<string>('CONVERSATIONS_OPS_CROSS_APP_ENTITLEMENT_MODE') ??
      'enforce';
    return raw.trim().toLowerCase() === 'open' ? 'open' : 'enforce';
  }

  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  /** Build the auth headers for a federation call. `static` forwards a configured
   *  service token; `brigade-sts` mints a per-request RFC-8693 token. X-Workspace-Id
   *  rides along (the device ignores it; a gateway re-gates server-side). */
  private async authHeaders(ctx: FederationContext): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // UUDC's MCP is Streamable HTTP — it 406s unless the client accepts BOTH.
      Accept: 'application/json, text/event-stream',
    };
    const ws = this.effectiveWorkspaceId(ctx);
    const bearer = await this.bearerFor(ws);
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    headers['X-Workspace-Id'] = ws;
    if (ctx.ucUid) headers['X-Uc-Uid'] = ctx.ucUid;
    return headers;
  }

  private get workspaceOverride(): string | null {
    const w = this.config.get<string>('CONVERSATIONS_OPS_WORKSPACE_OVERRIDE');
    return w && w.trim() ? w.trim() : null;
  }

  private effectiveWorkspaceId(ctx: FederationContext): string {
    return this.workspaceOverride ?? ctx.workspaceId;
  }

  /** `static` forwards CONVERSATIONS_OPS_SERVICE_TOKEN; `brigade-sts` mints a
   *  customer-ops CC token and exchanges it (RFC-8693). DEFAULT `static`. */
  private get authMode(): 'static' | 'brigade-sts' {
    return this.config.get<string>('CONVERSATIONS_OPS_AUTH_MODE')?.trim() === 'brigade-sts'
      ? 'brigade-sts'
      : 'static';
  }

  private async bearerFor(workspaceId: string): Promise<string | null> {
    if (this.authMode === 'static') {
      const t = this.config.get<string>('CONVERSATIONS_OPS_SERVICE_TOKEN');
      return t && t.trim() ? t.trim() : null;
    }
    return this.brigade.exchangedToken({
      audience: this.config.get<string>('CONVERSATIONS_OPS_AUDIENCE')?.trim() || 'uuda',
      scope: 'messages:read messages:send',
      workspaceId,
    });
  }

  // --- entitlement gate (pure) -------------------------------------------

  checkEntitlement(ctx: FederationContext): EntitlementDecision {
    const have = new Set((ctx.entitlements ?? []).map(normalizeSku));
    const mode = this.mode();

    if (have.has(SKU_CUSTOMER_OPS)) {
      return { allowed: true, mode, reason: 'entitled: bearer carries customer-ops' };
    }

    if (mode === 'open') {
      this.logger.warn(
        `Conversations entitlement gate is OPEN (UC_ENTITLEMENT_MODE=open) — allowing ` +
          `a device send for workspace=${ctx.workspaceId} WITHOUT the customer-ops SKU ` +
          `check. Set the mode to 'enforce' once Lago emits entitlements.`,
      );
      return {
        allowed: true,
        mode,
        reason: 'open bootstrap: SKU check bypassed (UC_ENTITLEMENT_MODE=open)',
      };
    }

    return {
      allowed: false,
      mode,
      reason:
        'not entitled: sending a message via the device bridge requires a ' +
        'subscription with customer-ops; the bearer does not carry it.',
    };
  }

  // --- MCP JSON-RPC transport --------------------------------------------

  /** Invoke one MCP tool via JSON-RPC `tools/call`. Returns the tool's
   *  structuredContent (or parsed content text), or null on any failure (logged).
   *  Never throws — federation is best-effort by design. */
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
      res = await this.fetchWithTimeout(`${base}${this.mcpPath}`, {
        method: 'POST',
        headers: await this.authHeaders(ctx),
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.warn(`Conversations MCP ${name} transport error: ${(err as Error).message}`);
      return null;
    }

    if (!res.ok) {
      this.logger.warn(`Conversations MCP ${name} HTTP ${res.status}`);
      return null;
    }

    const payload = this.parseRpc(await res.text());
    if (!payload) {
      this.logger.warn(`Conversations MCP ${name} unparseable response`);
      return null;
    }

    if (payload.error) {
      this.logger.warn(`Conversations MCP ${name} JSON-RPC error: ${payload.error.message}`);
      return null;
    }

    const result = payload.result;
    if (!result || result.isError) {
      const text = result?.content?.[0]?.text;
      this.logger.warn(`Conversations MCP ${name} tool error: ${text ?? 'unknown'}`);
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

  /** Parse a JSON-RPC response that may arrive as plain JSON OR an SSE frame. */
  private parseRpc(raw: string): JsonRpcResponse | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      const dataLines = trimmed
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      const last = dataLines[dataLines.length - 1];
      if (!last) return null;
      try {
        return JSON.parse(last) as JsonRpcResponse;
      } catch {
        return null;
      }
    }
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

  // --- health probe ------------------------------------------------------

  async ping(): Promise<SeamHealth> {
    const seam = 'conversations-ops';
    if (!this.isConfigured()) {
      return { seam, configured: false, ok: false, status: null, detail: 'not-configured', latencyMs: null };
    }
    const base = this.baseUrl as string;
    const ws = this.workspaceOverride ?? this.config.get<string>('HEALTH_PROBE_WORKSPACE_ID') ?? '';
    const ctx: FederationContext = { workspaceId: ws, ucUid: null, entitlements: [] };
    const body = { jsonrpc: '2.0', id: ++this.rpcId, method: 'tools/list', params: {} };

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${base}${this.mcpPath}`, {
        method: 'POST',
        headers: await this.authHeaders(ctx),
        body: JSON.stringify(body),
      });
    } catch (err) {
      return {
        seam,
        configured: true,
        ok: false,
        status: null,
        detail: `unreachable: ${(err as Error).message}`,
        latencyMs: Date.now() - startedAt,
      };
    }
    const latencyMs = Date.now() - startedAt;
    if (res.status === 200) {
      return { seam, configured: true, ok: true, status: 200, detail: 'ok', latencyMs };
    }
    const detail =
      res.status === 401 || res.status === 403
        ? `auth-error: ${await shortBody(res)}`
        : `unreachable: HTTP ${res.status} ${await shortBody(res)}`.trim();
    return { seam, configured: true, ok: false, status: res.status, detail, latencyMs };
  }

  // --- mapping: UUDC wire shape -> Customer-Ops federation projection -----

  /** First non-empty string among the given keys (camelCase + snake_case tolerant
   *  — pbjson emits camelCase, but be robust to either). */
  private str(raw: Record<string, unknown>, ...keys: string[]): string | null {
    for (const k of keys) {
      const v = raw[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  }

  /** Normalize a handle for matching: emails lowercased; phones reduced to digits. */
  private normHandle(h: string): string {
    const s = (h || '').trim().toLowerCase();
    if (s.includes('@')) return s;
    return s.replace(/[^0-9]/g, '');
  }

  private toThread(raw: Record<string, unknown>): ConversationThread | null {
    const chatId = this.str(raw, 'chatIdentifier', 'chat_identifier');
    if (!chatId) return null;
    const last = (raw['lastMessage'] ?? raw['last_message']) as Record<string, unknown> | undefined;
    const channel =
      this.str(raw, 'service') ?? (last ? this.str(last, 'service') : null) ?? 'iMessage';
    return {
      id: chatId,
      handle: chatId,
      channel,
      displayName: this.str(raw, 'displayName', 'display_name'),
      lastMessageAt:
        this.str(raw, 'lastActivity', 'last_activity') ?? (last ? this.str(last, 'at') : null),
      lastSnippet: last ? this.str(last, 'text') : null,
      lastFromMe: last ? last['fromMe'] === true || last['from_me'] === true : false,
    };
  }

  // --- ConversationsOpsPort implementation -------------------------------

  async listConversationsForContact(
    ctx: FederationContext,
    handles: string[],
  ): Promise<ConversationThread[]> {
    if (!this.baseUrl || handles.length === 0) return [];
    const wanted = new Set(handles.map((h) => this.normHandle(h)).filter((h) => h.length > 0));
    if (wanted.size === 0) return [];

    const raw = await this.callTool(ctx, 'messages.list', { limit: 200 });
    if (!raw) return [];
    const items = Array.isArray(raw['conversations'])
      ? (raw['conversations'] as Record<string, unknown>[])
      : [];

    const out: ConversationThread[] = [];
    for (const it of items) {
      const t = this.toThread(it);
      if (!t) continue;
      if (!wanted.has(this.normHandle(t.handle))) continue;
      out.push(t);
    }
    // newest first (ISO-8601 sorts lexically)
    out.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
    return out;
  }

  async sendMessage(
    ctx: FederationContext,
    request: ConversationSendRequest,
  ): Promise<ConversationSendResult | null> {
    if (!this.baseUrl) return null;
    // Defense-in-depth: the service pre-checks, but never send without the gate.
    const gate = this.checkEntitlement(ctx);
    if (!gate.allowed) {
      this.logger.warn(
        `Conversations sendMessage DENIED for workspace=${ctx.workspaceId}: ${gate.reason}`,
      );
      return null;
    }
    const raw = await this.callTool(ctx, 'messages.send', {
      to: request.to,
      body: request.body,
      service: request.channel ?? '',
      dry_run: false,
    });
    if (!raw) return null;
    const cs = (raw['changeSet'] ?? raw['change_set']) as Record<string, unknown> | undefined;
    const applied = cs ? cs['applied'] === true : false;
    const channel = this.str(raw, 'serviceUsed', 'service_used') ?? (request.channel || 'iMessage');
    return { applied, channel };
  }
}

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
 * TRANSPORT (CONVERSATIONS_OPS_TRANSPORT):
 *   - `http` (default): plain HTTPS to a gateway that terminates the device's mTLS
 *     and re-gates the forwarded bearer. Use this once the control-plane MCP gateway
 *     is stood up.
 *   - `mtls`: connect DIRECTLY to a device's :47000 over the tailnet. The UUDC agent
 *     serves mTLS and REQUIRES a client certificate (WebPkiClientVerifier), so a
 *     bearer alone can never reach it — this mode presents a client cert/key (+CA)
 *     and is the only path to a real device until the gateway exists. Materials come
 *     from CONVERSATIONS_OPS_CLIENT_CERT / _CLIENT_KEY / _CA_CERT (each either inline
 *     PEM or a file path); CONVERSATIONS_OPS_TLS_SERVERNAME overrides the verified
 *     hostname when the base URL targets a tailnet IP. TLS verification stays ON.
 *
 * AUTH (the bearer MODE, orthogonal to transport — a gateway still checks it):
 *   - `static` (default): forward a configured service token
 *     (CONVERSATIONS_OPS_SERVICE_TOKEN);
 *   - `brigade-sts`: mint a customer-ops client-credentials token and exchange it
 *     at Brigade (RFC-8693) for an addressed, workspace-bound token.
 * In pure `mtls` direct-to-device mode the client cert IS the auth (the agent has no
 * bearer middleware), so a bearer is optional there.
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

import * as https from 'node:https';
import * as fs from 'node:fs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';
import { ConversationsOpsPort, FederationContext } from './conversations-ops.port';
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

/** Default channels when CONVERSATIONS_OPS_CHANNELS is unset. */
const DEFAULT_CHANNELS: DeviceChannel[] = ['iMessage', 'SMS'];

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

/** Transport-agnostic HTTP response shape (fetch and node:https normalize to this). */
interface PostResponse {
  ok: boolean;
  status: number;
  text: string;
}

/** Loaded mTLS client material for direct-to-device reach. */
interface MtlsMaterial {
  cert: string;
  key: string;
  ca?: string;
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
    } else if (this.transport === 'mtls' && this.mtlsMaterial() === null) {
      this.logger.error(
        `CONVERSATIONS_OPS_TRANSPORT=mtls but client cert/key are missing or unreadable — ` +
          `the device messaging seam is DORMANT (no direct-to-device reach). Set ` +
          `CONVERSATIONS_OPS_CLIENT_CERT and _CLIENT_KEY (inline PEM or a path).`,
      );
    } else {
      this.logger.log(
        `Conversations federation target: ${this.baseUrl}${this.mcpPath} ` +
          `(transport=${this.transport}, entitlement=${this.mode()}, auth=${this.authMode})`,
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
    if (this.baseUrl === null) return false;
    // mtls direct-to-device is only usable with client material in hand.
    if (this.transport === 'mtls') return this.mtlsMaterial() !== null;
    return true;
  }

  /**
   * Parse a comma/space-separated channel list into canonical DeviceChannel[].
   * Accepts imessage/iMessage/sms/SMS. Unknown tokens are dropped.
   */
  private parseChannels(
    raw: string | undefined | null,
    fallback: DeviceChannel[],
  ): DeviceChannel[] {
    if (!raw || !raw.trim()) return [...fallback];
    const out: DeviceChannel[] = [];
    for (const token of raw.split(/[,\s]+/)) {
      const t = token.trim().toLowerCase();
      if (!t) continue;
      if (t === 'imessage' || t === 'i-message' || t === 'imsg') {
        if (!out.includes('iMessage')) out.push('iMessage');
      } else if (t === 'sms' || t === 'text' || t === 'rcs') {
        if (!out.includes('SMS')) out.push('SMS');
      }
    }
    return out.length > 0 ? out : [...fallback];
  }

  /** Channels allowed to surface on the cockpit (reads + dry-run compose). */
  enabledChannels(): DeviceChannel[] {
    return this.parseChannels(
      this.config.get<string>('CONVERSATIONS_OPS_CHANNELS'),
      DEFAULT_CHANNELS,
    );
  }

  /** Channels allowed to leave dry-run when LIVE_SEND_ENABLED=true. */
  private liveSendChannels(): DeviceChannel[] {
    const enabled = this.enabledChannels();
    const raw = this.config.get<string>('CONVERSATIONS_OPS_LIVE_SEND_CHANNELS');
    // Unset ⇒ inherit enabled channels (so flipping LIVE_SEND_ENABLED alone works).
    if (!raw || !raw.trim()) return enabled;
    return this.parseChannels(raw, enabled).filter((c) => enabled.includes(c));
  }

  /** Workspace allowlist (empty = all workspaces once the bridge is configured). */
  private workspaceAllowlist(): string[] {
    const raw = this.config.get<string>('CONVERSATIONS_OPS_WORKSPACE_ALLOWLIST');
    if (!raw || !raw.trim()) return [];
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  isWorkspaceAllowed(workspaceId: string): boolean {
    const list = this.workspaceAllowlist();
    if (list.length === 0) return true;
    return list.includes(workspaceId);
  }

  /** Normalize channel name for comparisons. */
  private canonChannel(channel: string | undefined | null): DeviceChannel | null {
    if (!channel) return null;
    const t = channel.trim().toLowerCase();
    if (t === 'imessage' || t === 'i-message' || t === 'imsg') return 'iMessage';
    if (t === 'sms' || t === 'text' || t === 'rcs') return 'SMS';
    // UUDC sometimes reports "iMessage" / "SMS" already — pass through.
    if (channel === 'iMessage' || channel === 'SMS') return channel;
    return null;
  }

  isChannelEnabled(channel: string): boolean {
    const c = this.canonChannel(channel);
    if (!c) {
      // Empty/auto channel: allowed if ANY device channel is enabled.
      if (!channel || !channel.trim()) return this.enabledChannels().length > 0;
      return false;
    }
    return this.enabledChannels().includes(c);
  }

  isLiveSendEnabledFor(channel: string): boolean {
    const master =
      this.config.get<string>('CONVERSATIONS_OPS_LIVE_SEND_ENABLED')?.trim().toLowerCase() ===
      'true';
    if (!master) return false;
    const c = this.canonChannel(channel) ?? 'iMessage'; // auto defaults to iMessage lane
    return this.liveSendChannels().includes(c);
  }

  activation(): DeviceMessagingActivation {
    const bridgeConfigured = this.isConfigured();
    const enabledChannels = this.enabledChannels();
    const liveSendEnabled =
      this.config.get<string>('CONVERSATIONS_OPS_LIVE_SEND_ENABLED')?.trim().toLowerCase() ===
      'true';
    const liveSendChannels = this.liveSendChannels();
    const workspaceAllowlist = this.workspaceAllowlist();
    const blockers: string[] = [];

    if (!this.baseUrl) {
      blockers.push('CONVERSATIONS_OPS_BASE_URL unset (device bridge dormant)');
    } else if (this.transport === 'mtls' && this.mtlsMaterial() === null) {
      blockers.push(
        'CONVERSATIONS_OPS_TRANSPORT=mtls requires CONVERSATIONS_OPS_CLIENT_CERT + _CLIENT_KEY (or paths)',
      );
    }
    if (enabledChannels.length === 0) {
      blockers.push('CONVERSATIONS_OPS_CHANNELS empty/unknown — no device channel enabled');
    }
    if (!liveSendEnabled) {
      blockers.push(
        'CONVERSATIONS_OPS_LIVE_SEND_ENABLED≠true — outbound is dry-run only (Aaron checkpoint required before live dogfood sends)',
      );
    }
    if (workspaceAllowlist.length > 0) {
      blockers.push(
        `CONVERSATIONS_OPS_WORKSPACE_ALLOWLIST restricts to ${workspaceAllowlist.length} workspace(s) (dogfood gate)`,
      );
    }
    // iMessage reliability posture always documented as a soft blocker until proven.
    if (enabledChannels.includes('iMessage') && bridgeConfigured) {
      blockers.push(
        'iMessage depends on a signed-in Apple ID + continuous UUDC device/relay availability (hardware/relay reliability)',
      );
    }
    if (enabledChannels.includes('SMS') && bridgeConfigured && !liveSendEnabled) {
      blockers.push(
        'Device SMS uses Continuity/iPhone Personal Hotspot path via UUDC; enterprise shared-line SMS is Email-Ops/Twilio (separate lane)',
      );
    }

    return {
      bridgeConfigured,
      liveSendEnabled,
      enabledChannels,
      liveSendChannels,
      workspaceAllowlist,
      blockers,
    };
  }

  /** Transport selector. `mtls` = connect directly to a device's :47000 (the agent
   *  requires a client cert); `http` (default) = plain HTTPS to a gateway. */
  private get transport(): 'http' | 'mtls' {
    return this.config.get<string>('CONVERSATIONS_OPS_TRANSPORT')?.trim().toLowerCase() === 'mtls'
      ? 'mtls'
      : 'http';
  }

  /** Override the TLS-verified hostname (SNI) — needed when the base URL targets a
   *  tailnet IP but the device cert is issued for a name. Null = verify the URL host. */
  private get tlsServerName(): string | null {
    const s = this.config.get<string>('CONVERSATIONS_OPS_TLS_SERVERNAME');
    return s && s.trim() ? s.trim() : null;
  }

  private mtlsCache: MtlsMaterial | null | undefined;

  /** Resolve a cert/key/ca env value that is EITHER inline PEM or a file path.
   *  Returns null if unset or (for a path) unreadable. */
  private resolvePem(varName: string): string | null {
    const raw = this.config.get<string>(varName);
    const v = raw && raw.trim() ? raw.trim() : null;
    if (!v) return null;
    if (v.includes('-----BEGIN')) return v; // inline PEM
    try {
      return fs.readFileSync(v, 'utf8');
    } catch (err) {
      this.logger.warn(`${varName}: could not read PEM at "${v}": ${(err as Error).message}`);
      return null;
    }
  }

  /** Load (once) the mTLS client material. cert+key are mandatory; ca is optional
   *  (falls back to the system trust store). Returns null if cert or key is missing. */
  private mtlsMaterial(): MtlsMaterial | null {
    if (this.mtlsCache !== undefined) return this.mtlsCache;
    const cert = this.resolvePem('CONVERSATIONS_OPS_CLIENT_CERT');
    const key = this.resolvePem('CONVERSATIONS_OPS_CLIENT_KEY');
    const ca = this.resolvePem('CONVERSATIONS_OPS_CA_CERT') ?? undefined;
    this.mtlsCache = cert && key ? { cert, key, ca } : null;
    return this.mtlsCache;
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

    let res: PostResponse;
    try {
      res = await this.post(
        `${base}${this.mcpPath}`,
        await this.authHeaders(ctx),
        JSON.stringify(body),
      );
    } catch (err) {
      this.logger.warn(`Conversations MCP ${name} transport error: ${(err as Error).message}`);
      return null;
    }

    if (!res.ok) {
      this.logger.warn(`Conversations MCP ${name} HTTP ${res.status}`);
      return null;
    }

    const payload = this.parseRpc(res.text);
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

  /** POST a JSON body over the configured transport, normalized to {ok,status,text}.
   *  Routes to direct-device mTLS (node:https) or the gateway (fetch). May throw on a
   *  transport error — callers catch. */
  private async post(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<PostResponse> {
    if (this.transport === 'mtls') return this.postMtls(url, headers, body);
    const res = await this.fetchWithTimeout(url, { method: 'POST', headers, body });
    return { ok: res.ok, status: res.status, text: await res.text() };
  }

  /** Direct mTLS POST to a device's :47000. Presents the client cert; TLS verification
   *  stays on (system trust + optional CA), with an optional servername override. */
  private postMtls(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<PostResponse> {
    const mat = this.mtlsMaterial();
    if (!mat)
      return Promise.reject(new Error('mtls transport selected but client material is missing'));
    const u = new URL(url);
    const payload = Buffer.from(body, 'utf8');
    return new Promise<PostResponse>((resolve, reject) => {
      const req = https.request(
        {
          method: 'POST',
          hostname: u.hostname,
          port: u.port || 443,
          path: `${u.pathname}${u.search}`,
          headers: { ...headers, 'Content-Length': payload.byteLength },
          cert: mat.cert,
          key: mat.key,
          ca: mat.ca,
          servername: this.tlsServerName ?? undefined,
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              text: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      req.on('timeout', () =>
        req.destroy(new Error(`mtls request timeout after ${this.timeoutMs}ms`)),
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // --- health probe ------------------------------------------------------

  async ping(): Promise<SeamHealth> {
    const seam = 'conversations-ops';
    if (!this.isConfigured()) {
      return {
        seam,
        configured: false,
        ok: false,
        status: null,
        detail: 'not-configured',
        latencyMs: null,
      };
    }
    const base = this.baseUrl as string;
    const ws = this.workspaceOverride ?? this.config.get<string>('HEALTH_PROBE_WORKSPACE_ID') ?? '';
    const ctx: FederationContext = { workspaceId: ws, ucUid: null, entitlements: [] };
    const body = { jsonrpc: '2.0', id: ++this.rpcId, method: 'tools/list', params: {} };

    const startedAt = Date.now();
    let res: PostResponse;
    try {
      res = await this.post(
        `${base}${this.mcpPath}`,
        await this.authHeaders(ctx),
        JSON.stringify(body),
      );
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
    const snippet = res.text.replace(/\s+/g, ' ').trim().slice(0, 200);
    const detail =
      res.status === 401 || res.status === 403
        ? `auth-error: ${snippet}`
        : `unreachable: HTTP ${res.status} ${snippet}`.trim();
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

  private toMessage(raw: Record<string, unknown>): ConversationMessage | null {
    const id = this.str(raw, 'id', 'rowid', 'guid') ?? null;
    if (!id) return null;
    const channel = this.str(raw, 'service', 'channel') ?? 'iMessage';
    return {
      id,
      at: this.str(raw, 'at', 'date', 'sentAt', 'sent_at'),
      fromMe: raw['fromMe'] === true || raw['from_me'] === true,
      sender: this.str(raw, 'sender', 'handle') ?? '',
      text: this.str(raw, 'text', 'body', 'preview') ?? '',
      channel,
      hasAttachments:
        raw['hasAttachments'] === true ||
        raw['has_attachments'] === true ||
        (Array.isArray(raw['attachments']) && (raw['attachments'] as unknown[]).length > 0),
    };
  }

  async listConversationsForContact(
    ctx: FederationContext,
    handles: string[],
  ): Promise<ConversationThread[]> {
    if (!this.isConfigured() || handles.length === 0) return [];
    if (!this.isWorkspaceAllowed(ctx.workspaceId)) {
      this.logger.debug(
        `listConversationsForContact: workspace ${ctx.workspaceId} not in CONVERSATIONS_OPS_WORKSPACE_ALLOWLIST`,
      );
      return [];
    }
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
      // Filter to channels enabled for this deployment.
      if (!this.isChannelEnabled(t.channel)) continue;
      out.push(t);
    }
    // newest first (ISO-8601 sorts lexically)
    out.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
    return out;
  }

  async listMessagesInConversation(
    ctx: FederationContext,
    chatIdentifier: string,
  ): Promise<ConversationMessage[]> {
    if (!this.isConfigured()) return [];
    if (!this.isWorkspaceAllowed(ctx.workspaceId)) return [];
    const id = (chatIdentifier || '').trim();
    if (!id) return [];

    const raw = await this.callTool(ctx, 'messages.thread', {
      chat_identifier: id,
      chatIdentifier: id,
      limit: 200,
    });
    if (!raw) return [];
    const items = Array.isArray(raw['messages'])
      ? (raw['messages'] as Record<string, unknown>[])
      : Array.isArray(raw['items'])
        ? (raw['items'] as Record<string, unknown>[])
        : [];

    const out: ConversationMessage[] = [];
    for (const it of items) {
      const m = this.toMessage(it);
      if (!m) continue;
      if (!this.isChannelEnabled(m.channel)) continue;
      out.push(m);
    }
    // chronological (oldest first) for a conversation pane
    out.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
    return out;
  }

  async sendMessage(
    ctx: FederationContext,
    request: ConversationSendRequest,
  ): Promise<ConversationSendResult | null> {
    if (!this.isConfigured()) return null;
    if (!this.isWorkspaceAllowed(ctx.workspaceId)) {
      this.logger.warn(
        `Conversations sendMessage DENIED for workspace=${ctx.workspaceId}: not in CONVERSATIONS_OPS_WORKSPACE_ALLOWLIST`,
      );
      return null;
    }
    // Defense-in-depth: the service pre-checks, but never send without the gate.
    const gate = this.checkEntitlement(ctx);
    if (!gate.allowed) {
      this.logger.warn(
        `Conversations sendMessage DENIED for workspace=${ctx.workspaceId}: ${gate.reason}`,
      );
      return null;
    }
    const requestedChannel = request.channel ?? '';
    if (!this.isChannelEnabled(requestedChannel || 'iMessage')) {
      this.logger.warn(
        `Conversations sendMessage DENIED for workspace=${ctx.workspaceId}: channel ` +
          `'${requestedChannel || '(auto)'}' not in CONVERSATIONS_OPS_CHANNELS`,
      );
      return null;
    }

    // Activating the read-side bridge must never implicitly activate outbound
    // messaging. Operators opt in per-channel after proving a dogfood target.
    // Aaron-attended checkpoint before LIVE_SEND_ENABLED=true on any real path.
    const dryRun = !this.isLiveSendEnabledFor(requestedChannel || 'iMessage');

    // LIVE sends pin `service` to the canonical channel spelling. A blank
    // service means device auto-fallback (iMessage → SMS): when LIVE_SEND is
    // authorized for only a strict subset of the device channels, auto could
    // deliver LIVE on a channel that never left dry-run (e.g.
    // LIVE_SEND_CHANNELS=imessage + channel omitted ⇒ live SMS via fallback).
    // Refuse blank service in that posture instead of letting the device decide.
    let service = requestedChannel;
    if (!dryRun) {
      const canon = this.canonChannel(requestedChannel);
      if (canon) {
        service = canon;
      } else {
        const live = this.liveSendChannels();
        const strictSubset = DEFAULT_CHANNELS.some((c) => !live.includes(c));
        if (strictSubset) {
          this.logger.warn(
            `Conversations sendMessage DENIED for workspace=${ctx.workspaceId}: blank/auto ` +
              `service on a LIVE send while only [${live.join(', ')}] may leave dry-run — ` +
              `device auto-fallback could deliver on an unauthorized channel. ` +
              `Pass an explicit channel.`,
          );
          return null;
        }
      }
    }

    const raw = await this.callTool(ctx, 'messages.send', {
      to: request.to,
      body: request.body,
      service,
      dry_run: dryRun,
      // Idempotency key travels as external_ref for bridge-side dedupe if supported.
      external_ref: request.externalRef,
    });
    if (!raw) return null;
    const cs = (raw['changeSet'] ?? raw['change_set']) as Record<string, unknown> | undefined;
    const applied = cs ? cs['applied'] === true : false;
    const channel =
      this.str(raw, 'serviceUsed', 'service_used') ?? (requestedChannel || 'iMessage');
    return { applied, channel, dryRun };
  }
}

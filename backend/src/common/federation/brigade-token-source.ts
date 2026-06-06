/**
 * BrigadeTokenSource — the shared app-to-app federation credential.
 *
 * One implementation of the RFC-8693 chain every federation client uses
 * (Contact-Ops, Meeting-Ops, and Accounting-Ops/Outreach/Email-Ops as they come
 * online), so the mint + exchange + caching lives in exactly one place:
 *
 *   1. Mint a customer-ops `client_credentials` token at uchub Keycloak (the
 *      subject token; cached process-wide by exp — it is audience-agnostic).
 *   2. Exchange it at Brigade's RFC-8693 endpoint for a fresh token bound to ONE
 *      target app (`aud=<audience>`) + the addressed `workspace_id` + the
 *      requested least-privilege scopes (cached per audience+workspace by exp).
 *
 * Each client decides its own auth MODE (static service token vs brigade-sts) and
 * supplies its own audience/scope/workspace; this service owns only the brigade-sts
 * credential mechanics. Degrade-clean: every failure returns null (the caller then
 * makes no federated call and the cockpit renders the "connect <app>" affordance).
 * Proven live 2026-06-05 (customer-ops → Brigade → Contact-Ops upsert_person).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface CachedToken {
  token: string;
  expMs: number;
}

/** What a client asks for when it needs a federated bearer. */
export interface ExchangeRequest {
  /** Target app id — the minted token's `aud` (e.g. 'contact-ops'). */
  audience: string;
  /** Space-separated least-privilege scopes (e.g. 'contacts:read contacts:write'). */
  scope: string;
  /** The uc-registry workspace id to address (the minted `workspace_id` claim). */
  workspaceId: string;
}

@Injectable()
export class BrigadeTokenSource {
  private readonly logger = new Logger(BrigadeTokenSource.name);
  /** `cc:subject` = the shared client-credentials subject; `<aud>:<ws>` = an
   *  exchanged per-target token. All refreshed ~30s before exp. */
  private readonly cache = new Map<string, CachedToken>();

  constructor(private readonly config: ConfigService) {}

  /**
   * A Brigade-minted, audience-bound bearer for the request, or null if the
   * chain can't complete (Keycloak/Brigade unreachable, secret unset). Never
   * throws.
   */
  async exchangedToken(req: ExchangeRequest): Promise<string | null> {
    const key = `${req.audience}:${req.workspaceId}`;
    const hit = this.cache.get(key);
    if (hit && hit.expMs - 30_000 > Date.now()) return hit.token;

    const subject = await this.clientCredentialsSubject(req.scope);
    if (!subject) return null;

    const exchangeUrl =
      this.config.get<string>('BRIGADE_EXCHANGE_URL')?.trim() ||
      'https://brigade.unicorncommander.ai/api/v1/federation/token';
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: subject,
      audience: req.audience,
      scope: req.scope,
      workspace_id: req.workspaceId,
    });
    const tok = await this.postForm(exchangeUrl, body, `Brigade exchange (aud=${req.audience})`);
    if (!tok) return null;
    this.cache.set(key, tok);
    return tok.token;
  }

  /** The customer-ops client-credentials subject token, cached by exp. The scope
   *  is requested on the subject too so the exchange's least-privilege
   *  intersection (requested ∩ subject) can grant it.
   *
   *  The cache key MUST include the scope: contacts:* are KC *optional* scopes
   *  (present only when requested) while meetings:read is a *default* scope
   *  (always present). A scope-agnostic key would let a meetings:read-only
   *  subject (minted by the Meeting-Ops path) satisfy a later contacts:write
   *  exchange, whose requested ∩ subject = ∅ → Brigade 403 → the lead→contact
   *  write silently no-ops. Keying by scope gives each path its own subject. */
  private async clientCredentialsSubject(scope: string): Promise<string | null> {
    const key = `cc:subject:${scope}`;
    const hit = this.cache.get(key);
    if (hit && hit.expMs - 30_000 > Date.now()) return hit.token;

    const base = (this.config.get<string>('KEYCLOAK_URL') || '').replace(/\/$/, '');
    const realm = this.config.get<string>('KEYCLOAK_REALM') || 'uchub';
    const clientId = this.config.get<string>('KEYCLOAK_CLIENT_ID') || 'customer-ops';
    const secret = this.config.get<string>('KEYCLOAK_CLIENT_SECRET') || '';
    if (!base || !secret) {
      this.logger.warn('brigade-sts: KEYCLOAK_URL/KEYCLOAK_CLIENT_SECRET unset — cannot mint');
      return null;
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret,
      scope,
    });
    const tok = await this.postForm(
      `${base}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`,
      body,
      'client-credentials mint',
    );
    if (!tok) return null;
    this.cache.set(key, tok);
    return tok.token;
  }

  /** POST a form to a token/exchange endpoint → {token, expMs} or null. */
  private async postForm(
    url: string,
    body: URLSearchParams,
    label: string,
  ): Promise<CachedToken | null> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.logger.warn(`${label} transport error: ${(err as Error).message}`);
      return null;
    }
    if (!res.ok) {
      this.logger.warn(`${label} HTTP ${res.status}`);
      return null;
    }
    let json: { access_token?: string; expires_in?: number };
    try {
      json = (await res.json()) as { access_token?: string; expires_in?: number };
    } catch {
      return null;
    }
    if (!json.access_token) return null;
    const ttl = typeof json.expires_in === 'number' ? json.expires_in : 300;
    return { token: json.access_token, expMs: Date.now() + ttl * 1000 };
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('BRIGADE_EXCHANGE_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10_000;
  }
}

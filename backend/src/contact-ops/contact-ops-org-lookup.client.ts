/**
 * The Contact-Ops org lookup (Contact-Ops #42, contact_ops/api/org_tenancy.py):
 *
 *   GET {CONTACT_OPS_BASE_URL}/api/service/ops-center-orgs/{org_id}/tenant
 *   200 {"ops_center_org_id": uuid, "tenant_id": uuid, "tenant_slug": str}
 *   404 no tenant for that org (never a personal or deprecated tenant)
 *   422 not a uuid · 401 auth · 503 Contact-Ops cannot verify tokens
 *
 * AUTH: a Keycloak client-credentials token of the DEDICATED lookup client (the
 * route checks aud=contact-ops-org-lookup AND azp=that client). Its id, secret
 * and the realm token URL come from their own envs — never the customer-ops
 * client or the static Contact-Ops service token:
 *
 *   CONTACT_OPS_LOOKUP_CLIENT_ID / CONTACT_OPS_LOOKUP_CLIENT_SECRET /
 *   CONTACT_OPS_LOOKUP_TOKEN_URL (+ the existing CONTACT_OPS_BASE_URL)
 *
 * DORMANT when any of the four is unset: no call is made, `lookupTenant`
 * answers `dormant`, and one line says so at boot.
 *
 * The answer is trusted only for the org that was asked: an answer naming
 * another org id (or a tenant id that is not a uuid) is a `mismatch`, never a
 * map. Never throws.
 *
 * An `unavailable` detail is a sanitized category only (R3-5) — `timeout`,
 * `http_<status>`, `bad_json` or `transport` — never an exception message or
 * response text, which could carry a credential into the log.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type OrgTenantLookup =
  | { kind: 'tenant'; tenantId: string; tenantSlug: string | null }
  | { kind: 'mismatch'; detail: string }
  | { kind: 'no_tenant' }
  | { kind: 'dormant' }
  | { kind: 'unavailable'; detail: LookupFailure };

export type LookupFailure = 'timeout' | `http_${number}` | 'bad_json' | 'transport';

/** A failure already reduced to its category. */
class LookupError extends Error {
  constructor(readonly category: LookupFailure) {
    super(category);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ContactOpsOrgLookupClient {
  private readonly logger = new Logger(ContactOpsOrgLookupClient.name);
  private cached: { token: string; expMs: number } | null = null;

  constructor(private readonly config: ConfigService) {
    if (!this.isConfigured()) {
      this.logger.warn(
        'Contact-Ops org lookup DORMANT (CONTACT_OPS_BASE_URL / CONTACT_OPS_LOOKUP_CLIENT_ID / ' +
          'CONTACT_OPS_LOOKUP_CLIENT_SECRET / CONTACT_OPS_LOOKUP_TOKEN_URL not all set): ' +
          'provisioning writes no contact-ops map; unmapped workspaces keep answering 409.',
      );
    }
  }

  private env(key: string): string | null {
    const raw = this.config.get<string>(key);
    return raw && raw.trim() ? raw.trim() : null;
  }

  isConfigured(): boolean {
    return (
      !!this.env('CONTACT_OPS_BASE_URL') &&
      !!this.env('CONTACT_OPS_LOOKUP_CLIENT_ID') &&
      !!this.env('CONTACT_OPS_LOOKUP_CLIENT_SECRET') &&
      !!this.env('CONTACT_OPS_LOOKUP_TOKEN_URL')
    );
  }

  /** The Contact-Ops tenant for exactly this Ops-Center org id. Never throws. */
  async lookupTenant(orgId: string): Promise<OrgTenantLookup> {
    if (!this.isConfigured()) return { kind: 'dormant' };
    // Contact-Ops answers 422 for a non-uuid; no tenant can exist for one.
    if (!UUID_RE.test(orgId)) return { kind: 'no_tenant' };
    // ONE deadline for the whole request (R3-4): the token mint, the lookup and
    // reading both bodies. It stays armed until the last body is consumed.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.ask(orgId, controller.signal);
    } catch (err) {
      // Never the exception's message: a parse error quotes the response text.
      const detail: LookupFailure =
        err instanceof LookupError
          ? err.category
          : controller.signal.aborted
            ? 'timeout'
            : 'transport';
      return { kind: 'unavailable', detail };
    } finally {
      clearTimeout(timer);
    }
  }

  private timeoutMs(): number {
    const raw = Number(this.config.get<string>('CONTACT_OPS_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : 8000;
  }

  private async ask(orgId: string, signal: AbortSignal): Promise<OrgTenantLookup> {
    const base = this.env('CONTACT_OPS_BASE_URL')!.replace(/\/$/, '');

    const token = await this.lookupToken(signal);

    const res = await fetch(
      `${base}/api/service/ops-center-orgs/${encodeURIComponent(orgId)}/tenant`,
      {
        method: 'GET',
        redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal,
      },
    );
    if (res.status === 404 || res.status === 422) return { kind: 'no_tenant' };
    if (res.status === 401) this.cached = null;
    if (res.status !== 200) return { kind: 'unavailable', detail: `http_${res.status}` };
    const body = (await readJson(res, signal)) as Record<string, unknown>;

    const answeredOrg = body?.['ops_center_org_id'];
    const tenantId = body?.['tenant_id'];
    if (typeof answeredOrg !== 'string' || answeredOrg.toLowerCase() !== orgId.toLowerCase()) {
      return { kind: 'mismatch', detail: 'answer names another org id' };
    }
    if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
      return { kind: 'mismatch', detail: 'answer tenant id is not a uuid' };
    }
    const slug = body['tenant_slug'];
    return {
      kind: 'tenant',
      tenantId: tenantId.toLowerCase(),
      tenantSlug: typeof slug === 'string' ? slug : null,
    };
  }

  /** Client-credentials token of the dedicated lookup client, cached by exp. Throws a LookupError. */
  private async lookupToken(signal: AbortSignal): Promise<string> {
    if (this.cached && this.cached.expMs - 30_000 > Date.now()) return this.cached.token;
    const res = await fetch(this.env('CONTACT_OPS_LOOKUP_TOKEN_URL')!, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.env('CONTACT_OPS_LOOKUP_CLIENT_ID')!,
        client_secret: this.env('CONTACT_OPS_LOOKUP_CLIENT_SECRET')!,
      }).toString(),
    });
    if (!res.ok) throw new LookupError(`http_${res.status}`);
    const json = (await readJson(res, signal)) as { access_token?: string; expires_in?: number };
    if (!json || typeof json.access_token !== 'string' || !json.access_token) {
      throw new LookupError('bad_json');
    }
    const ttl = typeof json.expires_in === 'number' ? json.expires_in : 300;
    this.cached = { token: json.access_token, expMs: Date.now() + ttl * 1000 };
    return json.access_token;
  }
}

/**
 * res.json(), ended by the request's deadline even if the body stalls: real
 * fetch aborts a body read on the signal, and the race makes that certain.
 * Rejects only with a category (`timeout` / `bad_json`), never the parse text.
 */
function readJson(res: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(new LookupError('timeout'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new LookupError('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    res.json().then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        reject(new LookupError(signal.aborted ? 'timeout' : 'bad_json'));
      },
    );
  });
}

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
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type OrgTenantLookup =
  | { kind: 'tenant'; tenantId: string; tenantSlug: string | null }
  | { kind: 'mismatch'; detail: string }
  | { kind: 'no_tenant' }
  | { kind: 'dormant' }
  | { kind: 'unavailable'; detail: string };

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
    try {
      return await this.ask(orgId);
    } catch (err) {
      return { kind: 'unavailable', detail: (err as Error).message || 'transport error' };
    }
  }

  private async ask(orgId: string): Promise<OrgTenantLookup> {
    const base = this.env('CONTACT_OPS_BASE_URL')!.replace(/\/$/, '');

    const token = await this.lookupToken();
    if (!token) return { kind: 'unavailable', detail: 'no lookup token' };

    const res = await this.fetchWithTimeout(
      `${base}/api/service/ops-center-orgs/${encodeURIComponent(orgId)}/tenant`,
      {
        method: 'GET',
        redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      },
    );
    if (res.status === 404 || res.status === 422) return { kind: 'no_tenant' };
    if (res.status === 401) this.cached = null;
    if (res.status !== 200) return { kind: 'unavailable', detail: `HTTP ${res.status}` };
    const body = (await res.json()) as Record<string, unknown>;

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

  /** Client-credentials token of the dedicated lookup client, cached by exp. */
  private async lookupToken(): Promise<string | null> {
    if (this.cached && this.cached.expMs - 30_000 > Date.now()) return this.cached.token;
    const res = await this.fetchWithTimeout(this.env('CONTACT_OPS_LOOKUP_TOKEN_URL')!, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.env('CONTACT_OPS_LOOKUP_CLIENT_ID')!,
        client_secret: this.env('CONTACT_OPS_LOOKUP_CLIENT_SECRET')!,
      }).toString(),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    const ttl = typeof json.expires_in === 'number' ? json.expires_in : 300;
    this.cached = { token: json.access_token, expMs: Date.now() + ttl * 1000 };
    return json.access_token;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const raw = Number(this.config.get<string>('CONTACT_OPS_TIMEOUT_MS'));
    const ms = Number.isFinite(raw) && raw > 0 ? raw : 8000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

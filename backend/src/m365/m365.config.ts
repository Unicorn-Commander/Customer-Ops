/**
 * M365Config — the one place every M365 env var is read + defaulted.
 *
 * The connector's DORMANCY contract lives here: `isConfigured` is false unless
 * M365_CLIENT_ID is set, and every entry point (the OAuth start/callback, the
 * status route, the sync) checks it. Blank M365_CLIENT_ID ⇒ the whole connector
 * ships inert (status `{configured:false}`, the connect button disabled, a clean
 * 503 on start) with ZERO behavior change to the rest of the app.
 *
 * Microsoft endpoints are derived from M365_TENANT_ID (default 'common' =
 * multi-tenant + personal accounts), matching the Azure app registration.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class M365Config {
  constructor(private readonly config: ConfigService) {}

  /** Whether the connector is configured at all (the dormancy switch). */
  get isConfigured(): boolean {
    return !!this.clientId;
  }

  get clientId(): string | null {
    return this.str('M365_CLIENT_ID');
  }

  get clientSecret(): string | null {
    return this.str('M365_CLIENT_SECRET');
  }

  /** The Entra tenant: 'common' (multi-tenant + personal), 'organizations', or a
   *  tenant GUID. Drives the authority URL. */
  get tenantId(): string {
    return this.str('M365_TENANT_ID') ?? 'common';
  }

  /** The MSAL authority (login.microsoftonline.com/{tenant}). */
  get authority(): string {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.tenantId)}`;
  }

  /** The OAuth redirect URI registered in Azure (must match exactly). */
  get redirectUri(): string {
    return (
      this.str('M365_REDIRECT_URI') ??
      'https://customerops.unicorncommander.ai/api/v1/m365/oauth/callback'
    );
  }

  /** The delegated Graph scopes to request. offline_access is mandatory (it mints
   *  the refresh token). Whitespace-separated in env. */
  get scopes(): string[] {
    const raw = this.str('M365_SCOPES') ?? 'offline_access User.Read Contacts.Read';
    return raw
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Microsoft Graph API base. */
  get graphBaseUrl(): string {
    return this.str('M365_GRAPH_BASE_URL') ?? 'https://graph.microsoft.com/v1.0';
  }

  get pageSize(): number {
    return this.int('M365_SYNC_PAGE_SIZE', 50);
  }

  get timeoutMs(): number {
    return this.int('M365_TIMEOUT_MS', 15000);
  }

  /**
   * Where the OAuth callback 302s back to (the SPA integrations page). Derived
   * from FRONTEND_URL (the configured origin) — NEVER from a request header — so
   * the redirect target can't be hijacked into an open redirect. The callback
   * only ever appends `?m365=connected|error` to this fixed path.
   */
  get frontendReturnUrl(): string {
    const base = (
      this.str('FRONTEND_URL') ??
      this.str('CORS_ORIGIN') ??
      'http://localhost:3001'
    ).replace(/\/$/, '');
    return `${base}/dashboard/settings/integrations`;
  }

  /** Short TTL for the signed OAuth `state` JWT (seconds). The state is the CSRF
   *  + which-user boundary; it should live only long enough to complete consent. */
  get stateTtlSeconds(): number {
    return this.int('M365_STATE_TTL_SECONDS', 600);
  }

  private str(key: string): string | null {
    const raw = this.config.get<string>(key);
    return raw && raw.trim() ? raw.trim() : null;
  }

  private int(key: string, fallback: number): number {
    const raw = this.config.get<string>(key);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
}

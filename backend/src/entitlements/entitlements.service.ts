import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

/**
 * Entitlements source — the suite Ops-Center entitlements endpoint.
 *
 * Re-sources the verified entitlement SKUs from Ops-Center's
 * `GET /api/v1/entitlements` (the suite's single entitlements authority) instead
 * of reading them off the token claim. The endpoint accepts the user's Keycloak
 * access token (RS256/JWKS, uchub issuers) and returns the org's FULL feature_key
 * set — which Customer-Ops needs BOTH for the launch gate (`customer_ops_access`)
 * AND for the dual-SKU federation gates (email/accounting/outreach keys). See
 * SUITE entitlements spec; consumed via EntitlementsInterceptor.
 *
 * DORMANT until `ENTITLEMENTS_ENDPOINT_URL` is set: with no URL, `resolve()`
 * returns null and the caller keeps using the token-claim source — no behavior
 * change (`JwtStrategy.readEntitlements` stays the source).
 *
 * Token reality: Customer-Ops' primary login is a local HS256 session token,
 * which a JWKS endpoint cannot verify. We only forward RS256 bearers (a forwarded
 * uchub/Keycloak token); an HS256 session degrades cleanly to the claim source.
 * (When CO forwards/stores the KC access token, the endpoint becomes the source
 * for that path too.)
 *
 * Fail posture (per the endpoint spec):
 *   - 200, a key absent          -> a true deny (the list is authoritative).
 *   - 5xx / timeout / network    -> fail-soft: serve last-good if we have it
 *                                   (don't kick a known-good org on a blip),
 *                                   else null (never-seen -> caller fail-closed).
 *   - 401 / 403 (bad token / not a member) -> null (fall back to the claim).
 *   - cache ~60s per (user, org)  -> an upgrade takes effect within the TTL.
 */

export interface EntitlementsResult {
  orgId: string | null;
  tier: string | null;
  /** RAW endpoint keys, e.g. ['customer_ops_access', 'email_ops_access', ...]. */
  featureKeys: string[];
}

/**
 * The result of the SERVER-SIDE, per-workspace lookup — a THREE-state answer,
 * deliberately not `EntitlementsResult | null`.
 *
 * WHY THREE STATES (this is the fail-open this type exists to prevent): a bare
 * `null` conflated "no source is configured here" with "a source IS configured
 * but it just 401'd / 500'd / timed out". The caller
 * (WorkspaceEntitlementsResolver) turns the first into "trust the caller's
 * claim" — so collapsing the second into it meant a configured-but-unavailable
 * entitlements endpoint silently degraded to FULL TRUST. That is a widening on
 * failure, i.e. exactly the posture the rest of this lane claims never to take.
 *
 *   - `unconfigured`  no URL and/or no service credential ⇒ this repo has no
 *                     server-side opinion. Legitimate passthrough.
 *   - `ok`            a 200. Authoritative.
 *   - `unavailable`   a source IS configured but could not answer (non-2xx,
 *                     network error, timeout, unparseable body). INDETERMINATE ⇒
 *                     the caller must NOT widen: deny, or narrow to a persisted
 *                     answer that carries its own expiry.
 */
export type WorkspaceEntitlementsLookup =
  | { status: 'unconfigured' }
  | { status: 'ok'; data: EntitlementsResult }
  | { status: 'unavailable'; reason: string };

interface CacheEntry {
  at: number;
  data: EntitlementsResult;
}

const MAX_ENTRIES = 5000;

// Endpoint feature_keys that are NOT in the `*_ops_access` family but map onto a
// suite SKU a federation gate matches. `magic_outreach` is Magic Unicorn
// Outreach's existing feature_key (a separate app, not a launch SKU — so it is not
// in the 8-key `*_ops_access` lineup); the Outreach dual-SKU gate matches
// `outreach` (outreach-ops SKU_OUTREACH). The endpoint surfaces magic_outreach
// whenever the org holds it (via tier or org-grant).
const KEY_ALIASES: Record<string, string> = {
  magic_outreach: 'outreach',
};

@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);
  private readonly endpoint: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  // Keyed by `sub|orgId` (stable across token refresh) so a 60s TTL gives
  // upgrade-within-60s AND fail-soft survives a token rotation.
  private readonly fresh = new Map<string, CacheEntry>();
  private readonly lastGood = new Map<string, EntitlementsResult>();
  /**
   * Service credential for the SERVER-SIDE, per-workspace lookup used by lanes
   * that have no forwardable user JWT (the `co_pat_` lane). Unset => that lookup
   * is dormant and `lookupWorkspace` returns `{ status: 'unconfigured' }` (see
   * the loud boot WARNING below — endpoint-without-credential enforces nothing).
   * Never logged.
   */
  private readonly serviceToken: string;

  constructor(config: ConfigService) {
    this.endpoint = (config.get<string>('ENTITLEMENTS_ENDPOINT_URL') || '')
      .trim()
      .replace(/\/$/, '');
    this.serviceToken = (config.get<string>('ENTITLEMENTS_SERVICE_TOKEN') || '').trim();
    this.ttlMs = this.int(config.get<string>('ENTITLEMENTS_CACHE_TTL_MS'), 60_000);
    this.timeoutMs = this.int(config.get<string>('ENTITLEMENTS_TIMEOUT_MS'), 5_000);
    // BOOT LOG — state plainly, in one place, whether each lane is actually
    // live. The previous log printed "Entitlements source: <url>" the moment a
    // URL was set, which read as "fully configured" even when the per-workspace
    // (PAT / server-side) lane was inert for want of a service credential.
    if (!this.endpoint) {
      this.logger.log(
        'Entitlements endpoint NOT configured (ENTITLEMENTS_ENDPOINT_URL unset) — ' +
          'user lane: token-claim source; server-side per-workspace lane: INERT ' +
          '(no server-side entitlement enforcement).',
      );
    } else if (!this.serviceToken) {
      // Loud, because this configuration looks configured and enforces nothing.
      this.logger.warn(
        `ENTITLEMENTS_ENDPOINT_URL is set (${this.endpoint}) but ENTITLEMENTS_SERVICE_TOKEN is NOT — ` +
          'the SERVER-SIDE per-workspace entitlement lookup is DISABLED. The user (JWT) lane will use ' +
          'the endpoint, but the PAT / workspace lane has NO server-side source and therefore enforces ' +
          'NOTHING: every PAT keeps its mint-time snapshot indefinitely. Set ENTITLEMENTS_SERVICE_TOKEN ' +
          '(or pin Workspace.entitlementCache) to make workspace entitlement enforcement live.',
      );
    } else {
      this.logger.log(
        `Entitlements source: ${this.endpoint} (cache ${this.ttlMs}ms, timeout ${this.timeoutMs}ms) — ` +
          'user lane LIVE; server-side per-workspace lane LIVE (service credential present).',
      );
    }
  }

  isConfigured(): boolean {
    return this.endpoint.length > 0;
  }

  /**
   * True only when the SERVER-SIDE per-workspace lookup can actually run — it
   * needs BOTH the endpoint URL and the service credential. `isConfigured()`
   * (URL only) is NOT a proxy for this; conflating them is the footgun the boot
   * log above warns about.
   */
  isWorkspaceLookupConfigured(): boolean {
    return this.endpoint.length > 0 && this.serviceToken.length > 0;
  }

  /**
   * Resolve the org's feature_keys for the acting bearer. Returns null when the
   * caller should fall back to the token-claim source: unconfigured, a non-RS256
   * session token, an auth/membership rejection, or a cold endpoint outage with
   * nothing cached.
   */
  async resolve(
    rawToken: string | null | undefined,
    orgId?: string | null,
  ): Promise<EntitlementsResult | null> {
    if (!this.endpoint || !rawToken) return null;
    // Only a uchub/Keycloak RS256 token can be JWKS-verified by the endpoint; a
    // local HS256 session token would just 401, so skip the round-trip.
    if (!this.isRs256(rawToken)) return null;

    const key = this.cacheKey(rawToken, orgId);
    const now = Date.now();
    const hit = this.fresh.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.data;

    const url = orgId
      ? `${this.endpoint}?org_id=${encodeURIComponent(orgId)}`
      : this.endpoint;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${rawToken}`, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      const cached = this.lastGood.get(key);
      this.logger.warn(
        `entitlements fetch failed (${(err as Error)?.name ?? 'error'}); ` +
          `${cached ? 'serving last-good (fail-soft)' : 'no cache -> fail-closed (claim fallback)'}`,
      );
      return cached ?? null;
    } finally {
      clearTimeout(timer);
    }

    // Bad/expired token or not a member of the addressed org: fall back to the
    // claim (don't cache, don't hard-deny here — the gate decides).
    if (res.status === 401 || res.status === 403) return null;

    if (res.status >= 500 || !res.ok) {
      const cached = this.lastGood.get(key);
      this.logger.warn(
        `entitlements endpoint ${res.status}; ` +
          `${cached ? 'serving last-good (fail-soft)' : 'no cache -> fail-closed (claim fallback)'}`,
      );
      return cached ?? null;
    }

    let body: any;
    try {
      body = await res.json();
    } catch {
      return this.lastGood.get(key) ?? null;
    }

    const data: EntitlementsResult = {
      orgId: typeof body?.org_id === 'string' ? body.org_id : null,
      tier: typeof body?.tier === 'string' ? body.tier : null,
      featureKeys: Array.isArray(body?.entitlements)
        ? body.entitlements.filter((k: unknown): k is string => typeof k === 'string')
        : [],
    };
    this.put(this.fresh, key, { at: now, data });
    this.put(this.lastGood, key, data);
    return data;
  }

  /**
   * SERVER-SIDE, per-WORKSPACE resolve — for lanes with no forwardable user JWT.
   *
   * A `co_pat_` bearer is not a JWT, so {@link resolve} rejects it (`isRs256`
   * false) and the PAT lane had no live entitlement source at all. This variant
   * asks the endpoint "what does WORKSPACE w hold" using a configured service
   * credential instead of the caller's token.
   *
   * DORMANT unless BOTH `ENTITLEMENTS_ENDPOINT_URL` and `ENTITLEMENTS_SERVICE_TOKEN`
   * are set — returns `{ status: 'unconfigured' }`, and the caller falls back to
   * the persisted mirror / the PAT snapshot. Deliberately does NOT use the
   * per-user `fresh`/`lastGood` caches (different key space, and the caller —
   * WorkspaceEntitlementsResolver — owns the TTL and the durable mirror).
   *
   * FAIL POSTURE — the whole reason this returns a three-state
   * {@link WorkspaceEntitlementsLookup} and not `EntitlementsResult | null`: any
   * non-2xx (INCLUDING 401/403/404), network error, timeout or unparseable body
   * is `{ status: 'unavailable' }` — INDETERMINATE, never "no source". The caller
   * must fail closed on that; only `unconfigured` may pass through to the claim.
   * There is NO last-good fail-soft here: the durable `workspace_entitlements`
   * mirror is the caller's last-good, and it carries an explicit `expiresAt` so a
   * grant cannot outlive its window.
   */
  async lookupWorkspace(workspaceId: string): Promise<WorkspaceEntitlementsLookup> {
    if (!this.endpoint || !this.serviceToken) return { status: 'unconfigured' };
    // An empty workspace id is a caller bug, not an endpoint outage — but it is
    // still not an answer, so it must not read as "no source".
    if (!workspaceId) return { status: 'unavailable', reason: 'empty workspace id' };

    const url = `${this.endpoint}?workspace_id=${encodeURIComponent(workspaceId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.serviceToken}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      const reason = (err as Error)?.name ?? 'error';
      this.logger.warn(
        `workspace entitlements fetch failed for ${workspaceId} (${reason}) -> INDETERMINATE (fail closed)`,
      );
      return { status: 'unavailable', reason };
    } finally {
      clearTimeout(timer);
    }

    // NOTE 401/403 land here too. On the USER lane a 401/403 means "this caller's
    // token can't be checked" and falling back to the claim is right. On the
    // SERVICE lane it means OUR credential is wrong/expired — a configuration
    // fault on an endpoint we were told to trust. Trusting the caller's claim
    // because our own credential broke is precisely the fail-open.
    if (!res.ok) {
      this.logger.warn(
        `workspace entitlements endpoint ${res.status} for ${workspaceId} -> INDETERMINATE (fail closed)`,
      );
      return { status: 'unavailable', reason: `http ${res.status}` };
    }

    let body: any;
    try {
      body = await res.json();
    } catch {
      this.logger.warn(
        `workspace entitlements body unparseable for ${workspaceId} -> INDETERMINATE (fail closed)`,
      );
      return { status: 'unavailable', reason: 'unparseable body' };
    }
    return {
      status: 'ok',
      data: {
        orgId: typeof body?.org_id === 'string' ? body.org_id : null,
        tier: typeof body?.tier === 'string' ? body.tier : null,
        featureKeys: Array.isArray(body?.entitlements)
          ? body.entitlements.filter((k: unknown): k is string => typeof k === 'string')
          : [],
      },
    };
  }

  /**
   * Map the endpoint's feature_keys onto the suite SKU vocabulary the federation
   * gates normalize, keeping the RAW key too so the launch gate (raw key) and the
   * dual-SKU gates (suite SKU) both match:
   *   - `*_ops_access` -> strip `_access`, `_`->`-`  (customer_ops_access -> customer-ops)
   *   - KEY_ALIASES                                  (magic_outreach -> outreach)
   * e.g. ['customer_ops_access','email_ops_access','magic_outreach']
   *   -> ['customer_ops_access','customer-ops','email_ops_access','email-ops',
   *       'magic_outreach','outreach'].
   */
  toSkuList(featureKeys: string[]): string[] {
    const out = new Set<string>();
    for (const raw of featureKeys) {
      if (!raw) continue;
      out.add(raw);
      // The `*_ops_access` family -> suite SKU (strip `_access`, `_`->`-`). Only
      // these; a flat key like `magic_outreach` is handled by KEY_ALIASES, not by
      // a blind `_`->`-` (which would emit a spurious `magic-outreach`).
      if (/_access$/i.test(raw)) {
        const suite = raw.replace(/_access$/i, '').replace(/_/g, '-');
        if (suite && suite !== raw) out.add(suite);
      }
      const alias = KEY_ALIASES[raw];
      if (alias) out.add(alias);
    }
    return [...out];
  }

  // --- helpers ---------------------------------------------------------------

  private isRs256(token: string): boolean {
    return this.decodeSegment(token, 0)?.alg === 'RS256';
  }

  /** Cache key: prefer the stable token `sub` so the cache survives a refresh. */
  private cacheKey(token: string, orgId?: string | null): string {
    const sub = this.decodeSegment(token, 1)?.sub;
    const base = typeof sub === 'string' && sub ? `sub:${sub}` : `tok:${this.hash(token)}`;
    return `${base}|${orgId ?? ''}`;
  }

  private decodeSegment(token: string, index: 0 | 1): any | null {
    try {
      const seg = token.split('.')[index];
      if (!seg) return null;
      return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  private hash(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }

  /** Insert with a crude bound: drop expired/oldest entries when over the cap. */
  private put<V>(map: Map<string, V>, key: string, value: V): void {
    if (map.size >= MAX_ENTRIES && !map.has(key)) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, value);
  }

  private int(v: string | undefined, dflt: number): number {
    const n = Number.parseInt((v ?? '').trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  }
}

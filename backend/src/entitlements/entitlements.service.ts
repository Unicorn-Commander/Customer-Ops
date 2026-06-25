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

interface CacheEntry {
  at: number;
  data: EntitlementsResult;
}

const MAX_ENTRIES = 5000;

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

  constructor(config: ConfigService) {
    this.endpoint = (config.get<string>('ENTITLEMENTS_ENDPOINT_URL') || '')
      .trim()
      .replace(/\/$/, '');
    this.ttlMs = this.int(config.get<string>('ENTITLEMENTS_CACHE_TTL_MS'), 60_000);
    this.timeoutMs = this.int(config.get<string>('ENTITLEMENTS_TIMEOUT_MS'), 5_000);
    if (this.endpoint) {
      this.logger.log(
        `Entitlements source: ${this.endpoint} (cache ${this.ttlMs}ms, timeout ${this.timeoutMs}ms)`,
      );
    } else {
      this.logger.log(
        'Entitlements endpoint not configured (ENTITLEMENTS_ENDPOINT_URL unset) — using the token-claim source',
      );
    }
  }

  isConfigured(): boolean {
    return this.endpoint.length > 0;
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
   * Map the endpoint's `*_access` feature_keys onto the suite SKU vocabulary the
   * federation gates normalize (`customer_ops_access` -> `customer-ops`), keeping
   * BOTH forms so the launch gate (raw key) and the dual-SKU gates (suite SKU)
   * both match. e.g. ['customer_ops_access','email_ops_access']
   *   -> ['customer_ops_access','customer-ops','email_ops_access','email-ops'].
   */
  toSkuList(featureKeys: string[]): string[] {
    const out = new Set<string>();
    for (const raw of featureKeys) {
      if (!raw) continue;
      out.add(raw);
      const suite = raw.replace(/_access$/i, '').replace(/_/g, '-');
      if (suite && suite !== raw) out.add(suite);
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

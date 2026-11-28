import { createHash } from 'crypto';

/**
 * Keycloak realm userinfo client for the forwarded-bearer (web connector)
 * sign-in path — the Customer-Ops copy of the Project-Ops PO-CONN-1/2/3 shape
 * (Project-Ops PR #168, merged 2026-11-27, `backend/src/auth/userinfo.ts`).
 *
 * WHY: a connector that forwards the Keycloak realm access token as the Bearer
 * gets its profile from the token CLAIMS alone. For a no-email human session
 * the token carries no `email`/`email_verified`, so the bearer path resolves
 * to "no email" and — with no local row — 401 `invalid_token`, which makes a
 * web connector re-run sign-in in a loop. The fix: for a trusted realm
 * HUMAN-session token whose `sub` is not already linked locally, fetch the
 * realm userinfo endpoint with the SAME verified bearer and merge its profile
 * (email + email_verified + names + preferred_username) before the EXISTING
 * JIT/gate path runs. Nothing wider than a web sign-in gets admitted: the
 * merge feeds the SAME access list / entitlements / invitation gate.
 *
 * Guards (the lessons the PO-CONN Opus reviews forced, all of them):
 *   (a) fetch ONLY for a Keycloak realm HUMAN-session token — a trusted
 *       realm `iss` (the one that already verified the token signature), NO
 *       `act`, NO `client_id`/`clientId`, no email claim on the token yet,
 *       and a `sub` not already linked to a local User (the caller checks
 *       the linkage; this module re-checks the token shape and the issuer).
 *   (b) URL = `<iss>/protocol/openid-connect/userinfo`, https only,
 *       `redirect: 'error'`, 3 s timeout (AbortController).
 *   (c) userinfo `sub` must equal the token `sub`; the machine guard applied
 *       to the token (`act` / `client_id` / `clientId`) is re-checked against
 *       the fetched profile as well before its `email_verified` is trusted.
 *   (d) cache per bearer DIGEST (sha256, never the raw token) until token
 *       `exp`, capped at 900 s and 5,000 entries; negative results are cached
 *       too; no insert when the ttl is <= 0.
 *   (f) the bearer and the email are NEVER logged.
 */

export const USERINFO_TIMEOUT_MS = 3_000;
export const USERINFO_CACHE_MAX_TTL_S = 900;
export const USERINFO_CACHE_MAX_ENTRIES = 5_000;

export interface UserinfoProfile {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  preferred_username?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  [claim: string]: unknown;
}

export type UserinfoClientEnvGetter = (key: string) => string | undefined;

const defaultEnvGetter: UserinfoClientEnvGetter = (key) => process.env[key];

export interface UserinfoLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const consoleLogger: UserinfoLogger = {
  log: (message) => console.log(`[customer-ops-userinfo] ${message}`),
  warn: (message) => console.warn(`[customer-ops-userinfo] ${message}`),
  error: (message) => console.error(`[customer-ops-userinfo] ${message}`),
};

export interface UserinfoOptions {
  /** The trusted issuer set that already verified the token signature. */
  trustedIssuers: readonly string[];
  /** The verified realm `iss` claim of the bearer token. */
  issuer: string;
  /** The verified realm `sub` claim of the bearer token. */
  sub: string;
  /** The verified `exp` claim (seconds), bounding the cache entry. */
  exp?: number;
  /** Bearer path only: browser callbacks re-check with a fresh token. */
  cache?: boolean;
  /** The raw realm bearer. Used only for its sha256 digest as the cache key. */
  bearer: string;
  getEnv?: UserinfoClientEnvGetter;
  logger?: UserinfoLogger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface UserinfoResolution {
  outcome: 'profile' | 'refused' | 'unavailable';
  profile: UserinfoProfile | null;
  reason: string;
}

interface CachedUserinfo {
  resolution: UserinfoResolution;
  expiresAt: number;
}

interface LruEntry extends CachedUserinfo {
  insertedAt: number;
}

const profileCache = new Map<string, LruEntry>();

/**
 * Whether the userinfo merge is armed at all. OFF by default == today's
 * behavior exactly (no fetch on the bearer path); the suite operator opts in
 * per ring once the connector no-email loop is live there.
 */
export function userinfoFetchEnabled(getEnv: UserinfoClientEnvGetter = defaultEnvGetter): boolean {
  const value = (getEnv('CUSTOMER_OPS_USERINFO_FETCH') ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

/**
 * True when the verified token is a Keycloak realm HUMAN-session token this
 * client may resolve via userinfo (guard (a)): a trusted realm `iss`, no
 * machine or delegation shape, and no email claim on the token itself yet
 * (the very absence that makes the bearer path no-email today).
 */
export function isUserinfoCandidate(
  payload: Record<string, unknown>,
  trustedIssuers: readonly string[],
): boolean {
  const iss = payload?.iss;
  if (typeof iss !== 'string' || iss.trim() === '') return false;
  if (!trustedIssuers.includes(iss)) return false;
  if (payload?.act != null) return false;
  if (payload?.client_id != null) return false;
  if (payload?.clientId != null) return false;
  // A token that already carries a real email claim is NOT a no-email human
  // bearer: the email-claim path resolves it and must keep working unchanged.
  const email = payload?.email;
  if (typeof email === 'string' && email.trim() !== '') return false;
  return true;
}

function bearerDigest(bearer: string): string {
  return createHash('sha256').update(bearer).digest('hex');
}

function userInfoUrlForIssuer(issuer: string): string | null {
  if (!issuer.startsWith('https://')) return null;
  return `${issuer.replace(/\/+$/, '')}/protocol/openid-connect/userinfo`;
}

function sweepCache(nowMs: number): void {
  for (const [key, entry] of profileCache) {
    if (entry.expiresAt <= nowMs) profileCache.delete(key);
  }
}

function evictOldest(_nowMs: number): void {
  while (profileCache.size >= USERINFO_CACHE_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of profileCache) {
      const at = entry.insertedAt;
      if (at < oldestAt) {
        oldestAt = at;
        oldestKey = key;
      }
    }
    if (oldestKey === null) return;
    profileCache.delete(oldestKey);
  }
}

function cacheTtlSeconds(exp: number | undefined, nowMs: number): number {
  if (exp === undefined) return USERINFO_CACHE_MAX_TTL_S;
  return Math.min(USERINFO_CACHE_MAX_TTL_S, exp - Math.floor(nowMs / 1000));
}

/**
 * Fetch the realm userinfo profile for a verified no-email human bearer.
 * Never throws: every refusal, mismatch, or transport failure degrades to the
 * caller's existing behavior (today's behavior is the contract). The bearer
 * and any email are never logged.
 */
export async function fetchRealmUserinfo(options: UserinfoOptions): Promise<UserinfoResolution> {
  const getEnv = options.getEnv ?? defaultEnvGetter;
  const logger = options.logger ?? consoleLogger;
  // Read per call (not at module load): tests swap global.fetch before the call.
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sub = (options.sub ?? '').trim();
  const issuer = (options.issuer ?? '').trim();
  const bearer = options.bearer ?? '';

  if (!userinfoFetchEnabled(getEnv)) {
    return { outcome: 'refused', profile: null, reason: 'userinfo fetch not armed' };
  }
  if (!isUserinfoCandidate({ iss: issuer, sub }, options.trustedIssuers)) {
    return { outcome: 'refused', profile: null, reason: 'not a trusted realm human bearer' };
  }
  const url = userInfoUrlForIssuer(issuer);
  if (!url) {
    return { outcome: 'refused', profile: null, reason: 'userinfo issuer is not https' };
  }

  const nowMs = now();
  // The key binds BOTH the bearer digest and the verified sub: a cache entry
  // is only ever returned for the request that fetched it (C1 — a bearer
  // digest alone let a concurrent caller read another caller's entry).
  const key = `userinfo:${bearerDigest(bearer)}:${sub}`;
  const shouldCache = options.cache === true && sub !== '';
  sweepCache(nowMs);
  if (shouldCache) {
    const cached = profileCache.get(key);
    if (cached && cached.expiresAt > nowMs) {
      const cachedSub =
        typeof cached.resolution.profile?.sub === 'string' ? cached.resolution.profile.sub : '';
      if (cachedSub === sub) {
        // Same verified sub as the request that fetched this entry: return it
        // as-is (only `profile` results are ever stored — see the insert below).
        return cached.resolution;
      }
      // A different sub reached an entry keyed by this digest (only possible
      // pre-fix, or via a shared-bearer path): never hand one caller another
      // caller's profile. Treat it as a deliberate refusal, not a profile.
      logger.warn(
        `Realm userinfo refused: cached entry subject mismatch for a different caller (no bearer or email logged)`,
      );
      return {
        outcome: 'refused',
        profile: null,
        reason: 'userinfo cache entry belongs to a different subject',
      };
    }
  }

  let outcome: UserinfoResolution['outcome'] = 'unavailable';
  let reason = 'userinfo not fetched';
  let profile: UserinfoProfile | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), USERINFO_TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      outcome = 'unavailable';
      reason = `userinfo endpoint status ${response.status}`;
      logger.warn(`Realm userinfo unavailable: ${reason}`);
    } else {
      let parsed: unknown;
      let jsonError = false;
      try {
        parsed = await response.json();
      } catch {
        jsonError = true;
        outcome = 'unavailable';
        reason = 'userinfo response was not JSON';
        logger.warn('Realm userinfo unavailable: response was not JSON');
      }
      if (!jsonError) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          outcome = 'refused';
          reason = 'userinfo response was not an object';
          logger.warn('Realm userinfo refused: response was not an object');
        } else {
          const fetched = parsed as UserinfoProfile;
          if (typeof fetched.sub !== 'string' || fetched.sub !== sub) {
            outcome = 'refused';
            reason = 'userinfo subject does not match the verified token subject';
            logger.warn('Realm userinfo refused: subject mismatch (no bearer or email logged)');
          } else if (fetched.act != null || fetched.client_id != null || fetched.clientId != null) {
            outcome = 'refused';
            reason = 'userinfo profile carries a machine or client identity';
            logger.warn('Realm userinfo refused: machine-shaped profile');
          } else {
            profile = fetched;
            outcome = 'profile';
            reason = 'userinfo profile verified against the token subject';
          }
        }
      }
    }
  } catch (error) {
    outcome = 'unavailable';
    reason =
      error instanceof Error && error.name === 'AbortError'
        ? `userinfo endpoint timed out after ${USERINFO_TIMEOUT_MS}ms`
        : `userinfo endpoint unreachable: ${
            error instanceof Error ? error.message : 'unknown transport error'
          }`;
    logger.warn(`Realm userinfo unavailable: ${reason}`);
  }

  const resolution: UserinfoResolution = { outcome, profile, reason };
  // Cache ONLY the `profile` outcome (a verified identity). `unavailable`
  // (5xx / timeout / transport / non-JSON) is TRANSIENT — caching it would
  // stick a 3 s Keycloak blip as a cached "no access" verdict for up to 900 s
  // and make the caller 403 a caller that a healthy realm would admit.
  // `refused` is deliberately not cached either (a sub mismatch must re-fetch).
  if (shouldCache && outcome === 'profile' && profile) {
    const ttl = cacheTtlSeconds(options.exp, nowMs);
    if (ttl > 0) {
      evictOldest(nowMs);
      profileCache.set(key, {
        resolution,
        expiresAt: nowMs + ttl * 1000,
        insertedAt: nowMs,
      });
    }
  }
  return resolution;
}

/** Test seam; cached entries hold profile objects and derived reasons only. */
export function clearUserinfoCacheForTests(): void {
  profileCache.clear();
}

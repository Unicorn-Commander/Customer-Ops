import { createHash } from 'crypto';

/** The fixed deadline for the user-scoped Ops-Center entitlement lookup. */
export const CUSTOMER_OPS_ENTITLEMENTS_TIMEOUT_MS = 5_000;

/** The feature that admits an organization to Customer-Ops. */
export const DEFAULT_CUSTOMER_OPS_ENTITLEMENT_FEATURE_KEY = 'customer_ops_access';

export type OrgEntitlementsEnvGetter = (key: string) => string | undefined;

const defaultEnvGetter: OrgEntitlementsEnvGetter = (key) => process.env[key];

export interface OrgEntitlementsLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const consoleLogger: OrgEntitlementsLogger = {
  log: (message) => console.log(`[customer-ops-entitlements] ${message}`),
  warn: (message) => console.warn(`[customer-ops-entitlements] ${message}`),
  error: (message) => console.error(`[customer-ops-entitlements] ${message}`),
};

export interface OrgEntitlementResolution {
  /** `allowed` is a definitive feature-key match; all other outcomes deny. */
  outcome: 'allowed' | 'denied';
  allowed: boolean;
  /** Alias used by the auth caller to make the fail-closed posture explicit. */
  entitled: boolean;
  orgId: string | null;
  tier: string | null;
  role: string | null;
  orgName: string | null;
  reason: string;
}

export interface ResolveOrgEntitlementOptions {
  /** The verified Keycloak `sub`, used as part of the cache key. */
  subject?: string;
  /** Verified JWT `exp` in seconds. Used to bound the cache entry. */
  exp?: number;
  /** Cache only the bearer path; browser callbacks re-check their fresh token. */
  cache?: boolean;
  getEnv?: OrgEntitlementsEnvGetter;
  logger?: OrgEntitlementsLogger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface CachedResolution {
  resolution: OrgEntitlementResolution;
  expiresAt: number;
}

const verdictCache = new Map<string, CachedResolution>();

export function ucEntitlementsUrl(
  getEnv: OrgEntitlementsEnvGetter = defaultEnvGetter,
): string | null {
  const raw = getEnv('UC_ENTITLEMENTS_URL');
  if (!raw || !raw.trim()) return null;
  return raw.trim().replace(/\/+$/, '');
}

export function customerOpsEntitlementFeatureKey(
  getEnv: OrgEntitlementsEnvGetter = defaultEnvGetter,
): string {
  const raw = getEnv('CUSTOMER_OPS_ENTITLEMENT_FEATURE_KEY');
  return raw && raw.trim() ? raw.trim() : DEFAULT_CUSTOMER_OPS_ENTITLEMENT_FEATURE_KEY;
}

function truthy(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** Armed only when both new Customer-Ops settings are present. */
export function customerOpsEntitlementsEnabled(
  getEnv: OrgEntitlementsEnvGetter = defaultEnvGetter,
): boolean {
  return truthy(getEnv('CUSTOMER_OPS_ENTITLEMENTS_ENABLED')) && ucEntitlementsUrl(getEnv) !== null;
}

/** Alias kept parallel to the Project-Ops reference client. */
export const entitlementsEnabled = customerOpsEntitlementsEnabled;

function denied(
  reason: string,
  fields?: Partial<OrgEntitlementResolution>,
): OrgEntitlementResolution {
  return {
    outcome: 'denied',
    allowed: false,
    entitled: false,
    orgId: fields?.orgId ?? null,
    tier: fields?.tier ?? null,
    role: fields?.role ?? null,
    orgName: fields?.orgName ?? null,
    reason,
  };
}

function allowed(fields: {
  orgId: string;
  tier: string | null;
  role: string | null;
  orgName: string | null;
  reason: string;
}): OrgEntitlementResolution {
  return {
    outcome: 'allowed',
    allowed: true,
    entitled: true,
    orgId: fields.orgId,
    tier: fields.tier,
    role: fields.role,
    orgName: fields.orgName,
    reason: fields.reason,
  };
}

function tokenExpirySeconds(accessToken: string): number | undefined {
  try {
    const encoded = accessToken.split('.')[1];
    if (!encoded) return undefined;
    const payload = JSON.parse(
      Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp
      : undefined;
  } catch {
    return undefined;
  }
}

function cacheKey(subject: string, accessToken: string): string {
  const digest = createHash('sha256').update(accessToken).digest('hex');
  return `${subject}:${digest}`;
}

function cacheTtlMs(exp: number | undefined, now: number): number {
  const max = 60_000;
  if (exp === undefined) return max;
  return Math.min(max, exp * 1000 - now);
}

function sweepCache(now: number): void {
  for (const [key, entry] of verdictCache) {
    if (entry.expiresAt <= now) verdictCache.delete(key);
  }
}

/**
 * Resolve the caller's Customer-Ops organization entitlement. This function
 * never throws for an endpoint failure: every failure is logged and denied so
 * AuthService can continue through the existing access-list/invitation/open
 * branches.
 */
export async function resolveOrgEntitlement(
  accessToken: string | undefined,
  subjectOrOptions?: string | ResolveOrgEntitlementOptions,
  maybeOptions?: ResolveOrgEntitlementOptions,
): Promise<OrgEntitlementResolution> {
  const options: ResolveOrgEntitlementOptions =
    typeof subjectOrOptions === 'string'
      ? { ...(maybeOptions ?? {}), subject: subjectOrOptions }
      : (subjectOrOptions ?? {});
  const getEnv = options.getEnv ?? defaultEnvGetter;
  const logger = options.logger ?? consoleLogger;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const url = ucEntitlementsUrl(getEnv);

  if (!customerOpsEntitlementsEnabled(getEnv)) {
    return denied('Customer-Ops entitlement lookup is not armed');
  }
  if (!accessToken || !accessToken.trim()) {
    logger.warn('Customer-Ops entitlement lookup skipped: no bearer token');
    return denied('no bearer token to forward');
  }
  if (!url) {
    // The armed check above already covers this; keep this branch explicit for
    // callers/tests that mutate environment getters between reads.
    logger.warn('Customer-Ops entitlement lookup skipped: URL is unset');
    return denied('UC_ENTITLEMENTS_URL unset');
  }

  const nowMs = now();
  const subject = options.subject?.trim();
  const shouldCache = options.cache === true && !!subject;
  const key = shouldCache ? cacheKey(subject!, accessToken) : null;
  sweepCache(nowMs);
  if (key) {
    const cached = verdictCache.get(key);
    if (cached && cached.expiresAt > nowMs) return cached.resolution;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CUSTOMER_OPS_ENTITLEMENTS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown transport error';
    logger.warn(`Customer-Ops entitlement endpoint unavailable: ${message}`);
    return denied('entitlements endpoint unavailable');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    logger.warn(`Customer-Ops entitlement endpoint returned status ${response.status}`);
    return denied(`entitlements endpoint status ${response.status}`);
  }

  let body: any;
  try {
    body = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSON';
    logger.warn(`Customer-Ops entitlement response was not JSON: ${message}`);
    return denied('entitlements response was not JSON');
  }

  const orgId = typeof body?.org_id === 'string' && body.org_id.trim() ? body.org_id.trim() : null;
  const tier = typeof body?.tier === 'string' ? body.tier : null;
  const role = typeof body?.role === 'string' ? body.role : null;
  const orgName =
    typeof body?.org_name === 'string' && body.org_name.trim() ? body.org_name.trim() : null;
  const entitlements = Array.isArray(body?.entitlements)
    ? body.entitlements.map((entry: unknown) => String(entry).trim()).filter(Boolean)
    : null;
  const featureKey = customerOpsEntitlementFeatureKey(getEnv);

  if (!orgId || !entitlements) {
    logger.warn('Customer-Ops entitlement response had an invalid shape; treating it as denied');
    return denied('invalid entitlements response', { orgId, tier, role, orgName });
  }

  const resolution = entitlements.includes(featureKey)
    ? allowed({
        orgId,
        tier,
        role,
        orgName,
        reason: `entitled via '${featureKey}'`,
      })
    : denied(`organization lacks '${featureKey}'`, { orgId, tier, role, orgName });

  logger.log(
    `Customer-Ops entitlement decision: status=${response.status} ` +
      `orgPresent=${Boolean(orgId)} featurePresent=${entitlements.includes(featureKey)}`,
  );

  if (key && (resolution.allowed || resolution.outcome === 'denied')) {
    const exp = options.exp ?? tokenExpirySeconds(accessToken);
    const ttl = cacheTtlMs(exp, nowMs);
    if (ttl > 0) verdictCache.set(key, { resolution, expiresAt: nowMs + ttl });
  }
  return resolution;
}

/** Parallel spelling to the Project-Ops reference client. */
export const resolveEntitlement = resolveOrgEntitlement;

/** Test seam; cached entries contain only verdicts and derived org fields. */
export function clearOrgEntitlementCacheForTests(): void {
  verdictCache.clear();
}

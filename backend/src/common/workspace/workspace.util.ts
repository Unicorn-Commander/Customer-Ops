import { User } from '@prisma/client';

/**
 * Suite Identity & Tenancy seam for Customer-Ops.
 *
 * The canonical workspace id is resolved from the validated JWT claim
 * (`workspace_id` → `tenant_id`, NEVER an HTTP header for the claim path —
 * matching the suite model in Project-Ops / Accounting-Ops / Contact-Ops),
 * falling back to a single configured `DEFAULT_WORKSPACE_ID` for today's
 * single-tenant dogfood. Customer-Ops CONSUMES workspace ids from uc-registry;
 * it never mints them.
 *
 * When tenancy goes live, MembershipService is the ONE place app-layer
 * resolution meets the database fence: the resolved id is fed into
 * PrismaService.withWorkspace, so the DB RLS GUC is always whatever the
 * membership gate decided.
 */

// A namespaced UUID used only when DEFAULT_WORKSPACE_ID is unset. It is a valid
// lowercase RFC-4122 v7-shaped UUID so the column stays well-typed AND satisfies
// uc-registry / current_workspace_id() format expectations (SUITE-IDENTITY §4).
// The `c007` tail distinguishes Customer-Ops' dogfood bootstrap workspace.
// Operators should set DEFAULT_WORKSPACE_ID explicitly per node.
export const DEFAULT_WORKSPACE_FALLBACK = '0190a000-7e57-7000-8000-00000000c007';

// `User` augmented by JwtStrategy.validate with the validated workspace claim
// (`__workspaceClaim` = the token's `workspace_id`/`tenant_id`), the acting
// uchub subject (`__ucUid` = the token `sub`, used for `app.uc_uid` attribution
// and as the Membership key), and the verified entitlement SKUs
// (`__entitlements` = the token's flat `entitlements`/`products` claim, used by
// the Phase-3 Accounting-Ops federation dual-SKU gate). All are non-persistent,
// request-scoped only — surfaced off the verified token, never an HTTP header.
//
// For a PAT-authenticated request there is NO live token claim, so the auth
// chokepoint (jwt-auth.guard) stamps `__entitlements` from the SKUs snapshotted
// onto the token at mint time instead (see PersonalAccessToken.entitlements).
// Either way, a gate binds the claim to the ACTING workspace by intersecting it
// with that workspace's server-side entitlements — see
// `WorkspaceContextService.effectiveEntitlements` + `intersectEntitlements`.
export type WithWorkspaceClaim = User & {
  __workspaceClaim?: string | null;
  __ucUid?: string | null;
  __entitlements?: string[] | null;
};

/**
 * Resolve the active workspace id for a request/user.
 * Claim (set by JwtStrategy) wins; otherwise the configured default.
 */
export function resolveWorkspaceId(
  user: Partial<WithWorkspaceClaim> | null | undefined,
  defaultWorkspaceId: string,
): string {
  const claim = (user as WithWorkspaceClaim | undefined)?.__workspaceClaim;
  if (typeof claim === 'string' && claim.trim()) {
    return claim.trim();
  }
  return defaultWorkspaceId;
}

/**
 * The acting user's uchub `sub` for `app.uc_uid` attribution. Prefers the
 * validated token `sub` (surfaced as `__ucUid` by JwtStrategy), then the linked
 * `keycloakId`, then the local user id. Always returns a string ('' if none).
 */
export function ucUidOf(user: Partial<WithWorkspaceClaim> | null | undefined): string {
  const u = user as WithWorkspaceClaim | undefined;
  return (u?.__ucUid?.trim() || u?.keycloakId || u?.id || '') as string;
}

/** The configured default workspace, read from the environment. */
export function defaultWorkspaceId(
  getEnv: (k: string) => string | undefined = (k) => process.env[k],
): string {
  const v = getEnv('DEFAULT_WORKSPACE_ID');
  return v && v.trim() ? v.trim() : DEFAULT_WORKSPACE_FALLBACK;
}

/**
 * The verified entitlement SKUs on the acting user's token (`__entitlements`,
 * surfaced by JwtStrategy from the flat `entitlements`/`products` claim). Always
 * returns an array (possibly empty when the token carries no entitlement claim,
 * which the federation gate treats as "no entitlements present"). The
 * normalization of SKU spellings/aliases is the federation client's job — this
 * just hands back the raw verified list.
 */
export function entitlementsOf(user: Partial<WithWorkspaceClaim> | null | undefined): string[] {
  const e = (user as WithWorkspaceClaim | undefined)?.__entitlements;
  return Array.isArray(e) ? e : [];
}

/**
 * A separator/case-insensitive comparison KEY for a SKU string, so spelling
 * variants of the same SKU (`customer-ops` / `customer_ops` / `customerops`)
 * collapse to one key for set membership. Deliberately minimal — it unifies only
 * separator + case (which every layer already agrees on) and does NOT fork the
 * federation clients' canonical alias tables (`co`→`customer-ops`, `ai`→
 * `ai-metered`, …). Both sides of an intersection are expected to carry canonical
 * SKU strings; this is spelling-tolerance, never a value to store or hand
 * downstream (the clients keep normalizing the surviving value they act on).
 */
export function entitlementKey(sku: string): string {
  return (sku || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * Parse a Workspace.entitlementCache mirror value into the workspace's
 * server-side entitlement SKUs, or `null` when there is NO server-side source.
 *
 * The null/absent distinction is load-bearing for the gate:
 *   - `null`  (cache column null / no mirror row) ⇒ "no server-side source" ⇒
 *     the intersector TRUSTS the token claim as-is (today's shared-SaaS default,
 *     where the token IS the per-user, per-workspace entitlement authority).
 *   - `[]`    (cache PRESENT but empty) ⇒ the workspace is entitled to nothing ⇒
 *     the intersector denies every SKU. A real state on a populated-but-
 *     unsubscribed workspace — NOT the same as "no source".
 *
 * Tolerant of shape (mirrors JwtStrategy.readEntitlements): a bare string[]; an
 * object with `entitlements`/`skus`/`products`; a space/comma string; items may
 * be strings or `{code|product|sku, active?}` (inactive dropped).
 */
export function parseWorkspaceEntitlements(cache: unknown): string[] | null {
  if (cache == null) return null;

  const coerce = (value: unknown): string[] => {
    if (value == null) return [];
    if (typeof value === 'string') {
      return value
        .replace(/,/g, ' ')
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (Array.isArray(value)) {
      const out: string[] = [];
      for (const item of value) {
        if (typeof item === 'string') {
          const t = item.trim();
          if (t) out.push(t);
        } else if (item && typeof item === 'object') {
          const code = (item as any).code ?? (item as any).product ?? (item as any).sku;
          const active = (item as any).active ?? true;
          if (code && active) out.push(String(code).trim());
        }
      }
      return out;
    }
    return [];
  };

  if (Array.isArray(cache) || typeof cache === 'string') {
    return [...new Set(coerce(cache))];
  }
  if (typeof cache === 'object') {
    const obj = cache as Record<string, unknown>;
    const codes = coerce(obj.entitlements ?? obj.skus ?? obj.products ?? obj.entitlement);
    return [...new Set(codes)];
  }
  // A present-but-unusable scalar (number/boolean) is treated as "present, empty".
  return [];
}

/**
 * Bind a token/PAT entitlement claim to the ACTING workspace: return the SKUs the
 * caller both CLAIMS and the workspace actually holds server-side.
 *
 *   - `workspace === null` (no server-side source) ⇒ trust the claim unchanged.
 *   - otherwise ⇒ the INTERSECTION (by `entitlementKey`) — a caller whose token
 *     carries `customer-ops` from ANOTHER org is denied it in a workspace whose
 *     server-side cache lacks it. Never grants a SKU the claim did not carry.
 */
export function intersectEntitlements(claimed: string[], workspace: string[] | null): string[] {
  if (workspace == null) return [...claimed];
  const allow = new Set(workspace.map(entitlementKey));
  return claimed.filter((sku) => allow.has(entitlementKey(sku)));
}

/**
 * The EXPLICITLY-addressed workspace on a request, per SUITE-IDENTITY §D4
 * precedence: path param `workspaceId`/`workspace_id` > `X-Workspace-Id` header.
 * Returns null when neither is present (no implicit claim fallback — that's the
 * caller's job). Used by the PAT auth chokepoint to fence a token to its bound
 * workspace (a `co_pat_` for W1 can never act on an explicitly-addressed W2).
 */
export function explicitRequestedWorkspaceId(req: {
  params?: Record<string, any>;
  headers?: Record<string, any>;
}): string | null {
  const raw =
    req?.params?.workspaceId ?? req?.params?.workspace_id ?? req?.headers?.['x-workspace-id'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

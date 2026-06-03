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
// (`__workspaceClaim` = the token's `workspace_id`/`tenant_id`) and the acting
// uchub subject (`__ucUid` = the token `sub`, used for `app.uc_uid` attribution
// and as the Membership key). Both are non-persistent, request-scoped only.
export type WithWorkspaceClaim = User & {
  __workspaceClaim?: string | null;
  __ucUid?: string | null;
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

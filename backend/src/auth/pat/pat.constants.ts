/**
 * Personal Access Token constants.
 *
 * - PAT_PREFIX is the on-the-wire identifier the auth pipeline checks first to
 *   short-circuit JWT parsing. SUITE-IDENTITY §D9 reserves `co_pat_` for
 *   Customer-Ops.
 * - PAT_TOKEN_BYTES = 32 (256 bits, base64url → 43 chars) — well above what a
 *   bearer credential needs; matches the Project-Ops reference + GitHub PATs.
 * - PAT_BCRYPT_COST = 10.
 */
export const PAT_PREFIX = 'co_pat_';
export const PAT_TOKEN_BYTES = 32;
export const PAT_BCRYPT_COST = 10;

/**
 * Scopes that can be granted to a PAT — Customer-Ops surfaces (resource:action).
 * Single source of truth for the create-token UI (GET /auth/pats/scopes) and
 * mint-time validation.
 *
 * v1 NOTE: scopes are validated at MINT time (unknown scopes rejected) and are
 * ADVISORY at request time — a PAT-authenticated REST/MCP call still runs under
 * the owning user's full workspace RBAC (exactly like the Project-Ops v1). When
 * a CO MCP scope-dispatch gate is added later, enforce these via the same map
 * pattern PO uses (MCP_TOOL_SCOPE_MAP).
 */
export const PAT_AVAILABLE_SCOPES = [
  'read:customers',
  'write:customers',
  'read:activity',
  'write:activity',
  'read:leads',
  'write:leads',
  'read:overview',
  'run:agents',
] as const;

export type PatScope = (typeof PAT_AVAILABLE_SCOPES)[number];

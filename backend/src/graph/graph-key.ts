/**
 * The graph-key chokepoint — the ONE place a FalkorDB graph key is constructed.
 *
 * Customer-Ops keeps ONE FalkorDB graph PER workspace, keyed
 * `cust_ops:ws:<workspaceId>`. This is the graph plane's analogue of the app's
 * RLS chokepoint (PrismaService.withWorkspace, which sets the per-request GUC):
 * every read/write into the graph MUST resolve its key through this function, so
 * the per-workspace fence can never be bypassed by a hand-built key. Layered with
 * the redundant `workspaceId` property stamped on every node/edge (graph.service),
 * a cross-tenant write is impossible by construction — the key isolates the graph
 * and the property lets a query re-assert the tenant defensively.
 *
 * Validation is deliberately strict + fail-closed: an empty/garbage workspace id
 * must throw LOUDLY here rather than silently produce `cust_ops:ws:` (which would
 * collide every tenant into one shared graph). Mirrors withWorkspace's
 * "non-empty workspaceId" guard.
 */

/** The single key namespace prefix. Bump only with a graph migration. */
export const GRAPH_KEY_PREFIX = 'cust_ops:ws:';

/**
 * uc-registry workspace ids are uuid (v4/v7). Accept the canonical 8-4-4-4-12
 * hex form, case-insensitive, version/variant-lenient (uuidv7's version nibble
 * is 7; we don't pin the version so a future scheme still validates). This is an
 * INPUT-SHAPE guard (catch '', whitespace, an injection attempt, a slug) — not a
 * cryptographic check; the authz boundary is RLS + the bearer's workspace claim,
 * not this regex.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the per-workspace FalkorDB graph key. THE tenancy chokepoint — do not
 * construct this string anywhere else.
 *
 * @param workspaceId resolved canonical uc-registry workspace id (uuid).
 * @returns `cust_ops:ws:<workspaceId>` (workspaceId lower-cased for a stable key).
 * @throws Error when workspaceId is missing or not uuid-shaped (fail-closed).
 */
export function graphKeyFor(workspaceId: string): string {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
    throw new Error('graphKeyFor requires a non-empty workspaceId');
  }
  const id = workspaceId.trim();
  if (!UUID_RE.test(id)) {
    // Fail closed + DO NOT echo the raw value (it could carry an injection
    // payload that lands in a log). Report only that the shape was rejected.
    throw new Error('graphKeyFor: workspaceId is not a valid uuid');
  }
  // Lower-case so the key is canonical regardless of the caller's casing — two
  // requests for the same workspace must address the same graph.
  return `${GRAPH_KEY_PREFIX}${id.toLowerCase()}`;
}

/** True when `workspaceId` would yield a valid graph key (no throw). Handy for
 *  callers that want to branch instead of catch. */
export function isValidWorkspaceId(workspaceId: unknown): workspaceId is string {
  return typeof workspaceId === 'string' && UUID_RE.test(workspaceId.trim());
}

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
 * Single source of truth for the create-token UI (GET /auth/pats/scopes),
 * mint-time validation, AND request-time enforcement.
 *
 * ENFORCED (was advisory in v1):
 *   - REST: deny-by-default. A PAT can only reach a route that declares its
 *     scope via `@RequireScopes(...)` and only if the token holds the scope
 *     (see jwt-auth.guard.ts). An un-annotated route is PAT-inaccessible.
 *   - MCP: each tool call is gated against MCP_TOOL_SCOPE_MAP below (fail-closed
 *     on an unmapped tool) — see mcp.service.ts.
 * A normal JWT session is unaffected: it always runs under the user's full
 * workspace RBAC, scopes never apply.
 */
export const PAT_AVAILABLE_SCOPES = [
  'read:quotes',
  'write:quotes',
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

/**
 * Scope implication: holding a `write:*` scope implies the matching `read:*`
 * (a token that can mutate a resource can obviously read it — the GitHub
 * fine-grained-PAT convention). Enforcement expands the granted set through
 * this map before checking a route/tool requirement, so a write-only token is
 * never surprisingly denied a read it strictly subsumes. `read:overview` and
 * `run:agents` stand alone.
 */
export const SCOPE_IMPLICATIONS: Record<string, PatScope[]> = {
  'write:quotes': ['read:quotes'],
  'write:customers': ['read:customers'],
  'write:activity': ['read:activity'],
  'write:leads': ['read:leads'],
};

/**
 * Expand a granted scope list to include everything it implies (write ⊇ read).
 * Pure; the single helper both the REST guard and the MCP gate check against.
 */
export function expandScopes(granted: readonly string[]): Set<string> {
  const set = new Set<string>(granted);
  for (const s of granted) {
    for (const implied of SCOPE_IMPLICATIONS[s] ?? []) set.add(implied);
  }
  return set;
}

/**
 * Maps an MCP tool name → the single scope a PAT-auth'd call must hold (after
 * write⊇read expansion). Kept in lock-step with the tools registered in
 * `mcp.service.ts`; an MCP tool with no entry here (and not in
 * MCP_TOOL_NO_SCOPE) fails CLOSED for a PAT caller rather than open. JWT/
 * federation callers ignore this map entirely (full RBAC). Mirrors the
 * Project-Ops MCP_TOOL_SCOPE_MAP convention.
 */
export const MCP_TOOL_SCOPE_MAP: Record<string, PatScope> = {
  render_quote: 'read:quotes',
  send_quote: 'write:quotes',
  supersede_quote: 'write:quotes',
  revoke_share_link: 'write:quotes',
  record_quote_acceptance: 'write:quotes',
  list_quote_versions: 'read:quotes',
  list_quote_events: 'read:quotes',
  create_quote: 'write:quotes',
  update_quote: 'write:quotes',
  add_quote_section: 'write:quotes',
  add_quote_line: 'write:quotes',
  update_quote_line: 'write:quotes',
  remove_quote_line: 'write:quotes',
  set_quote_options: 'write:quotes',
  set_quote_recipients: 'write:quotes',
  add_quote_cost: 'write:quotes',
  add_quote_attachment: 'write:quotes',
  list_quotes: 'read:quotes',
  get_quote: 'read:quotes',
  list_price_book: 'read:quotes',

  // read:customers — the relationship cockpit reads (+ federated sub-resources)
  list_customers: 'read:customers',
  get_customer_360: 'read:customers',
  pipeline_board: 'read:customers',
  list_customer_invoices: 'read:customers',
  list_customer_outreach: 'read:customers',
  list_customer_email: 'read:customers',
  list_customer_meetings: 'read:customers',
  // write:customers — relationship + federated-action mutations
  transition_customer_stage: 'write:customers',
  create_customer_invoice: 'write:customers',
  start_customer_campaign: 'write:customers',
  send_customer_email: 'write:customers',
  // write:activity — timeline writes (notes + inbound engagement)
  add_customer_note: 'write:activity',
  record_customer_engagement: 'write:activity',
  // run:agents — the draft-only relationship agents
  triage_customer: 'run:agents',
  draft_followup: 'run:agents',
  draft_collections_nudge: 'run:agents',
  // read:leads — intake observability
  lead_intake_stats: 'read:leads',
  list_lead_intakes: 'read:leads',
  // write:leads — intake mutations
  ingest_lead: 'write:leads',
  resolve_pending_leads: 'write:leads',
  discard_lead_intake: 'write:leads',
};

/**
 * MCP tools any authenticated PAT may call regardless of its scopes: liveness
 * and identity/whoami only (no tenant data beyond the caller's own membership
 * list). Everything else must be mapped above or it fails closed.
 */
export const MCP_TOOL_NO_SCOPE = new Set<string>(['health', 'list_my_workspaces']);

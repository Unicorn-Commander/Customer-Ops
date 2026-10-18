/**
 * The MCP per-tool access gate for Personal Access Token callers.
 *
 * The HTTP JwtAuthGuard cannot enforce MCP scopes/workspace: an MCP call is a
 * single `POST /mcp`, and the tool name + its `workspace_id` live in the
 * JSON-RPC body the guard never parses. So the gate runs INSIDE the tool
 * dispatch (McpService wraps every handler with it). It is a pure function so
 * the whole policy is unit-testable without the MCP SDK.
 *
 * Two enforcements, both PAT-only (a JWT/federation caller has `grantedScopes
 * == null` and passes straight through with full workspace RBAC):
 *
 *   1. WORKSPACE FENCE — a PAT is bound to one workspace. The HTTP guard fences
 *      a path/header workspace, but not the JSON-RPC `workspace_id` arg; without
 *      this, a PAT bound to W1 whose owner is also a member of W2 could address
 *      W2 via the arg. We reject an arg workspace that disagrees with the bound
 *      one (fail-closed), restoring the binding's blast-radius guarantee.
 *   2. SCOPE GATE — the tool's required scope (MCP_TOOL_SCOPE_MAP, write⊇read)
 *      must be held. An unmapped tool fails CLOSED; the health/whoami tools in
 *      MCP_TOOL_NO_SCOPE are exempt.
 */

import { WorkspaceRole } from '@prisma/client';
import { MCP_TOOL_NO_SCOPE, MCP_TOOL_SCOPE_MAP, expandScopes } from '../auth/pat/pat.constants';
import { roleMeetsMinimum } from '../common/workspace/workspace-role.util';

/** A tool-result envelope that surfaces a denial to the MCP client (not a throw). */
export interface McpDenial {
  isError: true;
  content: { type: 'text'; text: string }[];
}

function envelope(detail: Record<string, unknown>): McpDenial {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }] };
}

export function scopeDenial(
  toolName: string,
  required: string | undefined,
  granted: readonly string[],
): McpDenial {
  return envelope({
    error: 'scope_denied',
    tool: toolName,
    required_scope: required ?? '(no scope mapping — refusing to fail open)',
    granted_scopes: [...granted],
    hint: 'Mint a Personal Access Token with the required scope at Settings → API tokens.',
  });
}

export function workspaceDenial(toolName: string, bound: string, requested: string): McpDenial {
  return envelope({
    error: 'workspace_denied',
    tool: toolName,
    pat_workspace: bound,
    requested_workspace: requested,
    hint: 'This token is scoped to a single workspace. Mint a PAT for the target workspace, or omit workspace_id.',
  });
}

/**
 * Maps an MCP tool name → the MINIMUM workspace role the CALLING USER must hold
 * to invoke it. A mutation (or a draft-only agent run) requires MEMBER; a VIEWER
 * is refused. Read/list tools are ABSENT (viewer-level — no role gate). No MCP
 * tool manages members, so OWNER never appears here. This is the MCP mirror of
 * the REST `@RequireWorkspaceRole` annotations — an agent (JWT) and a human hit
 * the same role RBAC whichever transport they use.
 *
 * Unlike the PAT scope map, this is NOT deny-by-default: an unmapped tool is
 * treated as viewer-level (read). The mutation surface is closed and finite, so
 * enumerating the writers is the safe, legible choice; a NEW mutation tool must
 * be added here (the tests assert the roster stays in lock-step).
 */
export const MCP_TOOL_MIN_ROLE: Record<string, WorkspaceRole> = {
  send_quote: WorkspaceRole.MEMBER,
  supersede_quote: WorkspaceRole.MEMBER,
  revoke_share_link: WorkspaceRole.MEMBER,
  record_quote_acceptance: WorkspaceRole.OWNER,
  create_quote: WorkspaceRole.MEMBER,
  update_quote: WorkspaceRole.MEMBER,
  add_quote_section: WorkspaceRole.MEMBER,
  add_quote_line: WorkspaceRole.MEMBER,
  update_quote_line: WorkspaceRole.MEMBER,
  remove_quote_line: WorkspaceRole.MEMBER,
  set_quote_options: WorkspaceRole.MEMBER,
  set_quote_recipients: WorkspaceRole.MEMBER,
  add_quote_cost: WorkspaceRole.MEMBER,
  add_quote_attachment: WorkspaceRole.MEMBER,

  // Relationship + federated-action mutations.
  update_customer: WorkspaceRole.MEMBER,
  transition_customer_stage: WorkspaceRole.MEMBER,
  add_customer_note: WorkspaceRole.MEMBER,
  create_customer_invoice: WorkspaceRole.MEMBER,
  start_customer_campaign: WorkspaceRole.MEMBER,
  send_customer_email: WorkspaceRole.MEMBER,
  record_customer_engagement: WorkspaceRole.MEMBER,
  // Draft-only relationship agent runs (spend inference + read federated PII).
  triage_customer: WorkspaceRole.MEMBER,
  draft_followup: WorkspaceRole.MEMBER,
  draft_collections_nudge: WorkspaceRole.MEMBER,
  // Lead-intake mutations.
  ingest_lead: WorkspaceRole.MEMBER,
  resolve_pending_leads: WorkspaceRole.MEMBER,
  discard_lead_intake: WorkspaceRole.MEMBER,
};

/** The minimum workspace role an MCP tool requires, or null for a viewer-level read tool. */
export function mcpToolMinRole(toolName: string): WorkspaceRole | null {
  return MCP_TOOL_MIN_ROLE[toolName] ?? null;
}

export function roleDenial(
  toolName: string,
  required: WorkspaceRole,
  actual: WorkspaceRole | null,
): McpDenial {
  return envelope({
    error: 'role_denied',
    tool: toolName,
    required_role: String(required).toLowerCase(),
    your_role: actual ? String(actual).toLowerCase() : null,
    hint: 'This action requires at least the member role in this workspace; a viewer has read-only access.',
  });
}

/**
 * Evaluate one MCP tool call against the CALLING USER's workspace role. Returns
 * a denial envelope for a viewer attempting a mutation/agent-run, else `null`.
 * Pure (the caller resolves the role); the tenancy on/off gate lives in
 * McpService, exactly as the REST guard gates on the flag before it reads a role.
 *
 * @param toolName  the registered tool being invoked
 * @param role      the caller's resolved role in the target workspace (null = none)
 */
export function mcpRoleDenial(toolName: string, role: WorkspaceRole | null): McpDenial | null {
  const required = mcpToolMinRole(toolName);
  if (!required) return null; // viewer-level read tool — no role gate
  if (!roleMeetsMinimum(role, required)) return roleDenial(toolName, required, role);
  return null;
}

/**
 * Evaluate one MCP tool call. Returns a denial envelope to short-circuit the
 * handler, or `null` to allow it.
 *
 * @param toolName        the registered tool being invoked
 * @param args            the tool's JSON-RPC arguments (may carry `workspace_id`)
 * @param grantedScopes   the PAT's scopes, or `null` for a JWT/federation caller
 * @param boundWorkspaceId the PAT's bound workspace, or `null`
 */
export function mcpToolDenial(
  toolName: string,
  args: unknown,
  grantedScopes: string[] | null,
  boundWorkspaceId: string | null,
): McpDenial | null {
  // JWT / Brigade federation caller: no PAT gating (full workspace RBAC applies).
  if (!grantedScopes) return null;

  // 1. Workspace fence — the arg workspace_id must not escape the PAT's binding.
  //
  //    A PAT caller with NO bound workspace is denied outright rather than
  //    waved through. `personal_access_tokens.workspaceId` is nullable, and the
  //    fence used to be written `if (boundWorkspaceId) { … }` — so a NULL did
  //    not fail the check, it SKIPPED it, and an unbound PAT could name any
  //    workspace_id it wanted. PatService.findByPlaintext + JwtAuthGuard now
  //    both refuse such a token, so this is unreachable in the running app; it
  //    stays because this is a PURE policy function that other callers (tests,
  //    future transports) can invoke with whatever they hold, and "unbound" must
  //    mean deny at every one of the three fence sites, not at two of them.
  const wsArg = (args as { workspace_id?: unknown } | null | undefined)?.workspace_id;
  const requested = typeof wsArg === 'string' ? wsArg.trim() : '';
  if (!boundWorkspaceId) {
    return workspaceDenial(
      toolName,
      '(none — token has no bound workspace)',
      requested || '(none)',
    );
  }
  if (requested && requested !== boundWorkspaceId) {
    return workspaceDenial(toolName, boundWorkspaceId, requested);
  }

  // 2. Scope gate — health/whoami are exempt; everything else must be mapped
  //    and held (write⊇read); an unmapped tool fails closed.
  if (MCP_TOOL_NO_SCOPE.has(toolName)) return null;
  const required = MCP_TOOL_SCOPE_MAP[toolName];
  if (!required) return scopeDenial(toolName, undefined, grantedScopes);
  if (!expandScopes(grantedScopes).has(required)) {
    return scopeDenial(toolName, required, grantedScopes);
  }
  return null;
}

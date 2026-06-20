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

import {
  MCP_TOOL_NO_SCOPE,
  MCP_TOOL_SCOPE_MAP,
  expandScopes,
} from '../auth/pat/pat.constants';

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
  if (boundWorkspaceId) {
    const wsArg = (args as { workspace_id?: unknown } | null | undefined)?.workspace_id;
    const requested = typeof wsArg === 'string' ? wsArg.trim() : '';
    if (requested && requested !== boundWorkspaceId) {
      return workspaceDenial(toolName, boundWorkspaceId, requested);
    }
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

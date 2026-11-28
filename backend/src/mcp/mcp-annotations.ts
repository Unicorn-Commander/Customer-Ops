import { MCP_TOOL_NO_SCOPE } from '../auth/pat/pat.constants';

/**
 * The MCP ToolAnnotations subset we emit (mirrors the SDK's ToolAnnotations).
 * Kept inline rather than imported from the SDK because the SDK's `types.js`
 * subpath is ESM-only (no `require` condition) and does not type-resolve under
 * this repo's CommonJS tsconfig; the structure is identical, so the object we
 * build assigns cleanly into the SDK's `config.annotations` field.
 */
interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * MCP ToolAnnotations for one tool, derived from the PAT scope map.
 *
 * Web ChatGPT and Claude use these hints to decide which tool calls need a
 * confirmation click before executing; without them every tool looks like a
 * write. The read/write truth already lives in MCP_TOOL_SCOPE_MAP — this pure
 * function projects it onto the MCP annotation schema. McpService wraps
 * server.registerTool once (before any tool is registered, so the quote tools
 * are covered too) and calls it with MCP_TOOL_SCOPE_MAP[name].
 *
 *   - a `read:*` tool            → readOnly, non-destructive, closed-world
 *   - a `write:*` tool           → not readOnly; destructive when the name
 *                                  starts with delete_/remove_/archive_;
 *                                  openWorld when it starts with send_
 *   - a `run:agents` tool        → readOnly: the relationship agents are
 *                                  DRAFT-ONLY (they return an assessment or a
 *                                  draft and NEVER auto-send/post/move a stage)
 *   - a tool in MCP_TOOL_NO_SCOPE (health, list_my_workspaces) → read-only
 *   - anything else (no scope)   → undefined: do not guess. A tool that is
 *                                  neither mapped nor scope-exempt must never
 *                                  be advertised with made-up hints; the
 *                                  spec test fails on it.
 *
 * `existing` (config.annotations, if any) is spread LAST — an author-provided
 * annotation always wins over the scope-derived default.
 *
 * Mirrors the Project-Ops F3 shape (PR MagicUnicorn/Project-Ops#168).
 */
export function mcpAnnotationsFor(
  name: string,
  scope: string | undefined,
  existing?: ToolAnnotations,
): ToolAnnotations | undefined {
  let annotations: ToolAnnotations;
  if (scope?.startsWith('read:') || scope === 'run:agents' || MCP_TOOL_NO_SCOPE.has(name)) {
    annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  } else if (scope?.startsWith('write:')) {
    annotations = {
      readOnlyHint: false,
      destructiveHint: /^(delete_|remove_|archive_)/.test(name),
      openWorldHint: name.startsWith('send_'),
    };
  } else {
    return undefined;
  }
  return { ...annotations, ...existing };
}

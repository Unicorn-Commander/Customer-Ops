import { WorkspaceRole } from '@prisma/client';

/**
 * Workspace role RBAC (SUITE-IDENTITY §7): the ordered privilege ladder the
 * cockpit enforces. A membership row STORES a `WorkspaceRole`; this is the ONE
 * place its ordering is defined, so the REST `WorkspaceRoleGuard` and the MCP
 * dispatch gate agree on what "at least MEMBER" means.
 *
 *   VIEWER  — read-only (GET / list tools). No mutation, no agent run.
 *   MEMBER  — the cockpit mutations + the draft-only agent runs.
 *   MANAGER — MEMBER + (reserved for future manager-only surfaces).
 *   ADMIN   — MANAGER + (reserved for future admin-only surfaces).
 *   OWNER   — everything, incl. member management (roles / removal).
 *
 * The ladder is monotone: a higher role satisfies every lower requirement, so a
 * single `>=` compares any role against any minimum (mirrors the write⊇read PAT
 * scope convention).
 */
export const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  [WorkspaceRole.VIEWER]: 0,
  [WorkspaceRole.MEMBER]: 1,
  [WorkspaceRole.MANAGER]: 2,
  [WorkspaceRole.ADMIN]: 3,
  [WorkspaceRole.OWNER]: 4,
};

/**
 * True iff `role` meets (equals or exceeds) `minimum`. A null/undefined role —
 * a non-member, or a caller whose membership could not be resolved — never
 * meets any requirement (fail-closed).
 */
export function roleMeetsMinimum(
  role: WorkspaceRole | null | undefined,
  minimum: WorkspaceRole,
): boolean {
  if (!role) return false;
  return WORKSPACE_ROLE_RANK[role] >= WORKSPACE_ROLE_RANK[minimum];
}

import { SetMetadata } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';

export const REQUIRE_WORKSPACE_ROLE_KEY = 'requiredWorkspaceRole';

/**
 * Declare the MINIMUM workspace role a route requires. Read by the
 * `WorkspaceRoleGuard`, which resolves the caller's membership role in the
 * resolved workspace and 403s a caller below the bar (VIEWER on a mutation, a
 * non-OWNER on member management).
 *
 * Semantics (the guard is inert while tenancy is off — see WorkspaceRoleGuard):
 *
 *   @RequireWorkspaceRole(WorkspaceRole.MEMBER)  a mutation / agent-run route:
 *                                                VIEWER is refused; MEMBER+ pass.
 *   @RequireWorkspaceRole(WorkspaceRole.OWNER)   member-management routes.
 *   (no decorator)                               VIEWER-level: any active member
 *                                                (GET / list). Role is not gated.
 *
 * This is the workspace-RBAC analog of `@RequireScopes` (which gates a PAT); a
 * route can carry both — scopes fence a PAT, role fences the acting user, and a
 * request must clear whichever apply.
 */
export const RequireWorkspaceRole = (role: WorkspaceRole) =>
  SetMetadata(REQUIRE_WORKSPACE_ROLE_KEY, role);

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { User, WorkspaceRole } from '@prisma/client';
import { REQUIRE_WORKSPACE_ROLE_KEY } from '../../auth/decorators/require-workspace-role.decorator';
import { MembershipService } from './membership.service';
import { tenancyEnabled } from './feature-flags';
import { defaultWorkspaceId, resolveWorkspaceId, WithWorkspaceClaim } from './workspace.util';
import { roleMeetsMinimum } from './workspace-role.util';

/**
 * Workspace ROLE RBAC gate (SUITE-IDENTITY §7). The companion to
 * WorkspaceMembershipGuard: that one proves the caller BELONGS to the workspace;
 * this one proves they hold a high-enough ROLE for the action.
 *
 * A route opts in with `@RequireWorkspaceRole(WorkspaceRole.MEMBER|OWNER|…)`.
 * The guard resolves the caller's membership role in the request's workspace and
 * 403s anyone below the bar — so a VIEWER can read (un-annotated GET routes) but
 * is refused every mutation + agent run, and only an OWNER manages members. It
 * closes the gap where all cockpit mutations relied on `@RequireScopes`, which
 * a JWT session ignores entirely (no role RBAC existed behind it).
 *
 * Workspace resolution mirrors WorkspaceMembershipGuard's precedence and prefers
 * the id that guard already stashed on `req.workspaceId` (path param → header →
 * claim). A route that runs this guard WITHOUT the membership guard (e.g. the
 * m365 connector, which resolves its workspace server-side) is handled too: we
 * fall back to resolving + authorizing membership here.
 *
 * Rollout-safety: like every tenancy gate, this is a NO-OP while
 * CUSTOMER_OPS_TENANCY_ENABLED is off (its default). With the flag off there are
 * no membership rows to carry a role, so role enforcement is skipped and today's
 * single-tenant behavior is preserved exactly. It only bites once tenancy is live.
 */
@Injectable()
export class WorkspaceRoleGuard implements CanActivate {
  private readonly logger = new Logger(WorkspaceRoleGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly membership: MembershipService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const required = this.reflector.getAllAndOverride<WorkspaceRole | undefined>(
      REQUIRE_WORKSPACE_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    // No role requirement → VIEWER-level (any active member); nothing to gate.
    if (!required) return true;

    // Inert while tenancy is off: no membership rows exist to carry a role, so
    // enforcing one would 403 everyone. Preserves today's single-tenant behavior.
    if (!tenancyEnabled((k) => this.config.get<string>(k))) return true;

    const req = context.switchToHttp().getRequest();
    const user: (User & Partial<WithWorkspaceClaim>) | undefined = req?.user;
    if (!user) {
      // No authenticated user — let the auth guard own the 401; don't mask it.
      throw new ForbiddenException('Authentication required.');
    }

    // Prefer the workspace the membership guard already resolved + stashed. If
    // this guard runs alone (no membership guard on the route), resolve it here —
    // which also authorizes membership (throws 403 for a non-member).
    let workspaceId: string | undefined = req?.workspaceId;
    if (!workspaceId) {
      const requested =
        req?.params?.workspaceId ??
        req?.params?.workspace_id ??
        req?.headers?.['x-workspace-id'] ??
        resolveWorkspaceId(user, defaultWorkspaceId());
      workspaceId = await this.membership.resolveAndAuthorize(user, requested);
      req.workspaceId = workspaceId;
    }

    const role = await this.membership.roleInWorkspace(user, workspaceId);
    if (!roleMeetsMinimum(role, required)) {
      this.logger.warn(
        `403 workspace role for ${user.email} in ${workspaceId}: has ${role ?? 'none'}, ` +
          `route requires ${required}`,
      );
      throw new ForbiddenException(
        `This action requires at least the ${String(required).toLowerCase()} role in this workspace.`,
      );
    }
    return true;
  }
}

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
import { WorkspaceRoleGuard } from './workspace-role.guard';
import { REQUIRE_WORKSPACE_ROLE_KEY } from '../../auth/decorators/require-workspace-role.decorator';

const WS = '0190a000-7e57-7000-8000-00000000c007';
const aaron = { id: 'u1', email: 'aaron@magicunicorn.tech', keycloakId: 'kc-1' } as any;

/**
 * Build a fake ExecutionContext. `requiredRole` is what the Reflector returns
 * for the `@RequireWorkspaceRole` metadata key.
 */
function makeCtx(opts: {
  type?: string;
  request?: any;
  requiredRole?: WorkspaceRole | undefined;
}): { ctx: ExecutionContext; reflector: any } {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === REQUIRE_WORKSPACE_ROLE_KEY ? opts.requiredRole : undefined,
    ),
  };
  const ctx = {
    getType: () => opts.type ?? 'http',
    switchToHttp: () => ({ getRequest: () => opts.request ?? {} }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  return { ctx, reflector };
}

function makeGuard(
  reflector: any,
  opts: {
    tenancyEnabled?: boolean;
    roleInWorkspace?: jest.Mock;
    resolveAndAuthorize?: jest.Mock;
  } = {},
) {
  const config = {
    get: jest.fn((k: string) =>
      k === 'CUSTOMER_OPS_TENANCY_ENABLED' ? (opts.tenancyEnabled ? 'true' : 'false') : undefined,
    ),
  };
  const membership = {
    roleInWorkspace: opts.roleInWorkspace ?? jest.fn(),
    resolveAndAuthorize: opts.resolveAndAuthorize ?? jest.fn().mockResolvedValue(WS),
  };
  return {
    guard: new WorkspaceRoleGuard(reflector as any, membership as any, config as any),
    membership,
  };
}

describe('WorkspaceRoleGuard', () => {
  it('non-http execution contexts pass through', async () => {
    const { ctx, reflector } = makeCtx({ type: 'rpc', requiredRole: WorkspaceRole.MEMBER });
    const { guard } = makeGuard(reflector, { tenancyEnabled: true });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('a route with no @RequireWorkspaceRole passes (VIEWER-level GET reads)', async () => {
    const { ctx, reflector } = makeCtx({ requiredRole: undefined, request: { user: aaron } });
    const role = jest.fn();
    const { guard } = makeGuard(reflector, { tenancyEnabled: true, roleInWorkspace: role });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(role).not.toHaveBeenCalled(); // no lookup when there's no requirement
  });

  it('is INERT while tenancy is off — a VIEWER passes a MEMBER route (today’s behavior)', async () => {
    const { ctx, reflector } = makeCtx({
      requiredRole: WorkspaceRole.MEMBER,
      request: { user: aaron, workspaceId: WS },
    });
    const role = jest.fn().mockResolvedValue(WorkspaceRole.VIEWER);
    const { guard } = makeGuard(reflector, { tenancyEnabled: false, roleInWorkspace: role });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(role).not.toHaveBeenCalled(); // gated off before any role lookup
  });

  describe('tenancy live', () => {
    it('403s a VIEWER on a MEMBER-required (mutation) route', async () => {
      const { ctx, reflector } = makeCtx({
        requiredRole: WorkspaceRole.MEMBER,
        request: { user: aaron, workspaceId: WS },
      });
      const { guard } = makeGuard(reflector, {
        tenancyEnabled: true,
        roleInWorkspace: jest.fn().mockResolvedValue(WorkspaceRole.VIEWER),
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows a MEMBER on a MEMBER-required route', async () => {
      const { ctx, reflector } = makeCtx({
        requiredRole: WorkspaceRole.MEMBER,
        request: { user: aaron, workspaceId: WS },
      });
      const { guard } = makeGuard(reflector, {
        tenancyEnabled: true,
        roleInWorkspace: jest.fn().mockResolvedValue(WorkspaceRole.MEMBER),
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('403s a MEMBER on an OWNER-required (member-management) route', async () => {
      const { ctx, reflector } = makeCtx({
        requiredRole: WorkspaceRole.OWNER,
        request: { user: aaron, workspaceId: WS },
      });
      const { guard } = makeGuard(reflector, {
        tenancyEnabled: true,
        roleInWorkspace: jest.fn().mockResolvedValue(WorkspaceRole.MEMBER),
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows an OWNER on an OWNER-required route (and on a MEMBER route)', async () => {
      const owner = jest.fn().mockResolvedValue(WorkspaceRole.OWNER);
      const ownerCtx = makeCtx({
        requiredRole: WorkspaceRole.OWNER,
        request: { user: aaron, workspaceId: WS },
      });
      const g1 = makeGuard(ownerCtx.reflector, { tenancyEnabled: true, roleInWorkspace: owner });
      await expect(g1.guard.canActivate(ownerCtx.ctx)).resolves.toBe(true);

      const memberCtx = makeCtx({
        requiredRole: WorkspaceRole.MEMBER,
        request: { user: aaron, workspaceId: WS },
      });
      const g2 = makeGuard(memberCtx.reflector, { tenancyEnabled: true, roleInWorkspace: owner });
      await expect(g2.guard.canActivate(memberCtx.ctx)).resolves.toBe(true);
    });

    it('403s a non-member (no role resolved) on a MEMBER route — fail closed', async () => {
      const { ctx, reflector } = makeCtx({
        requiredRole: WorkspaceRole.MEMBER,
        request: { user: aaron, workspaceId: WS },
      });
      const { guard } = makeGuard(reflector, {
        tenancyEnabled: true,
        roleInWorkspace: jest.fn().mockResolvedValue(null),
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('resolves + authorizes the workspace itself when no membership guard ran (m365 shape)', async () => {
      // No req.workspaceId (m365 controller resolves its workspace server-side).
      const { ctx, reflector } = makeCtx({
        requiredRole: WorkspaceRole.MEMBER,
        request: { user: aaron, params: {}, headers: {} },
      });
      const resolve = jest.fn().mockResolvedValue(WS);
      const { guard } = makeGuard(reflector, {
        tenancyEnabled: true,
        resolveAndAuthorize: resolve,
        roleInWorkspace: jest.fn().mockResolvedValue(WorkspaceRole.MEMBER),
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(resolve).toHaveBeenCalledWith(aaron, expect.any(String));
    });

    it('403s when no authenticated user is on the request', async () => {
      const { ctx, reflector } = makeCtx({
        requiredRole: WorkspaceRole.MEMBER,
        request: {},
      });
      const { guard } = makeGuard(reflector, { tenancyEnabled: true });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

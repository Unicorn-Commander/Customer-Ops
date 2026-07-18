import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MembershipStatus, User, WorkspaceRole } from '@prisma/client';
import { MembershipService } from './membership.service';
import { PrismaService } from '../../prisma/prisma.service';
import { __resetAccessListCacheForTests } from '../../auth/access-list';

const BOOTSTRAP = '0190a000-7e57-7000-8000-00000000c007';

/**
 * MembershipService is the workspace-access gate (SUITE-IDENTITY §D5). The
 * load-bearing guarantees pinned here:
 *   - Flag OFF (default) => total no-op: resolves to default, never throws,
 *     never touches membership. (Rollout-safety: nothing breaks today.)
 *   - Flag ON => membership gates: 403 without a membership; allow-listed
 *     users are seeded JIT into the bootstrap workspace; the requested
 *     workspace must be one the user belongs to.
 */
describe('MembershipService', () => {
  const aaron = {
    id: 'local-aaron',
    email: 'aaron@magicunicorn.tech',
    keycloakId: 'kc-aaron-sub',
  } as User;

  const stranger = {
    id: 'local-stranger',
    email: 'nobody@example.com',
    keycloakId: 'kc-stranger-sub',
  } as User;

  function make(env: Record<string, string | undefined>, prismaMock: any) {
    const config = {
      get: (k: string, def?: unknown) => (k in env ? env[k] : def),
    } as unknown as ConfigService;
    return new MembershipService(prismaMock as PrismaService, config);
  }

  beforeEach(() => {
    __resetAccessListCacheForTests();
    delete process.env.CUSTOMER_OPS_ACCESS_LIST; // legacy fallback (Aaron+Shafen OWNER)
  });

  describe('flag OFF (default)', () => {
    const prisma = { membership: {}, workspace: {} };

    it('resolveAndAuthorize returns the requested workspace without a membership check', async () => {
      const svc = make({ DEFAULT_WORKSPACE_ID: BOOTSTRAP }, prisma);
      await expect(svc.resolveAndAuthorize(aaron, 'W-requested')).resolves.toBe('W-requested');
    });

    it('falls back to the default workspace when none requested', async () => {
      const svc = make({ DEFAULT_WORKSPACE_ID: BOOTSTRAP }, prisma);
      await expect(svc.resolveAndAuthorize(aaron, null)).resolves.toBe(BOOTSTRAP);
    });

    it('never throws for a non-allow-listed user when the flag is off', async () => {
      const svc = make({ DEFAULT_WORKSPACE_ID: BOOTSTRAP }, prisma);
      await expect(svc.resolveAndAuthorize(stranger, null)).resolves.toBe(BOOTSTRAP);
    });
  });

  describe('flag ON', () => {
    const ON = { CUSTOMER_OPS_TENANCY_ENABLED: 'true', DEFAULT_WORKSPACE_ID: BOOTSTRAP };

    it('403s a user with no active membership (non-allow-listed, no seed)', async () => {
      const prisma = {
        membership: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        workspace: { findUnique: jest.fn().mockResolvedValue({ id: BOOTSTRAP }) },
      };
      const svc = make(ON, prisma);
      await expect(svc.resolveAndAuthorize(stranger, null)).rejects.toThrow(ForbiddenException);
      expect(prisma.membership.findMany).toHaveBeenCalled();
    });

    it('seeds an allow-listed user JIT, then resolves their default workspace', async () => {
      const created = {
        userKey: 'kc-aaron-sub',
        workspaceId: BOOTSTRAP,
        role: WorkspaceRole.OWNER,
        status: MembershipStatus.ACTIVE,
        isDefault: true,
      };
      const prisma = {
        membership: {
          findFirst: jest.fn().mockResolvedValue(null), // no existing membership -> seed
          upsert: jest.fn().mockResolvedValue(created),
          findMany: jest.fn().mockResolvedValue([created]),
        },
        workspace: { findUnique: jest.fn().mockResolvedValue({ id: BOOTSTRAP }) },
      };
      const svc = make(ON, prisma);
      await expect(svc.resolveAndAuthorize(aaron, null)).resolves.toBe(BOOTSTRAP);
      expect(prisma.membership.upsert).toHaveBeenCalledTimes(1);
      const arg = prisma.membership.upsert.mock.calls[0][0];
      expect(arg.create.role).toBe(WorkspaceRole.OWNER); // access-list OWNER -> OWNER
      expect(arg.create.userKey).toBe('kc-aaron-sub'); // keyed by keycloakId/sub
    });

    it('403s when the requested workspace is not one the user belongs to', async () => {
      const member = {
        userKey: 'kc-aaron-sub',
        workspaceId: BOOTSTRAP,
        status: MembershipStatus.ACTIVE,
        isDefault: true,
      };
      const prisma = {
        membership: {
          findFirst: jest.fn().mockResolvedValue(member),
          findMany: jest.fn().mockResolvedValue([member]),
        },
        workspace: { findUnique: jest.fn().mockResolvedValue({ id: BOOTSTRAP }) },
      };
      const svc = make(ON, prisma);
      await expect(svc.resolveAndAuthorize(aaron, 'SOME-OTHER-WS')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('allows the requested workspace when the user is a member of it', async () => {
      const member = {
        userKey: 'kc-aaron-sub',
        workspaceId: BOOTSTRAP,
        status: MembershipStatus.ACTIVE,
        isDefault: true,
      };
      const prisma = {
        membership: {
          findFirst: jest.fn().mockResolvedValue(member),
          findMany: jest.fn().mockResolvedValue([member]),
        },
        workspace: { findUnique: jest.fn().mockResolvedValue({ id: BOOTSTRAP }) },
      };
      const svc = make(ON, prisma);
      await expect(svc.resolveAndAuthorize(aaron, BOOTSTRAP)).resolves.toBe(BOOTSTRAP);
    });
  });

  describe('membershipKey + role mapping', () => {
    it('keys by keycloakId (uchub sub) when present, else local id', () => {
      expect(MembershipService.membershipKey({ id: 'L', keycloakId: 'kc' } as User)).toBe('kc');
      expect(MembershipService.membershipKey({ id: 'L', keycloakId: null } as User)).toBe('L');
    });

    it('passes canonical suite WorkspaceRoles through unchanged (SUITE-IDENTITY §7)', () => {
      expect(MembershipService.suiteRoleForAccess(WorkspaceRole.OWNER)).toBe(WorkspaceRole.OWNER);
      expect(MembershipService.suiteRoleForAccess(WorkspaceRole.MEMBER)).toBe(WorkspaceRole.MEMBER);
      expect(MembershipService.suiteRoleForAccess(WorkspaceRole.VIEWER)).toBe(WorkspaceRole.VIEWER);
    });
  });

  describe('workspace member management (roster + owner-gated mutations)', () => {
    const m = (userKey: string, role: WorkspaceRole, status: MembershipStatus = MembershipStatus.ACTIVE) => ({
      userKey,
      workspaceId: BOOTSTRAP,
      role,
      status,
      isDefault: role === WorkspaceRole.OWNER,
      createdAt: new Date('2026-06-01T00:00:00Z'),
    });

    it('listWorkspaceMembers resolves user display, flags is_you + is_service, excludes REVOKED', async () => {
      const prisma = {
        membership: {
          findMany: jest.fn().mockResolvedValue([
            m('kc-aaron-sub', WorkspaceRole.OWNER),
            m('federation:customer-ops', WorkspaceRole.MEMBER), // no user row -> service
          ]),
        },
        user: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'local-aaron', keycloakId: 'kc-aaron-sub', email: 'aaron@magicunicorn.tech', firstName: 'Aaron', lastName: 'S', username: 'aaron', lastLoginAt: null },
            ]),
        },
      };
      const svc = make({}, prisma);
      const rows = await svc.listWorkspaceMembers(BOOTSTRAP, aaron);
      // The findMany filter excludes REVOKED (status: { not: REVOKED }).
      expect(prisma.membership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: BOOTSTRAP, status: { not: MembershipStatus.REVOKED } } }),
      );
      const owner = rows.find((r) => r.user_key === 'kc-aaron-sub')!;
      expect(owner.role).toBe('owner');
      expect(owner.is_you).toBe(true);
      expect(owner.is_service).toBe(false);
      expect(owner.display_name).toBe('Aaron S');
      const svcRow = rows.find((r) => r.user_key === 'federation:customer-ops')!;
      expect(svcRow.is_service).toBe(true);
      expect(svcRow.email).toBeNull();
      expect(svcRow.is_you).toBe(false);
    });

    it('roleInWorkspace returns the active role, null for an inactive/absent membership', async () => {
      const prisma = {
        membership: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(m('kc-aaron-sub', WorkspaceRole.OWNER))
            .mockResolvedValueOnce(m('kc-x', WorkspaceRole.MEMBER, MembershipStatus.REVOKED))
            .mockResolvedValueOnce(null),
        },
      };
      const svc = make({}, prisma);
      await expect(svc.roleInWorkspace(aaron, BOOTSTRAP)).resolves.toBe(WorkspaceRole.OWNER);
      await expect(svc.roleInWorkspace(aaron, BOOTSTRAP)).resolves.toBeNull();
      await expect(svc.roleInWorkspace(aaron, BOOTSTRAP)).resolves.toBeNull();
    });

    it('assertOwner passes for an OWNER and 403s a non-owner', async () => {
      const ownerPrisma = { membership: { findUnique: jest.fn().mockResolvedValue(m('kc-aaron-sub', WorkspaceRole.OWNER)) } };
      await expect(make({}, ownerPrisma).assertOwner(aaron, BOOTSTRAP)).resolves.toBeUndefined();
      const memberPrisma = { membership: { findUnique: jest.fn().mockResolvedValue(m('kc-aaron-sub', WorkspaceRole.MEMBER)) } };
      await expect(make({}, memberPrisma).assertOwner(aaron, BOOTSTRAP)).rejects.toThrow(ForbiddenException);
    });

    it('setMemberRole updates the role, 404s a non-member, no-ops an unchanged role', async () => {
      const update = jest.fn().mockResolvedValue(m('kc-bob', WorkspaceRole.ADMIN));
      const prisma = {
        membership: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(m('kc-bob', WorkspaceRole.MEMBER)) // change path
            .mockResolvedValueOnce(null) // 404 path
            .mockResolvedValueOnce(m('kc-bob', WorkspaceRole.ADMIN)), // no-op path
          count: jest.fn().mockResolvedValue(2),
          update,
        },
      };
      const svc = make({}, prisma);
      await expect(svc.setMemberRole(BOOTSTRAP, 'kc-bob', WorkspaceRole.ADMIN)).resolves.toBeTruthy();
      expect(update).toHaveBeenCalledTimes(1);
      await expect(svc.setMemberRole(BOOTSTRAP, 'kc-bob', WorkspaceRole.ADMIN)).rejects.toThrow(NotFoundException);
      await svc.setMemberRole(BOOTSTRAP, 'kc-bob', WorkspaceRole.ADMIN); // unchanged -> no extra update
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('setMemberRole refuses to demote the LAST owner', async () => {
      const prisma = {
        membership: {
          findUnique: jest.fn().mockResolvedValue(m('kc-aaron-sub', WorkspaceRole.OWNER)),
          count: jest.fn().mockResolvedValue(1), // only one active owner
          update: jest.fn(),
        },
      };
      const svc = make({}, prisma);
      await expect(svc.setMemberRole(BOOTSTRAP, 'kc-aaron-sub', WorkspaceRole.ADMIN)).rejects.toThrow(BadRequestException);
      expect(prisma.membership.update).not.toHaveBeenCalled();
    });

    it('revokeMember soft-revokes, but refuses to remove the LAST owner', async () => {
      const update = jest.fn().mockResolvedValue(m('kc-bob', WorkspaceRole.MEMBER, MembershipStatus.REVOKED));
      const okPrisma = {
        membership: { findUnique: jest.fn().mockResolvedValue(m('kc-bob', WorkspaceRole.MEMBER)), count: jest.fn().mockResolvedValue(1), update },
      };
      const revoked = await make({}, okPrisma).revokeMember(BOOTSTRAP, 'kc-bob');
      expect(revoked.status).toBe(MembershipStatus.REVOKED);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: MembershipStatus.REVOKED, isDefault: false } }),
      );
      const lastOwnerPrisma = {
        membership: { findUnique: jest.fn().mockResolvedValue(m('kc-aaron-sub', WorkspaceRole.OWNER)), count: jest.fn().mockResolvedValue(1), update: jest.fn() },
      };
      await expect(make({}, lastOwnerPrisma).revokeMember(BOOTSTRAP, 'kc-aaron-sub')).rejects.toThrow(BadRequestException);
    });
  });

  // ── Kill switch: workspace-scoped, runtime-mutable (Workspace.agentsPaused) ──
  describe('kill switch (agentsPaused)', () => {
    const WS_A = 'ws-a';
    const WS_B = 'ws-b';

    it('areAgentsPaused reflects the workspace row, PER workspace', async () => {
      const findUnique = jest.fn(({ where: { id } }: any) =>
        Promise.resolve(id === WS_A ? { agentsPaused: true } : { agentsPaused: false }),
      );
      const svc = make({}, { workspace: { findUnique } });
      await expect(svc.areAgentsPaused(WS_A)).resolves.toBe(true); // paused
      await expect(svc.areAgentsPaused(WS_B)).resolves.toBe(false); // not paused
      // Read at CALL time (runtime) — one DB read per check, no boot snapshot.
      expect(findUnique).toHaveBeenCalledTimes(2);
    });

    it('areAgentsPaused defaults to false when the workspace mirror is absent', async () => {
      const svc = make({}, { workspace: { findUnique: jest.fn().mockResolvedValue(null) } });
      await expect(svc.areAgentsPaused('missing')).resolves.toBe(false);
    });

    it('assertAgentsNotPaused throws 403 when engaged, resolves when not — per workspace', async () => {
      const findUnique = jest.fn(({ where: { id } }: any) =>
        Promise.resolve(id === WS_A ? { agentsPaused: true } : { agentsPaused: false }),
      );
      const svc = make({}, { workspace: { findUnique } });
      await expect(svc.assertAgentsNotPaused(WS_A)).rejects.toThrow(ForbiddenException);
      await expect(svc.assertAgentsNotPaused(WS_A)).rejects.toThrow(/paused/i);
      await expect(svc.assertAgentsNotPaused(WS_B)).resolves.toBeUndefined();
    });

    it('setAgentsPaused flips the flag on the workspace row and returns the new state', async () => {
      const update = jest.fn().mockResolvedValue({ agentsPaused: true });
      const prisma = {
        workspace: {
          findUnique: jest.fn().mockResolvedValue({ id: WS_A }), // getWorkspaceOrThrow
          update,
        },
      };
      const svc = make({}, prisma);
      await expect(svc.setAgentsPaused(WS_A, true)).resolves.toBe(true);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: WS_A }, data: { agentsPaused: true } }),
      );
    });

    it('setAgentsPaused 404s when the workspace mirror is absent', async () => {
      const svc = make({}, { workspace: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() } });
      await expect(svc.setAgentsPaused('missing', true)).rejects.toThrow(NotFoundException);
    });
  });
});

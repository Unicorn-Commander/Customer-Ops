import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceProvisioningService } from '../common/workspace/workspace-provisioning.service';
import { MembershipService } from '../common/workspace/membership.service';
import { __resetAccessListCacheForTests } from './access-list';

/**
 * The JIT gate (validateKeycloakUser, SUITE-IDENTITY §D5) under both signup
 * modes. The contract this pins:
 *   - invite mode (DEFAULT): a stranger (no User, no allow-list match) is
 *     REJECTED — today's exact behavior, unchanged.
 *   - open mode: that same stranger is SELF-SERVE provisioned (their own
 *     workspace + OWNER membership) instead of rejected.
 *   - an allow-list user is UNCHANGED in BOTH modes (allow-list match wins; it
 *     creates the plain User row and NEVER calls the self-serve provisioner).
 *   - the self-serve path is degrade-clean end-to-end (uc-registry unreachable
 *     still yields a user — the provisioner returns a local-fallback workspace).
 */
describe('AuthService.validateKeycloakUser — signup modes', () => {
  const STRANGER_SUB = 'kc-stranger';
  const stranger = {
    sub: STRANGER_SUB,
    email: 'nobody@example.com',
    preferred_username: 'nobody',
    given_name: 'No',
    family_name: 'Body',
  };
  const aaron = {
    sub: 'kc-aaron',
    email: 'aaron@magicunicorn.tech', // on the legacy-fallback allow-list (OWNER)
    preferred_username: 'aaron',
  };

  function makeService(opts?: { findUniqueResult?: any; provision?: jest.Mock }) {
    const userRow = (data: any): User =>
      ({ id: 'local-' + (data.keycloakId ?? 'x'), isActive: true, ...data }) as User;

    const prisma = {
      user: {
        findUnique: jest.fn(async () => opts?.findUniqueResult ?? null),
        create: jest.fn(async ({ data }: any) => userRow(data)),
        update: jest.fn(async ({ data }: any) => ({ ...data })),
      },
    } as unknown as PrismaService;

    const provisioning = {
      provisionSelfServeUser:
        opts?.provision ??
        jest.fn(async (identity: any) => ({
          user: userRow({
            email: identity.email,
            keycloakId: identity.keycloakId,
            username: identity.username,
          }),
          workspaceId: '0190a000-7e57-7000-8000-0000000000aa',
          membership: {},
          workspaceIdSource: 'uc-registry',
        })),
    } as unknown as WorkspaceProvisioningService;

    const membership = {
      ensureSeededMembership: jest.fn(async () => undefined),
    } as unknown as MembershipService;
    const jwt = { sign: jest.fn(() => 'tok') } as unknown as JwtService;
    const svc = new AuthService(jwt, prisma, provisioning, membership);
    return { svc, prisma, provisioning, membership };
  }

  beforeEach(() => {
    __resetAccessListCacheForTests();
    delete process.env.CUSTOMER_OPS_ACCESS_LIST; // legacy fallback (Aaron+Shafen OWNER)
    delete process.env.CUSTOMER_OPS_SIGNUP_MODE;
  });
  afterEach(() => {
    delete process.env.CUSTOMER_OPS_SIGNUP_MODE;
    jest.restoreAllMocks();
  });

  describe('invite mode (default)', () => {
    it('rejects a stranger (no User row, no allow-list match) — unchanged', async () => {
      const { svc, provisioning } = makeService();
      await expect(svc.validateKeycloakUser(STRANGER_SUB, stranger)).rejects.toThrow(
        UnauthorizedException,
      );
      // The self-serve provisioner is NEVER touched in invite mode.
      expect(provisioning.provisionSelfServeUser).not.toHaveBeenCalled();
    });

    it('an unset CUSTOMER_OPS_SIGNUP_MODE behaves as invite (fail-safe)', async () => {
      delete process.env.CUSTOMER_OPS_SIGNUP_MODE;
      const { svc } = makeService();
      await expect(svc.validateKeycloakUser(STRANGER_SUB, stranger)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('a typo signup mode also fails safe to invite (rejects the stranger)', async () => {
      process.env.CUSTOMER_OPS_SIGNUP_MODE = 'opn';
      const { svc } = makeService();
      await expect(svc.validateKeycloakUser(STRANGER_SUB, stranger)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('still seeds an allow-listed user the plain way (no self-serve provision)', async () => {
      const { svc, prisma, provisioning } = makeService();
      const user = await svc.validateKeycloakUser('kc-aaron', aaron);
      expect(user.email).toBe('aaron@magicunicorn.tech');
      expect(prisma.user.create).toHaveBeenCalledTimes(1); // plain create, allow-list path
      expect(provisioning.provisionSelfServeUser).not.toHaveBeenCalled();
    });

    it('seeds the allow-listed user membership at LOGIN (closes the first-login chicken-and-egg)', async () => {
      const { svc, membership } = makeService();
      const user = await svc.validateKeycloakUser('kc-aaron', aaron);
      expect(membership.ensureSeededMembership).toHaveBeenCalledTimes(1);
      expect(membership.ensureSeededMembership).toHaveBeenCalledWith(user);
    });
  });

  describe('entitlement claim baked into the session token (enforce browser path)', () => {
    it('stamps verified entitlements off the profile and bakes them into the minted token', async () => {
      const { svc } = makeService();
      const user = await svc.validateKeycloakUser('kc-aaron', {
        ...aaron,
        entitlements: ['customer-ops', 'ai-metered'],
      });
      expect((user as unknown as { __entitlements?: string[] }).__entitlements).toEqual([
        'customer-ops',
        'ai-metered',
      ]);
      await svc.generateTokenForUser(user);
      expect(
        (svc as unknown as { jwtService: { sign: jest.Mock } }).jwtService.sign,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ entitlements: ['customer-ops', 'ai-metered'] }),
      );
    });

    it('mints an empty entitlements list when the bearer carries none (enforce denies clean)', async () => {
      const { svc } = makeService();
      const user = await svc.validateKeycloakUser('kc-aaron', aaron);
      expect((user as unknown as { __entitlements?: string[] }).__entitlements).toEqual([]);
      await svc.generateTokenForUser(user);
      expect(
        (svc as unknown as { jwtService: { sign: jest.Mock } }).jwtService.sign,
      ).toHaveBeenCalledWith(expect.objectContaining({ entitlements: [] }));
    });
  });

  describe('open mode', () => {
    beforeEach(() => {
      process.env.CUSTOMER_OPS_SIGNUP_MODE = 'open';
    });

    it('self-serve provisions a stranger their own workspace + OWNER membership', async () => {
      const { svc, prisma, provisioning } = makeService();
      const user = await svc.validateKeycloakUser(STRANGER_SUB, stranger);

      expect(provisioning.provisionSelfServeUser).toHaveBeenCalledTimes(1);
      expect((provisioning.provisionSelfServeUser as jest.Mock).mock.calls[0][0]).toMatchObject({
        keycloakId: STRANGER_SUB,
        email: 'nobody@example.com',
        username: 'nobody',
      });
      // The plain allow-list create path was NOT taken for the stranger.
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(user.keycloakId).toBe(STRANGER_SUB);
    });

    it('an allow-list user is UNCHANGED in open mode (allow-list still wins)', async () => {
      const { svc, prisma, provisioning } = makeService();
      const user = await svc.validateKeycloakUser('kc-aaron', aaron);
      expect(user.email).toBe('aaron@magicunicorn.tech');
      // Plain allow-list create — open mode does NOT self-serve an allow-listed user.
      expect(prisma.user.create).toHaveBeenCalledTimes(1);
      expect(provisioning.provisionSelfServeUser).not.toHaveBeenCalled();
    });

    it('is degrade-clean: a uc-registry-unreachable provision still yields the user', async () => {
      // Provisioner returns a local-fallback workspace (its own degrade path) —
      // validateKeycloakUser must still resolve the user without throwing.
      const provision = jest.fn(async (identity: any) => ({
        user: {
          id: 'local-x',
          email: identity.email,
          keycloakId: identity.keycloakId,
          isActive: true,
        } as User,
        workspaceId: '0190a000-7e57-7000-8000-0000000000ff',
        membership: {},
        workspaceIdSource: 'local-fallback' as const,
      }));
      const { svc } = makeService({ provision });
      const user = await svc.validateKeycloakUser(STRANGER_SUB, stranger);
      expect(provision).toHaveBeenCalledTimes(1);
      expect(user.keycloakId).toBe(STRANGER_SUB);
    });

    it('recovers from a concurrent-signup race by re-reading the winners user', async () => {
      const winner = {
        id: 'local-stranger',
        email: stranger.email,
        keycloakId: STRANGER_SUB,
        isActive: true,
      } as User;
      const provision = jest.fn(async () => {
        throw new ConflictException('User already provisioned (concurrent signup).');
      });
      const { svc, prisma } = makeService({ provision });
      // The loser re-reads by keycloakId and finds the row the winner created.
      (prisma.user.findUnique as jest.Mock).mockImplementation(async ({ where }: any) =>
        where.keycloakId === STRANGER_SUB ? winner : null,
      );

      const user = await svc.validateKeycloakUser(STRANGER_SUB, stranger);
      expect(user.id).toBe('local-stranger');
    });

    it('rejects a verified token with NO email even in open mode (nothing to key on)', async () => {
      const { svc, provisioning } = makeService();
      await expect(
        svc.validateKeycloakUser('kc-noemail', { sub: 'kc-noemail', preferred_username: 'x' }),
      ).rejects.toThrow(UnauthorizedException);
      expect(provisioning.provisionSelfServeUser).not.toHaveBeenCalled();
    });
  });
});

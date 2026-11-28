import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceProvisioningService } from '../common/workspace/workspace-provisioning.service';
import { MembershipService } from '../common/workspace/membership.service';
import { __resetAccessListCacheForTests } from './access-list';
import { clearUserinfoCacheForTests } from './userinfo';

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
        findMany: jest.fn(async () => []),
        create: jest.fn(async ({ data }: any) => userRow(data)),
        update: jest.fn(async ({ data }: any) => ({ ...data })),
        updateMany: jest.fn(async () => ({ count: 0 })),
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
      provisionEntitledOrgWorkspace: jest.fn(async () => ({
        workspaceId: '6e40af62-214d-4155-86f1-37dea8bcc53b',
        membership: {},
        workspaceIdSource: 'uc-registry',
      })),
    } as unknown as WorkspaceProvisioningService;

    const membership = {
      ensureSeededMembership: jest.fn(async () => undefined),
    } as unknown as MembershipService;
    const jwt = { sign: jest.fn(() => 'tok') } as unknown as JwtService;
    const svc = new AuthService(jwt, prisma, provisioning, membership, {
      permitsIdentity: jest.fn().mockResolvedValue(false),
    } as any);
    return { svc, prisma, provisioning, membership };
  }

  beforeEach(() => {
    __resetAccessListCacheForTests();
    clearUserinfoCacheForTests();
    delete process.env.CUSTOMER_OPS_ACCESS_LIST; // legacy fallback (Aaron+Shafen OWNER)
    delete process.env.CUSTOMER_OPS_SIGNUP_MODE;
    delete process.env.CUSTOMER_OPS_ENTITLEMENTS_ENABLED;
    delete process.env.UC_ENTITLEMENTS_URL;
    delete process.env.CUSTOMER_OPS_ENTITLEMENT_FEATURE_KEY;
    delete process.env.CUSTOMER_OPS_USERINFO_FETCH;
    delete process.env.KEYCLOAK_URL;
    delete process.env.KEYCLOAK_PUBLIC_URL;
    delete process.env.KEYCLOAK_REALM;
  });
  afterEach(() => {
    delete process.env.CUSTOMER_OPS_SIGNUP_MODE;
    delete process.env.CUSTOMER_OPS_ENTITLEMENTS_ENABLED;
    delete process.env.UC_ENTITLEMENTS_URL;
    delete process.env.CUSTOMER_OPS_ENTITLEMENT_FEATURE_KEY;
    delete process.env.CUSTOMER_OPS_USERINFO_FETCH;
    delete process.env.KEYCLOAK_URL;
    delete process.env.KEYCLOAK_PUBLIC_URL;
    delete process.env.KEYCLOAK_REALM;
    jest.restoreAllMocks();
  });

  // PO-CONN tests: the configured realm issuer + a no-email human bearer.
  const REALM_ISSUER = 'https://auth.example.test/realms/uchub';
  // A long token exp would cache the very first (unlinked) verdict for 900 s
  // and make later same-bearer assertions stale; keep test exps short (300 s).
  let bearerExp = Math.floor(Date.now() / 1000) + 300;
  const noEmailConfig = () => {
    process.env.CUSTOMER_OPS_USERINFO_FETCH = 'true';
    process.env.KEYCLOAK_URL = 'https://auth.example.test';
    process.env.KEYCLOAK_PUBLIC_URL = 'https://auth.example.test';
    process.env.KEYCLOAK_REALM = 'uchub';
    // The resolved connector email must be on the allow-list for the
    // "creates an entitled/allowed user" assertion to pass.
    process.env.CUSTOMER_OPS_ACCESS_LIST = 'connector@magicunicorn.tech:OWNER';
    bearerExp = Math.floor(Date.now() / 1000) + 300;
  };
  const noEmailPayload = (sub: string) => ({
    sub,
    iss: REALM_ISSUER,
    aud: 'customer-ops',
    exp: bearerExp,
  });

  describe('invite mode (default)', () => {
    it('returns structured 403 for a verified stranger with no workspace access', async () => {
      const { svc, provisioning } = makeService();
      await expect(svc.validateKeycloakUser(STRANGER_SUB, stranger)).rejects.toMatchObject({
        status: 403,
        response: {
          error: 'no_workspace_access',
          message: 'You are signed in but have no Customer-Ops access. Contact your administrator.',
        },
      });
      // The self-serve provisioner is NEVER touched in invite mode.
      expect(provisioning.provisionSelfServeUser).not.toHaveBeenCalled();
    });

    it('an unset CUSTOMER_OPS_SIGNUP_MODE behaves as invite (fail-safe)', async () => {
      delete process.env.CUSTOMER_OPS_SIGNUP_MODE;
      const { svc } = makeService();
      await expect(svc.validateKeycloakUser(STRANGER_SUB, stranger)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('a typo signup mode also fails safe to invite (rejects the stranger)', async () => {
      process.env.CUSTOMER_OPS_SIGNUP_MODE = 'opn';
      const { svc } = makeService();
      await expect(svc.validateKeycloakUser(STRANGER_SUB, stranger)).rejects.toBeInstanceOf(
        ForbiddenException,
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
      // No userinfo token is passed (the browser path has none): the resolver
      // never runs, so this is TODAY's exact behavior — a 401, not the 403
      // "signed in, no access" answer. The 403 only applies when the realm has
      // VERIFIED a no-email human bearer via the userinfo endpoint (flag on).
      await expect(
        svc.validateKeycloakUser('kc-noemail', { sub: 'kc-noemail', preferred_username: 'x' }),
      ).rejects.toMatchObject({ status: 401 });
      expect(provisioning.provisionSelfServeUser).not.toHaveBeenCalled();
    });
  });

  describe('entitled organization workspace path', () => {
    const ownerProfile = {
      sub: 'kc-lantern-owner',
      email: 'owner@lantern-harbor.example',
      email_verified: true,
      preferred_username: 'lantern-owner',
      given_name: 'Nora',
      family_name: 'Harbor',
    };

    beforeEach(() => {
      process.env.CUSTOMER_OPS_ENTITLEMENTS_ENABLED = 'true';
      process.env.UC_ENTITLEMENTS_URL = 'https://ops.example.test/api/v1/entitlements';
    });

    it('browser login provisions an entitled owner before legacy JIT branches', async () => {
      const { svc, provisioning } = makeService();
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          org_id: '6e40af62-214d-4155-86f1-37dea8bcc53b',
          tier: 'byok',
          role: 'owner',
          entitlements: ['customer_ops_access'],
          org_name: 'Lantern Harbor Advisory',
        }),
      } as Response);

      const user = await svc.validateKeycloakUser(
        ownerProfile.sub,
        ownerProfile,
        'fixture-browser-bearer',
      );

      expect(user.keycloakId).toBe(ownerProfile.sub);
      expect(provisioning.provisionEntitledOrgWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          user,
          orgId: '6e40af62-214d-4155-86f1-37dea8bcc53b',
          orgName: 'Lantern Harbor Advisory',
          role: 'owner',
        }),
      );
      expect(provisioning.provisionSelfServeUser).not.toHaveBeenCalled();
    });

    it('bearer login forwards a human realm token and caches the entitlement lookup', async () => {
      const { svc, provisioning } = makeService();
      const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          org_id: '6e40af62-214d-4155-86f1-37dea8bcc53b',
          tier: 'byok',
          role: 'member',
          entitlements: ['customer_ops_access'],
        }),
      } as Response);
      const payload = {
        sub: 'kc-lantern-member',
        iss: 'https://auth.example.test/realms/uchub',
        email: 'member@lantern-harbor.example',
        email_verified: true,
        preferred_username: 'lantern-member',
      };

      await svc.validateJwtPayload(payload, 'fixture-bearer-value');
      await svc.validateJwtPayload(payload, 'fixture-bearer-value');

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(provisioning.provisionEntitledOrgWorkspace).toHaveBeenCalledTimes(2);
      expect(provisioning.provisionEntitledOrgWorkspace).toHaveBeenLastCalledWith(
        expect.objectContaining({ role: 'member' }),
      );
    });

    it('does not resolve PAT or federation paths', async () => {
      const { svc } = makeService();
      const fetcher = jest.spyOn(global, 'fetch');
      const common = {
        email: 'member@lantern-harbor.example',
        email_verified: true,
        preferred_username: 'lantern-member',
      };

      await expect(
        svc.validateJwtPayload(
          {
            ...common,
            sub: 'kc-pat-shaped',
            iss: 'https://auth.example.test/realms/uchub',
          },
          'co_pat_fixture',
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        svc.validateJwtPayload(
          {
            ...common,
            sub: 'brigade-member',
            iss: 'https://brigade.unicorncommander.ai',
            aud: 'customer-ops',
          },
          'fixture-federation-bearer',
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('client errors fall through to the existing invite-only rejection', async () => {
      const { svc, provisioning } = makeService();
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('fixture outage'));

      await expect(
        svc.validateKeycloakUser(
          'kc-outage-stranger',
          { ...ownerProfile, sub: 'kc-outage-stranger', email: 'stranger@lantern-harbor.example' },
          'fixture-browser-bearer',
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(provisioning.provisionEntitledOrgWorkspace).not.toHaveBeenCalled();
      expect(provisioning.provisionSelfServeUser).not.toHaveBeenCalled();
    });
  });

  describe('PO-CONN: no-email realm human bearer resolves via userinfo', () => {
    const userinfoResponse = (over: Record<string, unknown> = {}) =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          sub: 'kc-noemail-entitled',
          email: 'connector@magicunicorn.tech',
          email_verified: true,
          preferred_username: 'connector',
          given_name: 'Conn',
          family_name: 'Ector',
          ...over,
        }),
      }) as Response;

    const guardRealFetch = () => {
      const real = global.fetch;
      (global as any).fetch = jest.fn(async () => {
        throw new Error('real fetch reached — every test must mock global fetch');
      });
      return () => {
        (global as any).fetch = real;
      };
    };

    it('creates an entitled/allowed user exactly as the email path would', async () => {
      const restore = guardRealFetch();
      noEmailConfig();
      const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(userinfoResponse());
      const { svc, prisma, provisioning } = makeService();

      const user = await svc.validateJwtPayload(noEmailPayload('kc-noemail-entitled'), 'bearer-1');

      restore();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(prisma.user.create).toHaveBeenCalledTimes(1);
      expect((prisma.user.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
        email: 'connector@magicunicorn.tech',
        keycloakId: 'kc-noemail-entitled',
        username: 'connector',
      });
      expect(provisioning.provisionSelfServeUser).not.toHaveBeenCalled();
      expect(user.keycloakId).toBe('kc-noemail-entitled');
      expect((user as any).__verifiedEmail).toBe('connector@magicunicorn.tech');
    });

    it('C1: two different users in flight never cross-bind (no per-request state on the singleton)', async () => {
      // The reviewer's repro: the bearer must be a per-request PARAMETER, never a
      // field on the singleton AuthService. If it were a field, request B
      // (the attacker) could read request A's (the victim's) bearer while A is
      // suspended and — via the digest-only cache — resolve as the victim's
      // profile, creating/linking the attacker's sub under the victim's email.
      const restore = guardRealFetch();
      noEmailConfig();
      const fetcher = jest
        .spyOn(global, 'fetch')
        // Echo back the sub of whichever bearer is in flight (decode the
        // Authorization header's sub by matching the known subs).
        .mockImplementation(async (_url: any, init: any) => {
          const bearer: string = init?.headers?.Authorization?.replace('Bearer ', '');
          const sub = bearer === 'bearer-victim' ? 'sub-victim' : 'sub-attacker';
          return userinfoResponse({ sub });
        });
      // A shared store: each findUnique returns the row for that sub, if any.
      const store = new Map<string, any>();
      const { svc, prisma } = makeService();
      (prisma.user.findUnique as jest.Mock).mockImplementation(async ({ where }: any) =>
        store.get(where.keycloakId) ?? null,
      );
      (prisma.user.create as jest.Mock).mockImplementation(async ({ data }: any) => {
        const row = { id: 'local-' + data.keycloakId, isActive: true, ...data };
        store.set(data.keycloakId, row);
        return row;
      });

      const victimSub = 'sub-victim';
      const attackerSub = 'sub-attacker';
      // Both requests in flight at once (single event loop, so they interleave
      // at awaits — exactly the window the C1 race needs).
      const [victim, attacker] = await Promise.all([
        svc.validateJwtPayload(noEmailPayload(victimSub), 'bearer-victim'),
        svc.validateJwtPayload(noEmailPayload(attackerSub), 'bearer-attacker'),
      ]);

      restore();
      // Each caller resolved THEIR OWN sub, with THEIR OWN bearer's profile.
      expect(victim.keycloakId).toBe(victimSub);
      expect(attacker.keycloakId).toBe(attackerSub);
      // No cross-binding: the attacker was never created or linked under the
      // victim's email, and the victim was never under the attacker's sub.
      const created = (prisma.user.create as jest.Mock).mock.calls.map((c: any) => c[0].data);
      expect(created.find((d: any) => d.keycloakId === attackerSub)?.email).toBe(
        'connector@magicunicorn.tech',
      );
      expect(created.find((d: any) => d.keycloakId === victimSub)?.email).toBe(
        'connector@magicunicorn.tech',
      );
      // Two distinct bearers -> two distinct fetches (no digest-only cache
      // collapse across callers).
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('not entitled -> 403 no_workspace_access, never 401', async () => {
      const restore = guardRealFetch();
      noEmailConfig();
      const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(
        userinfoResponse({ sub: 'kc-noemail-stranger', email: 'stranger@example.com' }),
      );
      const { svc } = makeService();

      await expect(
        svc.validateJwtPayload(noEmailPayload('kc-noemail-stranger'), 'bearer-stranger'),
      ).rejects.toMatchObject({
        status: 403,
        response: { error: 'no_workspace_access' },
      });
      restore();
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('userinfo sub mismatch -> refused, 401 (an unverifiable identity is not a "no access" answer), no user created', async () => {
      const restore = guardRealFetch();
      noEmailConfig();
      const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(
        userinfoResponse({ sub: 'attacker-sub', email: 'aaron@magicunicorn.tech' }),
      );
      const { svc, prisma } = makeService();

      // A subject mismatch means the realm could NOT verify this bearer's
      // identity — that is "unverifiable", so it keeps the 401 (a 403 would
      // tell a connector the identity is verified-but-forbidden, which it is
      // not). No user is created or linked either way.
      await expect(
        svc.validateJwtPayload(noEmailPayload('kc-noemail-stranger'), 'bearer-mismatch'),
      ).rejects.toMatchObject({ status: 401 });
      restore();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('act/client_id token -> no fetch, no link, 401 (machine tokens keep the 401 answer)', async () => {
      const restore = guardRealFetch();
      noEmailConfig();
      const fetcher = jest.spyOn(global, 'fetch');
      const unbound = {
        id: 'local-unbound',
        email: 'connector@magicunicorn.tech',
        keycloakId: null,
        isActive: true,
      } as User;
      const { svc, prisma } = makeService({ findUniqueResult: unbound });
      // The email-link path would bind this row; a machine token must not.
      (prisma.user.findUnique as jest.Mock).mockImplementation(async ({ where }: any) =>
        where.keycloakId ? null : unbound,
      );

      // A machine/delegated token with no email is NOT a verified human
      // identity: it gets today's 401 (the 403 "signed in, no access" answer
      // is reserved for a realm-VERIFIED human bearer the gate rejects).
      await expect(
        svc.validateJwtPayload(
          { ...noEmailPayload('kc-machine'), act: { sub: 'x' } },
          'bearer-machine',
        ),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        svc.validateJwtPayload(
          { ...noEmailPayload('kc-client'), client_id: 'svc' },
          'bearer-client',
        ),
      ).rejects.toMatchObject({ status: 401 });
      restore();
      expect(fetcher).not.toHaveBeenCalled();
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      expect((prisma.user.findUnique as jest.Mock).mock.calls.length).toBeGreaterThan(0);
    });

    it('already linked -> no fetch, resolves by keycloakId as today', async () => {
      const restore = guardRealFetch();
      noEmailConfig();
      const fetcher = jest.spyOn(global, 'fetch');
      const linked = {
        id: 'local-linked',
        email: 'connector@magicunicorn.tech',
        keycloakId: 'kc-noemail-entitled',
        isActive: true,
      } as User;
      const { svc } = makeService({ findUniqueResult: linked });

      const user = await svc.validateJwtPayload(noEmailPayload('kc-noemail-entitled'), 'bearer-2');
      restore();
      expect(fetcher).not.toHaveBeenCalled();
      expect(user.id).toBe('local-linked');
    });

    it('cache hit -> one fetch per bearer (the second request is served from the digest cache)', async () => {
      const restore = guardRealFetch();
      noEmailConfig();
      const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(userinfoResponse());
      const { svc } = makeService();

      // First request: the profile is fetched and cached under the bearer digest.
      await svc.validateJwtPayload(noEmailPayload('kc-noemail-entitled'), 'bearer-cache');
      // Second request with the SAME bearer: the cached profile short-circuits
      // the fetch (cache hit) and the already-linked sub resolves by keycloakId.
      await svc.validateJwtPayload(noEmailPayload('kc-noemail-entitled'), 'bearer-cache');
      restore();
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('userinfo 5xx -> transient, 401 (a blip is not a "no account" answer, and is not cached)', async () => {
      const restore = guardRealFetch();
      noEmailConfig();
      const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      } as Response);
      const { svc } = makeService();

      // A 5xx is TRANSIENT (outcome `unavailable`), not a verified "no access"
      // verdict. Today's 401 is kept so a connector keeps retrying sign-in
      // (and the negative is NOT cached, so a later healthy realm re-resolves).
      await expect(
        svc.validateJwtPayload(noEmailPayload('kc-noemail-stranger'), 'bearer-outage'),
      ).rejects.toMatchObject({ status: 401 });
      // The second call with the SAME bearer re-fetches (the transient result
      // was not cached) — proving a 3 s blip does not stick.
      await expect(
        svc.validateJwtPayload(noEmailPayload('kc-noemail-stranger'), 'bearer-outage'),
      ).rejects.toMatchObject({ status: 401 });
      restore();
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('flag off -> no fetch, today behavior (401, not 403)', async () => {
      const restore = guardRealFetch();
      // No CUSTOMER_OPS_USERINFO_FETCH in beforeEach; set the realm config only.
      process.env.KEYCLOAK_URL = 'https://auth.example.test';
      process.env.KEYCLOAK_PUBLIC_URL = 'https://auth.example.test';
      process.env.KEYCLOAK_REALM = 'uchub';
      const fetcher = jest.spyOn(global, 'fetch');
      const { svc } = makeService();

      // With the flag off the resolver is skipped entirely, so the no-email
      // bearer keeps TODAY's exact answer (401 invalid_token). The 403 change
      // applies only when the realm has verified the bearer via userinfo.
      await expect(
        svc.validateJwtPayload(noEmailPayload('kc-noemail-stranger'), 'bearer-off'),
      ).rejects.toMatchObject({ status: 401 });
      restore();
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('verified token with no local user after userinfo -> 403 shape (never 401 invalid_token)', async () => {
      const restore = guardRealFetch();
      noEmailConfig();
      const fetcher = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          userinfoResponse({ sub: 'kc-noemail-stranger', email: 'stranger@example.com' }),
        );
      const { svc } = makeService();

      let error: any;
      try {
        await svc.validateJwtPayload(noEmailPayload('kc-noemail-stranger'), 'bearer-403');
      } catch (e) {
        error = e;
      }
      restore();
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.status).toBe(403);
      expect(error.status).not.toBe(401);
      expect(error.getResponse()).toMatchObject({ error: 'no_workspace_access' });
      expect(error.getResponse().message).toMatch(/no Customer-Ops access/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('verified human but userinfo carries NO email -> 403 (verified-no-access, not 401)', async () => {
      // H2/H3: the 403 is reserved for a bearer the realm has VERIFIED as a
      // human identity (sub matched, profile fetched) that the existing gate
      // still rejects. A verified profile with no email is exactly that: a
      // 403 "signed in, no access" — not the 401 that would loop a connector
      // into sign-in, and not a transient 5xx answer either.
      const restore = guardRealFetch();
      noEmailConfig();
      const fetcher = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          userinfoResponse({ sub: 'kc-noemail-noemail', email: undefined }),
        );
      const { svc, prisma } = makeService();

      await expect(
        svc.validateJwtPayload(noEmailPayload('kc-noemail-noemail'), 'bearer-noemail'),
      ).rejects.toMatchObject({ status: 403, response: { error: 'no_workspace_access' } });
      restore();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });
});

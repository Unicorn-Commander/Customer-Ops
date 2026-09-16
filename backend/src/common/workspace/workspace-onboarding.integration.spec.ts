/** Real routes/guards/Prisma on an explicitly supplied isolated PostgreSQL. */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { User, WorkspaceRole } from '@prisma/client';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthModule } from '../../auth/auth.module';
import { AuthService } from '../../auth/auth.service';
import { PatService } from '../../auth/pat/pat.service';
import { OnboardingSessionGuard } from './workspace-onboarding.controller';
import { WorkspaceAdminModule } from './workspace-admin.module';
import { WorkspaceInvitationsService } from './workspace-invitations.service';
import { UcRegistryClient } from '../uc-registry/uc-registry.client';
import { __resetAccessListCacheForTests } from '../../auth/access-list';

const testUrl = process.env.CUSTOMER_ONBOARDING_TEST_DB_URL;
const suite = testUrl ? describe : describe.skip;
suite('scoped onboarding real PostgreSQL and HTTP guards', () => {
  let app: INestApplication,
    db: PrismaService,
    auth: AuthService,
    invites: WorkspaceInvitationsService;
  let base: string,
    owner: User,
    member: User,
    workspace: string,
    other: string,
    ownerToken: string,
    memberToken: string;
  const env = { ...process.env };
  async function request(path: string, method: string, token: string, body?: unknown) {
    return fetch(base + '/workspace-onboarding/' + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function signed(user: User, verified = true) {
    return app.get(JwtService).sign({
      sub: user.id,
      email: user.email,
      email_verified: verified,
      username: user.username,
      entitlements: [],
    });
  }
  async function invitation(email: string, role: WorkspaceRole = WorkspaceRole.MEMBER) {
    const res = await request(`workspaces/${workspace}/invitations`, 'POST', ownerToken, {
      email,
      role,
    });
    expect(res.status).toBe(201);
    return res.json() as Promise<any>;
  }
  async function identity(email: string) {
    const sub = randomUUID();
    const user = await auth.validateKeycloakUser(sub, {
      email,
      email_verified: true,
      preferred_username: email,
    });
    return { user, token: (await auth.generateTokenForUser(user)).access_token };
  }

  beforeAll(async () => {
    const parsed = new URL(testUrl!);
    if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/customer_onboarding_test')
      throw new Error('Dedicated isolated test database required');
    process.env.DATABASE_URL = testUrl;
    process.env.CUSTOMER_OPS_TENANCY_ENABLED = 'true';
    process.env.CUSTOMER_OPS_SIGNUP_MODE = 'invite';
    process.env.JWT_SECRET = 'isolated-onboarding-tests-only-not-a-runtime-secret';
    __resetAccessListCacheForTests();
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        AuthModule,
        WorkspaceAdminModule,
      ],
    })
      .overrideProvider(UcRegistryClient)
      .useValue({
        mintWorkspaceId: async (input: any) => ({
          workspaceId: input.workspaceId,
          source: 'local-fallback',
        }),
      })
      .compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    db = app.get(PrismaService);
    auth = app.get(AuthService);
    invites = app.get(WorkspaceInvitationsService);
  });
  afterAll(async () => {
    if (app) await app.close();
    process.env = env;
  });
  beforeEach(async () => {
    workspace = randomUUID();
    other = randomUUID();
    owner = await db.user.create({
      data: {
        email: `${randomUUID()}@synthetic.example`,
        username: randomUUID(),
        keycloakId: randomUUID(),
      },
    });
    member = await db.user.create({
      data: {
        email: `${randomUUID()}@synthetic.example`,
        username: randomUUID(),
        keycloakId: randomUUID(),
      },
    });
    for (const id of [workspace, other])
      await db.workspace.create({ data: { id, slug: id, displayName: 'Synthetic only' } });
    await db.membership.createMany({
      data: [
        { userKey: owner.keycloakId!, workspaceId: workspace, role: 'OWNER' },
        { userKey: member.keycloakId!, workspaceId: workspace, role: 'MEMBER' },
      ],
    });
    ownerToken = await signed(owner);
    memberToken = await signed(member);
  });

  it('requires an active owner for independent workspace provisioning and copies no entitlements', async () => {
    expect(
      (
        await request('workspaces', 'POST', memberToken, {
          source_workspace_id: workspace,
          request_id: randomUUID(),
          display_name: 'Denied',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('workspaces', 'POST', ownerToken, {
          source_workspace_id: other,
          request_id: randomUUID(),
          display_name: 'Denied',
        })
      ).status,
    ).toBe(403);
    const res = await request('workspaces', 'POST', ownerToken, {
      source_workspace_id: workspace,
      request_id: randomUUID(),
      display_name: 'Independent synthetic',
    });
    expect(res.status).toBe(201);
    const result: any = await res.json();
    const created = await db.workspace.findUniqueOrThrow({ where: { id: result.workspace_id } });
    expect(created.parentWorkspaceId).toBeNull();
    expect(created.entitlementCache).toBeNull();
    expect(await db.workspaceEntitlement.count({ where: { workspaceId: created.id } })).toBe(0);
    expect(
      await db.membership.count({
        where: { workspaceId: created.id, userKey: owner.keycloakId!, role: 'OWNER' },
      }),
    ).toBe(1);
    expect(await db.customer.count({ where: { workspaceId: created.id } })).toBe(0);
  });

  it('keeps strangers denied; pending invitation permits verified identity but no membership until token acceptance', async () => {
    const email = `${randomUUID()}@synthetic.example`,
      sub = randomUUID();
    await expect(auth.validateKeycloakUser(sub, { email, email_verified: true })).rejects.toThrow();
    const made = await invitation(email);
    for (const profile of [
      { email },
      { email, email_verified: false },
      { email, email_verified: 'true' },
      { email, email_verified: true, act: {} },
      { email, email_verified: true, client_id: 'service' },
      { email, email_verified: true, __federationActor: true },
    ]) {
      await expect(auth.validateKeycloakUser(sub, profile)).rejects.toThrow();
    }
    expect(await db.user.count({ where: { keycloakId: sub } })).toBe(0);
    const invited = await identity(email);
    expect(await db.membership.count({ where: { userKey: invited.user.keycloakId! } })).toBe(0);
    expect(
      await db.workspaceInvitation.count({ where: { id: made.invitation.id, status: 'PENDING' } }),
    ).toBe(1);
    const accepted = await request('invitations/accept', 'POST', invited.token, {
      token: made.invitation_token,
    });
    expect(accepted.status).toBe(201);
    expect(
      await db.membership.count({
        where: { userKey: invited.user.keycloakId!, workspaceId: workspace, role: 'MEMBER' },
      }),
    ).toBe(1);
    expect(
      (await request('invitations/accept', 'POST', invited.token, { token: made.invitation_token }))
        .status,
    ).toBe(400);
  });

  it('refuses foreign owner/member writes and never lists token hashes or plaintext', async () => {
    const made = await invitation(`${randomUUID()}@synthetic.example`);
    expect((await request(`workspaces/${other}/invitations`, 'GET', ownerToken)).status).toBe(403);
    expect(
      (
        await request(`workspaces/${workspace}/invitations`, 'POST', memberToken, {
          email: 'member@synthetic.example',
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(`workspaces/${other}/invitations/${made.invitation.id}`, 'DELETE', ownerToken))
        .status,
    ).toBe(403);
    const res = await request(`workspaces/${workspace}/invitations`, 'GET', ownerToken);
    expect(res.status).toBe(200);
    const rows: any = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBeUndefined();
    expect(rows[0].invitation_token).toBeUndefined();
    const audit = await db.auditLog.findMany({ where: { workspaceId: workspace } });
    expect(JSON.stringify(audit).includes(made.invitation_token)).toBe(false);
  });

  it('rejects wrong/unverified email, expired/revoked invitation and suspended workspace without consumption', async () => {
    const made = await invitation(member.email);
    expect(
      (await request('invitations/accept', 'POST', ownerToken, { token: made.invitation_token }))
        .status,
    ).toBe(400);
    expect(
      (
        await request('invitations/accept', 'POST', await signed(member, false), {
          token: made.invitation_token,
        })
      ).status,
    ).toBe(403);
    await db.workspace.update({ where: { id: workspace }, data: { status: 'suspended' } });
    expect(
      (await request('invitations/accept', 'POST', memberToken, { token: made.invitation_token }))
        .status,
    ).toBe(403);
    await db.workspace.update({ where: { id: workspace }, data: { status: 'active' } });
    await db.workspaceInvitation.update({
      where: { id: made.invitation.id },
      data: {
        createdAt: new Date(Date.now() - 7200000),
        expiresAt: new Date(Date.now() - 3600000),
      },
    });
    expect(
      (await request('invitations/accept', 'POST', memberToken, { token: made.invitation_token }))
        .status,
    ).toBe(400);
    expect(
      (await db.workspaceInvitation.findUniqueOrThrow({ where: { id: made.invitation.id } }))
        .status,
    ).toBe('PENDING');
    const revoked = await invitation(member.email);
    expect(
      (
        await request(
          `workspaces/${workspace}/invitations/${revoked.invitation.id}`,
          'DELETE',
          ownerToken,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request('invitations/accept', 'POST', memberToken, {
          token: revoked.invitation_token,
        })
      ).status,
    ).toBe(400);
  });

  it('concurrent acceptance consumes once and preserves an existing active role', async () => {
    const made = await invitation(member.email, WorkspaceRole.OWNER);
    const responses = await Promise.all(
      [1, 2].map(() =>
        request('invitations/accept', 'POST', memberToken, { token: made.invitation_token }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(
      (
        await db.membership.findUniqueOrThrow({
          where: { userKey_workspaceId: { userKey: member.keycloakId!, workspaceId: workspace } },
        })
      ).role,
    ).toBe('MEMBER');
  });

  it.each(['SUSPENDED', 'REVOKED'] as const)(
    'does not reactivate %s membership',
    async (status) => {
      const made = await invitation(member.email);
      await db.membership.update({
        where: { userKey_workspaceId: { userKey: member.keycloakId!, workspaceId: workspace } },
        data: { status },
      });
      expect(
        (await request('invitations/accept', 'POST', memberToken, { token: made.invitation_token }))
          .status,
      ).toBe(403);
      expect(
        (await db.workspaceInvitation.findUniqueOrThrow({ where: { id: made.invitation.id } }))
          .status,
      ).toBe('PENDING');
    },
  );

  it('rejects PAT bearers on all five onboarding routes and forbids injected provisioning fields', async () => {
    const pat = await app.get(PatService).create(owner, {
      name: 'Isolated narrow route probe',
      workspaceId: workspace,
      scopes: ['read:overview'],
    });
    const allowed = await fetch(base + `/workspaces/${workspace}`, {
      headers: { Authorization: `Bearer ${pat.plaintext}` },
    });
    expect(allowed.status).toBe(200);
    for (const [path, method, body] of [
      [
        'workspaces',
        'POST',
        { source_workspace_id: workspace, request_id: randomUUID(), display_name: 'Denied' },
      ],
      [`workspaces/${workspace}/invitations`, 'POST', { email: 'x@synthetic.example' }],
      [`workspaces/${workspace}/invitations`, 'GET', undefined],
      [`workspaces/${workspace}/invitations/${randomUUID()}`, 'DELETE', undefined],
      ['invitations/accept', 'POST', { token: 'a'.repeat(43) }],
    ] as const)
      expect((await request(path, method, pat.plaintext, body)).status).toBe(403);
    expect(
      (
        await request('workspaces', 'POST', ownerToken, {
          source_workspace_id: workspace,
          request_id: randomUUID(),
          display_name: 'Denied',
          entitlements: ['customer-ops'],
        })
      ).status,
    ).toBe(400);
  });

  it('existing identity cannot be rebound to a different verified subject', async () => {
    await invitation(member.email);
    await expect(
      auth.validateKeycloakUser(randomUUID(), { email: member.email, email_verified: true }),
    ).rejects.toThrow();
    expect((await db.user.findUniqueOrThrow({ where: { id: member.id } })).keycloakId).toBe(
      member.keycloakId,
    );
  });
  it.each(['expired', 'revoked', 'suspended'] as const)(
    'does not admit identity for an %s invitation/workspace',
    async (kind) => {
      const email = `${randomUUID()}@synthetic.example`;
      const made = await invitation(email);
      if (kind === 'expired')
        await db.workspaceInvitation.update({
          where: { id: made.invitation.id },
          data: {
            createdAt: new Date(Date.now() - 7200000),
            expiresAt: new Date(Date.now() - 3600000),
          },
        });
      if (kind === 'revoked')
        await db.workspaceInvitation.update({
          where: { id: made.invitation.id },
          data: { status: 'REVOKED' },
        });
      if (kind === 'suspended')
        await db.workspace.update({ where: { id: workspace }, data: { status: 'suspended' } });
      await expect(identity(email)).rejects.toThrow();
      expect(await db.user.count({ where: { email } })).toBe(0);
    },
  );

  it('refuses case-variant rebinding and unverified legacy account linking', async () => {
    await invitation(member.email);
    await expect(
      auth.validateKeycloakUser(randomUUID(), {
        email: member.email.toUpperCase(),
        email_verified: true,
      }),
    ).rejects.toThrow();
    const legacy = await db.user.create({
      data: { email: `${randomUUID()}@synthetic.example`, username: randomUUID() },
    });
    await expect(
      auth.validateKeycloakUser(randomUUID(), { email: legacy.email, email_verified: false }),
    ).rejects.toThrow();
    expect((await db.user.findUniqueOrThrow({ where: { id: legacy.id } })).keycloakId).toBeNull();
  });

  it('post-auth guard rejects pre-resolved PAT and federation/service principals', () => {
    const guard = new OnboardingSessionGuard();
    for (const req of [
      { user: { __humanSession: true }, pat: {} },
      { user: { __humanSession: false } },
      { user: {}, headers: {} },
    ]) {
      expect(() =>
        guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as any),
      ).toThrow();
    }
  });
  it('concurrent creation and response-loss replay reuse one server-reserved workspace ID', async () => {
    const request_id = randomUUID();
    const body = {
      source_workspace_id: workspace,
      display_name: 'Stable retry fixture',
      request_id,
    };
    const responses = await Promise.all(
      [1, 2].map(() => request('workspaces', 'POST', ownerToken, body)),
    );
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    const results: any[] = await Promise.all(responses.map((r) => r.json()));
    expect(results[0].workspace_id).toBe(results[1].workspace_id);
    expect(results.filter((r) => r.replayed)).toHaveLength(1);
    const replay = await request('workspaces', 'POST', ownerToken, body);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as any).workspace_id).toBe(results[0].workspace_id);
    expect(await db.workspace.count({ where: { id: results[0].workspace_id } })).toBe(1);
    expect(await db.membership.count({ where: { workspaceId: results[0].workspace_id } })).toBe(1);
    expect(
      (await request('workspaces', 'POST', ownerToken, { ...body, display_name: 'Different' }))
        .status,
    ).toBe(409);
  });
  it('two distinct invitations accepted concurrently create one membership without role overwrite', async () => {
    const email = `${randomUUID()}@synthetic.example`;
    const first = await invitation(email, WorkspaceRole.VIEWER);
    const second = await invitation(email, WorkspaceRole.OWNER);
    const person = await identity(email);
    const responses = await Promise.all(
      [first, second].map((i) =>
        request('invitations/accept', 'POST', person.token, { token: i.invitation_token }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    const results: any[] = await Promise.all(responses.map((r) => r.json()));
    expect(results[0].role).toBe(results[1].role);
    expect(
      await db.membership.count({
        where: { userKey: person.user.keycloakId!, workspaceId: workspace },
      }),
    ).toBe(1);
  });

  it('concurrent verified subjects cannot both link one unbound legacy identity', async () => {
    const legacy = await db.user.create({
      data: { email: `${randomUUID()}@synthetic.example`, username: randomUUID() },
    });
    const subjects = [randomUUID(), randomUUID()];
    const attempts = await Promise.allSettled(
      subjects.map((sub) =>
        auth.validateKeycloakUser(sub, { email: legacy.email, email_verified: true }),
      ),
    );
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const bound = await db.user.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(subjects).toContain(bound.keycloakId);
  });
});

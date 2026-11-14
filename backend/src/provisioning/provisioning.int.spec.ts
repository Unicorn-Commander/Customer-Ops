/**
 * Contract D end to end: real Nest routes, guards and Prisma on the CI Postgres.
 *
 * Runs when a database is supplied: PROVISIONING_TEST_DATABASE_URL, else the CI
 * owner URL CUSTOMER_OPS_RLS_OWNER_DATABASE_URL (set by .forgejo/workflows/ci.yml
 * after `prisma migrate deploy`). Every row uses random ids and is cleaned up.
 * Fictional people at example.com only; no network beyond the loopback listener.
 */
import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { MembershipStatus, User, WorkspaceRole } from '@prisma/client';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService, WorkspaceReadOnlyException } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceAdminModule } from '../common/workspace/workspace-admin.module';
import { WorkspaceProvisioningService } from '../common/workspace/workspace-provisioning.service';
import { UcRegistryClient } from '../common/uc-registry/uc-registry.client';
import { generatePat } from '../auth/pat/pat.util';
import { __resetAccessListCacheForTests } from '../auth/access-list';
import { ProvisioningModule } from './provisioning.module';
import { PROVISIONING_JTI_STORE } from './provisioning-token.service';
import { ProvisioningJtiStore } from './provisioning-jti.store';

const dbUrl =
  process.env.PROVISIONING_TEST_DATABASE_URL ?? process.env.CUSTOMER_OPS_RLS_OWNER_DATABASE_URL;
const suite = dbUrl ? describe : describe.skip;

const SECRET = 'integration-only-provisioning-secret-0123456789'; // fictional, > 32 bytes
const BASE = '/api/v1/provisioning/workspaces';
const READ_SCOPE = ['read:overview'];

function controlPlaneToken(overrides: Record<string, unknown> = {}): string {
  const iat = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: 'ops-center', aud: 'customer-ops', iat, exp: iat + 60, jti: randomUUID(), ...overrides },
    SECRET,
    { algorithm: 'HS256' },
  );
}

async function buildApp(imports: any[]): Promise<{ app: INestApplication; base: string }> {
  const module = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), ...imports],
  })
    .overrideProvider(UcRegistryClient)
    .useValue({
      mintWorkspaceId: jest.fn(async (input: any) => ({
        workspaceId: input.workspaceId,
        source: 'local-fallback',
      })),
    })
    .compile();
  const app = module.createNestApplication();
  app.useLogger(false);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(0, '127.0.0.1');
  return { app, base: await app.getUrl() };
}

suite('contract D provisioning on a real PostgreSQL', () => {
  const env = { ...process.env };
  let app: INestApplication;
  let base: string;
  let db: PrismaService;
  const workspaces: string[] = [];
  const users: string[] = [];

  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${controlPlaneToken()}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  function createBody(orgId: string, extra: Record<string, unknown> = {}) {
    return {
      org_id: orgId,
      slug: `acme-${orgId.slice(0, 8)}`,
      display_name: 'Acme Example Co',
      plan_tier: 'team',
      entitlements: ['customer-ops'],
      owner: { subject: randomUUID(), email: 'ada.owner@example.com' },
      timezone: 'America/New_York',
      ...extra,
    };
  }

  async function provision(orgId: string, body = createBody(orgId)) {
    workspaces.push(orgId);
    return call('POST', BASE, body, { 'Idempotency-Key': `${orgId}:customer-ops` });
  }

  async function person(label: string): Promise<User> {
    const user = await db.user.create({
      data: {
        email: `${label}.${randomUUID().slice(0, 8)}@example.com`,
        username: `${label}-${randomUUID()}`,
        keycloakId: randomUUID(),
      },
    });
    users.push(user.id);
    return user;
  }

  async function pat(user: User, workspaceId: string | null) {
    const generated = generatePat();
    const row = await db.personalAccessToken.create({
      data: {
        userId: user.id,
        workspaceId,
        name: 'fixture',
        tokenHash: await generated.hash,
        scopes: READ_SCOPE,
      },
    });
    return { plaintext: generated.plaintext, id: row.id };
  }

  async function asUser(token: string, path: string) {
    const res = await fetch(base + '/api/v1' + path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.status;
  }

  async function join(user: User, workspaceId: string, role: WorkspaceRole = WorkspaceRole.MEMBER) {
    await db.membership.create({
      data: { userKey: user.keycloakId!, workspaceId, role, status: MembershipStatus.ACTIVE },
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = dbUrl;
    process.env.PROVISIONING_ENABLED = 'true';
    process.env.PROVISIONING_JWT_SECRET = SECRET;
    delete process.env.PROVISIONING_JWT_AUDIENCE;
    process.env.CUSTOMER_OPS_TENANCY_ENABLED = 'true';
    process.env.CUSTOMER_OPS_SIGNUP_MODE = 'invite';
    process.env.JWT_SECRET = 'integration-only-session-secret-not-a-runtime-value';
    __resetAccessListCacheForTests();
    ({ app, base } = await buildApp([
      PrismaModule,
      AuthModule,
      WorkspaceAdminModule,
      ProvisioningModule.register(true),
    ]));
    db = app.get(PrismaService);
  });

  afterAll(async () => {
    if (db) {
      await db.personalAccessToken.deleteMany({ where: { userId: { in: users } } });
      await db.m365Connection.deleteMany({ where: { userId: { in: users } } });
      await db.auditLog.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await db.membership.deleteMany({ where: { workspaceId: { in: workspaces } } });
      await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    }
    if (app) await app.close();
    process.env = env;
  });

  describe('POST /provisioning/workspaces', () => {
    it('creates the org workspace from the full body, keyed on org_id, storing no owner email', async () => {
      const orgId = randomUUID();
      const body = createBody(orgId);
      const res = await provision(orgId, body);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ workspace_id: orgId, status: 'active' });
      expect(res.body.workspace_id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/);

      const ws = await db.workspace.findUniqueOrThrow({ where: { id: orgId } });
      expect(ws).toMatchObject({
        slug: body.slug,
        displayName: 'Acme Example Co',
        status: 'active',
      });
      expect(JSON.stringify(ws)).not.toContain('ada.owner@example.com');
      // People stay just in time at sign-in: no user, no membership yet.
      expect(await db.membership.count({ where: { workspaceId: orgId } })).toBe(0);
      expect(await db.user.count({ where: { email: 'ada.owner@example.com' } })).toBe(0);
    });

    it('returns the same workspace for the same org twice, whatever else changed', async () => {
      const orgId = randomUUID();
      expect((await provision(orgId)).status).toBe(201);
      const again = await provision(
        orgId,
        createBody(orgId, {
          slug: 'renamed-slug',
          display_name: 'Renamed Example Co',
          plan_tier: 'enterprise',
          entitlements: [],
          owner: { subject: randomUUID(), email: 'grace.next@example.com' },
          timezone: 'Europe/Paris',
          a_field_added_later: true,
        }),
      );
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ workspace_id: orgId, status: 'active' });
      expect(await db.workspace.count({ where: { id: orgId } })).toBe(1);
      expect((await db.workspace.findUniqueOrThrow({ where: { id: orgId } })).displayName).toBe(
        'Acme Example Co',
      );
    });

    it('adopts the workspace a member sign-in already created for the org (no second one)', async () => {
      const orgId = randomUUID();
      workspaces.push(orgId);
      const member = await person('lin.signin');
      await app.get(WorkspaceProvisioningService).provisionEntitledOrgWorkspace({
        user: member,
        orgId,
        orgName: 'Signed In Example Co',
        role: 'member',
      });
      const res = await provision(orgId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ workspace_id: orgId, status: 'active' });
      expect(await db.workspace.count({ where: { id: orgId } })).toBe(1);
      expect(await db.membership.count({ where: { workspaceId: orgId } })).toBe(1);
    });

    it('falls back to another slug when the requested one is taken', async () => {
      const first = randomUUID();
      const second = randomUUID();
      await provision(first, createBody(first, { slug: `shared-${first}` }));
      const res = await provision(second, createBody(second, { slug: `shared-${first}` }));
      expect(res.status).toBe(201);
      expect((await db.workspace.findUniqueOrThrow({ where: { id: second } })).slug).toBe(
        `org-${second.slice(0, 8)}`,
      );
    });

    it('refuses a bad org_id or a mismatched Idempotency-Key with 400', async () => {
      const orgId = randomUUID();
      expect((await provision('-bad', createBody('-bad'))).status).toBe(400);
      const wrongKey = await call('POST', BASE, createBody(orgId), {
        'Idempotency-Key': `${orgId}:project-ops`,
      });
      expect(wrongKey.status).toBe(400);
      expect((await call('POST', BASE, createBody(orgId))).status).toBe(400);
      expect(await db.workspace.count({ where: { id: orgId } })).toBe(0);
    });
  });

  describe('GET and PATCH /provisioning/workspaces/{id}', () => {
    it('reads the workspace and 404s an unknown one', async () => {
      const orgId = randomUUID();
      await provision(orgId);
      expect(await call('GET', `${BASE}/${orgId}`)).toEqual({
        status: 200,
        body: { workspace_id: orgId, status: 'active' },
      });
      expect((await call('GET', `${BASE}/${randomUUID()}`)).status).toBe(404);
      expect((await call('PATCH', `${BASE}/${randomUUID()}`, { state: 'active' })).status).toBe(
        404,
      );
    });

    it('moves through every state and back, deleting nothing', async () => {
      const orgId = randomUUID();
      await provision(orgId);
      const member = await person('kit.state');
      await join(member, orgId);
      for (const state of ['suspended', 'archived', 'active', 'archived', 'suspended', 'active']) {
        const patched = await call('PATCH', `${BASE}/${orgId}`, { state });
        expect(patched).toEqual({ status: 200, body: { workspace_id: orgId, status: state } });
        expect((await call('GET', `${BASE}/${orgId}`)).body.status).toBe(state);
      }
      expect(await db.membership.count({ where: { workspaceId: orgId } })).toBe(1);
      expect((await call('PATCH', `${BASE}/${orgId}`, { state: 'deleted' })).status).toBe(400);
    });

    it('a suspended or archived workspace serves reads and refuses writes', async () => {
      const orgId = randomUUID();
      await provision(orgId);
      const owner = await person('ivy.owner');
      await join(owner, orgId, WorkspaceRole.OWNER);
      const session = app.get(JwtService).sign({
        sub: owner.id,
        email: owner.email,
        username: owner.username,
        entitlements: [],
      });
      const write = () =>
        db.withWorkspace(orgId, owner.keycloakId, (tx) =>
          tx.auditLog.create({
            data: { workspaceId: orgId, action: 'UPDATE', resource: 'fixture' },
          }),
        );
      const read = () =>
        db.withWorkspace(orgId, owner.keycloakId, (tx) =>
          tx.auditLog.count({ where: { resource: 'fixture' } }),
        );

      await expect(write()).resolves.toBeTruthy();
      for (const state of ['suspended', 'archived']) {
        await call('PATCH', `${BASE}/${orgId}`, { state });
        await expect(write()).rejects.toBeInstanceOf(WorkspaceReadOnlyException);
        await expect(write()).rejects.toMatchObject({ status: 423 });
        await expect(read()).resolves.toBe(1);
        expect(await asUser(session, `/workspaces/${orgId}`)).toBe(200); // HTTP read still served
      }
      await call('PATCH', `${BASE}/${orgId}`, { state: 'active' });
      await expect(write()).resolves.toBeTruthy();
      await expect(read()).resolves.toBe(2);
    });
  });

  describe('DELETE /provisioning/workspaces/{id}/members/{subject}', () => {
    it('revokes the workspace token: a request that worked before is refused after', async () => {
      const orgId = randomUUID();
      const otherOrg = randomUUID();
      await provision(orgId);
      await provision(otherOrg);
      const member = await person('noor.member');
      await join(member, orgId);
      await join(member, otherOrg);
      const here = await pat(member, orgId);
      const there = await pat(member, otherOrg);
      const unbound = await pat(member, null);
      await db.m365Connection.create({
        data: {
          userId: member.id,
          workspaceId: orgId,
          m365UserId: 'graph-user-fixture',
          scopes: [],
          refreshTokenEnc: 'fixture-ciphertext',
        },
      });

      expect(await asUser(here.plaintext, `/workspaces/${orgId}`)).toBe(200);
      expect(await asUser(there.plaintext, `/workspaces/${otherOrg}`)).toBe(200);

      const removed = await call('DELETE', `${BASE}/${orgId}/members/${member.keycloakId}`);
      expect(removed.status).toBe(204);

      expect(await asUser(here.plaintext, `/workspaces/${orgId}`)).toBe(401);
      // A token bound to another workspace is untouched and still works there.
      expect(await asUser(there.plaintext, `/workspaces/${otherOrg}`)).toBe(200);
      // An unbound token is kept while another membership exists.
      expect(
        (await db.personalAccessToken.findUniqueOrThrow({ where: { id: unbound.id } })).revokedAt,
      ).toBeNull();
      expect(
        await db.m365Connection.count({ where: { userId: member.id, workspaceId: orgId } }),
      ).toBe(0);
      const membership = await db.membership.findUniqueOrThrow({
        where: { userKey_workspaceId: { userKey: member.keycloakId!, workspaceId: orgId } },
      });
      expect(membership.status).toBe(MembershipStatus.REVOKED);

      // ...and revoked with the last membership.
      expect(
        (await call('DELETE', `${BASE}/${otherOrg}/members/${member.keycloakId}`)).status,
      ).toBe(204);
      expect(
        (await db.personalAccessToken.findUniqueOrThrow({ where: { id: unbound.id } })).revokedAt,
      ).not.toBeNull();
      expect(await asUser(there.plaintext, `/workspaces/${otherOrg}`)).toBe(401);

      // Re-adding the person never brings a revoked token back.
      await db.membership.update({
        where: { userKey_workspaceId: { userKey: member.keycloakId!, workspaceId: orgId } },
        data: { status: MembershipStatus.ACTIVE },
      });
      expect(await asUser(here.plaintext, `/workspaces/${orgId}`)).toBe(401);
    });

    it('is a no-op for an unknown subject and the second time; 404 for an unknown workspace', async () => {
      const orgId = randomUUID();
      await provision(orgId);
      const member = await person('omar.repeat');
      await join(member, orgId);
      const token = await pat(member, orgId);

      expect((await call('DELETE', `${BASE}/${orgId}/members/${randomUUID()}`)).status).toBe(204);
      expect(await asUser(token.plaintext, `/workspaces/${orgId}`)).toBe(200);

      expect((await call('DELETE', `${BASE}/${orgId}/members/${member.keycloakId}`)).status).toBe(
        204,
      );
      const after = await db.personalAccessToken.findUniqueOrThrow({ where: { id: token.id } });
      const membership = await db.membership.findUniqueOrThrow({
        where: { userKey_workspaceId: { userKey: member.keycloakId!, workspaceId: orgId } },
      });
      expect((await call('DELETE', `${BASE}/${orgId}/members/${member.keycloakId}`)).status).toBe(
        204,
      );
      expect(await db.personalAccessToken.findUniqueOrThrow({ where: { id: token.id } })).toEqual(
        after,
      );
      expect(
        await db.membership.findUniqueOrThrow({
          where: { userKey_workspaceId: { userKey: member.keycloakId!, workspaceId: orgId } },
        }),
      ).toEqual(membership);

      expect(
        (await call('DELETE', `${BASE}/${randomUUID()}/members/${member.keycloakId}`)).status,
      ).toBe(404);
    });

    it('revokes an unbound token on the first removal when membership is not enforced', async () => {
      const orgId = randomUUID();
      const otherOrg = randomUUID();
      await provision(orgId);
      await provision(otherOrg);
      const member = await person('uma.unenforced');
      await join(member, orgId);
      await join(member, otherOrg);
      const unbound = await pat(member, null);
      process.env.CUSTOMER_OPS_TENANCY_ENABLED = 'false';
      try {
        expect((await call('DELETE', `${BASE}/${orgId}/members/${member.keycloakId}`)).status).toBe(
          204,
        );
      } finally {
        process.env.CUSTOMER_OPS_TENANCY_ENABLED = 'true';
      }
      expect(
        (await db.personalAccessToken.findUniqueOrThrow({ where: { id: unbound.id } })).revokedAt,
      ).not.toBeNull();
    });

    it("the app's own member removal follows the same rule and says first what it will revoke", async () => {
      const orgId = randomUUID();
      await provision(orgId);
      const owner = await person('rosa.owner');
      const member = await person('sam.member');
      await join(owner, orgId, WorkspaceRole.OWNER);
      await join(member, orgId);
      const token = await pat(member, orgId);
      const session = app.get(JwtService).sign({
        sub: owner.id,
        email: owner.email,
        username: owner.username,
        entitlements: [],
      });

      const plan = await fetch(
        `${base}/api/v1/workspaces/${orgId}/members/${member.keycloakId}/removal`,
        {
          headers: { Authorization: `Bearer ${session}` },
        },
      );
      expect(plan.status).toBe(200);
      expect(await plan.json()).toMatchObject({
        is_member: true,
        revokes: { membership: true, workspace_tokens: 1, unbound_tokens: 0, m365_connections: 0 },
        keeps: { quote_share_links: 'kept' },
      });

      const removed = await fetch(
        `${base}/api/v1/workspaces/${orgId}/members/${member.keycloakId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${session}` },
        },
      );
      expect(removed.status).toBe(204);
      expect(await asUser(token.plaintext, `/workspaces/${orgId}`)).toBe(401);
      const again = await fetch(`${base}/api/v1/workspaces/${orgId}/members/${member.keycloakId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session}` },
      });
      expect(again.status).toBe(404); // unchanged answer for a member already removed
    });
  });

  describe('the service token', () => {
    it('refuses a missing, wrong-issuer, replayed or over-long token with 401', async () => {
      const orgId = randomUUID();
      await provision(orgId);
      const path = `${base}${BASE}/${orgId}`;
      expect((await fetch(path)).status).toBe(401);
      for (const token of [
        controlPlaneToken({ iss: 'not-ops-center' }),
        controlPlaneToken({ aud: 'project-ops' }),
        controlPlaneToken({ exp: Math.floor(Date.now() / 1000) + 120 }),
      ]) {
        expect((await fetch(path, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(
          401,
        );
      }
      const once = controlPlaneToken();
      expect((await fetch(path, { headers: { Authorization: `Bearer ${once}` } })).status).toBe(
        200,
      );
      expect((await fetch(path, { headers: { Authorization: `Bearer ${once}` } })).status).toBe(
        401,
      );
    });

    it('answers 503 when the replay store is full', async () => {
      const store = app.get<ProvisioningJtiStore>(PROVISIONING_JTI_STORE);
      const full = new ProvisioningJtiStore(0);
      const original = store.accept.bind(store);
      store.accept = full.accept.bind(full);
      try {
        expect((await call('GET', `${BASE}/${randomUUID()}`)).status).toBe(503);
      } finally {
        store.accept = original;
      }
    });

    it('answers 404 on every route when the secret is shorter than 32 bytes', async () => {
      process.env.PROVISIONING_JWT_SECRET = 'too-short';
      try {
        const id = randomUUID();
        expect((await call('POST', BASE, createBody(id))).status).toBe(404);
        expect((await call('GET', `${BASE}/${id}`)).status).toBe(404);
        expect((await call('PATCH', `${BASE}/${id}`, { state: 'active' })).status).toBe(404);
        expect((await call('DELETE', `${BASE}/${id}/members/x`)).status).toBe(404);
      } finally {
        process.env.PROVISIONING_JWT_SECRET = SECRET;
      }
    });
  });
});

@Module({})
class EmptyModule {}

describe('PROVISIONING_ENABLED off', () => {
  let app: INestApplication;
  let base: string;
  beforeAll(async () => {
    ({ app, base } = await buildApp([EmptyModule, ProvisioningModule.register(false)]));
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it('every new route answers the same 404 as a route that never existed', async () => {
    const token = controlPlaneToken();
    const id = randomUUID();
    const never = await fetch(`${base}/api/v1/never-registered`, { method: 'POST' });
    const neverBody = await never.json();
    for (const [method, path] of [
      ['POST', BASE],
      ['GET', `${BASE}/${id}`],
      ['PATCH', `${BASE}/${id}`],
      ['DELETE', `${BASE}/${id}/members/${randomUUID()}`],
    ]) {
      const res = await fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(Object.keys(neverBody).sort());
      expect(body.message).toBe(`Cannot ${method} ${path}`);
    }
  });
});

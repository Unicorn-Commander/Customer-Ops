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
import { AuthService } from '../auth/auth.service';
import * as orgEntitlements from '../auth/org-entitlements.client';
import { MembershipService } from '../common/workspace/membership.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { AuditService } from '../audit/audit.service';
import { GdprService } from '../gdpr/gdpr.service';

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

  function ownerSession(owner: User): string {
    return app.get(JwtService).sign({
      sub: owner.id,
      email: owner.email,
      username: owner.username,
      entitlements: [],
    });
  }

  async function asOwner(session: string, method: string, path: string) {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${session}` },
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function membershipOf(user: User, workspaceId: string) {
    return db.membership.findUnique({
      where: { userKey_workspaceId: { userKey: user.keycloakId!, workspaceId } },
    });
  }

  async function lockedWrite(orgId: string) {
    return db.withWorkspace(orgId, null, (tx) =>
      tx.auditLog.create({ data: { workspaceId: orgId, action: 'UPDATE', resource: 'fixture' } }),
    );
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
      await db.federationWorkspaceMap.deleteMany({
        where: { localWorkspaceId: { in: workspaces } },
      });
      await db.customer.deleteMany({ where: { workspaceId: { in: workspaces } } });
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

  describe("the contact-ops map from Contact-Ops' org lookup (C1)", () => {
    const CO = 'https://contacts.example.com';
    const TOKEN_URL = 'https://sso.example.com/realms/uchub/protocol/openid-connect/token';
    const LOOKUP_ENV = {
      CONTACT_OPS_BASE_URL: CO,
      CONTACT_OPS_LOOKUP_CLIENT_ID: 'contact-ops-org-lookup-client',
      CONTACT_OPS_LOOKUP_CLIENT_SECRET: 'fixture-secret-not-real',
      CONTACT_OPS_LOOKUP_TOKEN_URL: TOKEN_URL,
    };
    const realFetch = global.fetch;
    /** org id -> what the fake Contact-Ops lookup answers next (default 404). */
    let answers: Record<string, () => Response | Promise<Response>>;
    let asked: string[];
    const HANG = () => json(599, {});
    const STALL_BODY = () => json(598, {});

    function json(status: number, body: unknown): Response {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    function tenantOf(orgId: string, tenantId: string, echo = orgId) {
      return () => json(200, { ops_center_org_id: echo, tenant_id: tenantId, tenant_slug: 'acme' });
    }
    async function mapOf(orgId: string) {
      return db.federationWorkspaceMap.findUnique({
        where: {
          localWorkspaceId_targetApp: { localWorkspaceId: orgId, targetApp: 'contact-ops' },
        },
      });
    }

    beforeEach(() => {
      Object.assign(process.env, LOOKUP_ENV);
      answers = {};
      asked = [];
      global.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        if (url === TOKEN_URL) return json(200, { access_token: 'lookup-cc', expires_in: 300 });
        const m =
          /^https:\/\/contacts\.example\.com\/api\/service\/ops-center-orgs\/([^/]+)\/tenant$/.exec(
            url,
          );
        if (m) {
          expect(init?.headers?.Authorization).toBe('Bearer lookup-cc');
          const org = decodeURIComponent(m[1]);
          asked.push(org);
          const answer = answers[org] ?? (() => json(404, { detail: 'no tenant' }));
          // A hung Contact-Ops: only the caller's abort signal ends it, as with real fetch.
          if (answer === HANG) {
            return new Promise<Response>((_resolve, reject) =>
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
            );
          }
          // Headers arrive, the body never finishes: only the abort signal ends it (R3-4).
          if (answer === STALL_BODY) {
            const body = new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new TextEncoder().encode('{"ops_center_org_id":'));
                init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
              },
            });
            return new Response(body, { status: 200 });
          }
          return answer();
        }
        return realFetch(input, init);
      }) as typeof fetch;
    });
    afterEach(() => {
      global.fetch = realFetch;
      for (const k of Object.keys(LOOKUP_ENV)) delete process.env[k];
    });

    it('a new workspace gets its map row from the lookup answer for THAT org id', async () => {
      const orgId = randomUUID();
      const tenant = randomUUID();
      answers[orgId] = tenantOf(orgId, tenant);
      expect((await provision(orgId)).status).toBe(201);
      expect(asked).toEqual([orgId]);
      expect(await mapOf(orgId)).toMatchObject({ targetWorkspaceId: tenant });
    });

    it('a replay writes the row when the first provisioning could not', async () => {
      const orgId = randomUUID();
      const tenant = randomUUID();
      answers[orgId] = () => json(503, { detail: 'cannot verify tokens' });
      expect((await provision(orgId)).status).toBe(201);
      expect(await mapOf(orgId)).toBeNull();
      answers[orgId] = tenantOf(orgId, tenant);
      expect((await provision(orgId)).status).toBe(200);
      expect(await mapOf(orgId)).toMatchObject({ targetWorkspaceId: tenant });
    });

    it('an answer for another org id writes no row', async () => {
      const orgId = randomUUID();
      answers[orgId] = tenantOf(orgId, randomUUID(), randomUUID());
      expect((await provision(orgId)).status).toBe(201);
      expect(await mapOf(orgId)).toBeNull();
    });

    it('an existing row that disagrees with the lookup is left as it is', async () => {
      const orgId = randomUUID();
      const kept = randomUUID();
      expect((await provision(orgId)).status).toBe(201);
      await db.federationWorkspaceMap.create({
        data: { localWorkspaceId: orgId, targetApp: 'contact-ops', targetWorkspaceId: kept },
      });
      answers[orgId] = tenantOf(orgId, randomUUID());
      expect((await provision(orgId)).status).toBe(200);
      expect(await mapOf(orgId)).toMatchObject({ targetWorkspaceId: kept });
    });

    it('C2: 404 (no tenant for the org) writes no row; provisioning succeeds', async () => {
      const orgId = randomUUID();
      expect((await provision(orgId)).status).toBe(201);
      expect(asked).toEqual([orgId]);
      expect(await mapOf(orgId)).toBeNull();
    });

    it('C2: 401, 503, a timeout, a stalled body or a refused connection writes no row; provisioning succeeds', async () => {
      process.env.CONTACT_OPS_TIMEOUT_MS = '50';
      const failures: Array<() => Response | Promise<Response>> = [
        () => json(401, { detail: 'bad token' }),
        () => json(503, { detail: 'cannot verify tokens' }),
        HANG,
        STALL_BODY,
        () => {
          throw new TypeError('fetch failed');
        },
      ];
      try {
        for (const fail of failures) {
          const orgId = randomUUID();
          answers[orgId] = fail;
          expect((await provision(orgId)).status).toBe(201);
          expect(await mapOf(orgId)).toBeNull();
          expect((await provision(orgId)).status).toBe(200);
        }
      } finally {
        delete process.env.CONTACT_OPS_TIMEOUT_MS;
      }
    });

    it('DORMANT: with the lookup client unset, no lookup is made and no row is written', async () => {
      delete process.env.CONTACT_OPS_LOOKUP_CLIENT_SECRET;
      const orgId = randomUUID();
      answers[orgId] = tenantOf(orgId, randomUUID());
      expect((await provision(orgId)).status).toBe(201);
      expect(asked).toEqual([]);
      expect(await mapOf(orgId)).toBeNull();
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

  describe('sign-in to a suspended or archived workspace', () => {
    it('an existing and a new member both get in; a tenant write is still refused with 423', async () => {
      const orgId = randomUUID();
      await provision(orgId);
      const existing = await person('kai.existing');
      await join(existing, orgId);
      const signin = app.get(WorkspaceProvisioningService);
      for (const state of ['suspended', 'archived']) {
        await call('PATCH', `${BASE}/${orgId}`, { state });
        const newcomer = await person(`nia.new.${state}`);
        for (const user of [existing, newcomer]) {
          const result = await signin.provisionEntitledOrgWorkspace({
            user,
            orgId,
            role: 'member',
          });
          expect(result.workspaceId).toBe(orgId);
          expect(result.membership.status).toBe(MembershipStatus.ACTIVE);
        }
        await expect(lockedWrite(orgId)).rejects.toMatchObject({ status: 423 });
      }
      await call('PATCH', `${BASE}/${orgId}`, { state: 'active' });
    });

    it('a GDPR erase still runs on a suspended workspace', async () => {
      const orgId = randomUUID();
      await provision(orgId);
      const customer = await db.customer.create({
        data: { workspaceId: orgId, contactId: randomUUID() },
      });
      await call('PATCH', `${BASE}/${orgId}`, { state: 'suspended' });
      const gdpr = new GdprService(
        db,
        app.get(WorkspaceContextService),
        app.get(MembershipService),
        app.get(AuditService, { strict: false }),
      );
      const result = await gdpr.eraseCustomerCore(orgId, customer.id, null, 'erasure-request');
      expect(result.erased).toBe(true);
      expect(await db.customer.count({ where: { id: customer.id } })).toBe(0);
      await expect(lockedWrite(orgId)).rejects.toMatchObject({ status: 423 });
    });
  });

  describe('pause and resume', () => {
    it('a paused member stays paused through a sign-in and is refused at request time; tokens are kept', async () => {
      const orgId = randomUUID();
      await provision(orgId);
      const owner = await person('pia.owner');
      const member = await person('pat.paused');
      await join(owner, orgId, WorkspaceRole.OWNER);
      await join(member, orgId);
      const token = await pat(member, orgId);
      const session = ownerSession(owner);
      expect(await asUser(token.plaintext, `/workspaces/${orgId}`)).toBe(200);

      const paused = await asOwner(
        session,
        'POST',
        `/workspaces/${orgId}/members/${member.keycloakId}/pause`,
      );
      expect(paused).toEqual({
        status: 200,
        body: { user_key: member.keycloakId, role: 'member', status: 'suspended' },
      });
      expect(await asUser(token.plaintext, `/workspaces/${orgId}`)).toBe(403);
      expect(
        (await db.personalAccessToken.findUniqueOrThrow({ where: { id: token.id } })).revokedAt,
      ).toBeNull();

      // A sign-in with a positive entitlement answer does not undo the pause.
      await app.get(WorkspaceProvisioningService).provisionEntitledOrgWorkspace({
        user: member,
        orgId,
        role: 'member',
      });
      expect((await membershipOf(member, orgId))!.status).toBe(MembershipStatus.SUSPENDED);
      expect(await asUser(token.plaintext, `/workspaces/${orgId}`)).toBe(403);

      const resumed = await asOwner(
        session,
        'POST',
        `/workspaces/${orgId}/members/${member.keycloakId}/resume`,
      );
      expect(resumed.body.status).toBe('active');
      expect(await asUser(token.plaintext, `/workspaces/${orgId}`)).toBe(200);
    });

    it('refuses to pause the last owner, 404s a non-member, and is owner only', async () => {
      const orgId = randomUUID();
      await provision(orgId);
      const owner = await person('olu.owner');
      const member = await person('mo.member');
      await join(owner, orgId, WorkspaceRole.OWNER);
      await join(member, orgId);
      const session = ownerSession(owner);
      expect(
        (await asOwner(session, 'POST', `/workspaces/${orgId}/members/${owner.keycloakId}/pause`))
          .status,
      ).toBe(400);
      expect((await membershipOf(owner, orgId))!.status).toBe(MembershipStatus.ACTIVE);
      expect(
        (await asOwner(session, 'POST', `/workspaces/${orgId}/members/${randomUUID()}/pause`))
          .status,
      ).toBe(404);
      expect(
        (
          await asOwner(
            ownerSession(member),
            'POST',
            `/workspaces/${orgId}/members/${owner.keycloakId}/pause`,
          )
        ).status,
      ).toBe(403);
    });
  });

  describe('a revoked member returning at sign-in', () => {
    const verdict = (orgId: string | null, allowed: boolean) => ({
      outcome: allowed ? ('allowed' as const) : ('denied' as const),
      allowed,
      entitled: allowed,
      orgId,
      tier: null,
      role: 'member',
      orgName: null,
      reason: 'integration fixture',
    });

    it('returns only on a positive entitlement answer, and with no old token back', async () => {
      const orgId = randomUUID();
      await provision(orgId);
      const member = await person('rae.returning');
      await join(member, orgId);
      const token = await pat(member, orgId);
      expect((await call('DELETE', `${BASE}/${orgId}/members/${member.keycloakId}`)).status).toBe(
        204,
      );
      expect((await membershipOf(member, orgId))!.status).toBe(MembershipStatus.REVOKED);

      const saved = {
        on: process.env.CUSTOMER_OPS_ENTITLEMENTS_ENABLED,
        url: process.env.UC_ENTITLEMENTS_URL,
      };
      process.env.CUSTOMER_OPS_ENTITLEMENTS_ENABLED = 'true';
      process.env.UC_ENTITLEMENTS_URL = 'https://entitlements.example.com/api/v1/me/entitlements';
      const spy = jest.spyOn(orgEntitlements, 'resolveOrgEntitlement');
      const signIn = () =>
        app
          .get(AuthService)
          .validateKeycloakUser(
            member.keycloakId!,
            { email: member.email, email_verified: true },
            'fixture-forwarded-bearer',
          );
      try {
        spy.mockResolvedValue(verdict(orgId, false));
        await signIn().catch(() => undefined); // denied: may or may not admit by other rules
        expect((await membershipOf(member, orgId))!.status).toBe(MembershipStatus.REVOKED);

        spy.mockResolvedValue(verdict(orgId, true));
        await signIn();
        expect((await membershipOf(member, orgId))!.status).toBe(MembershipStatus.ACTIVE);
      } finally {
        spy.mockRestore();
        process.env.CUSTOMER_OPS_ENTITLEMENTS_ENABLED = saved.on;
        process.env.UC_ENTITLEMENTS_URL = saved.url;
        if (saved.on === undefined) delete process.env.CUSTOMER_OPS_ENTITLEMENTS_ENABLED;
        if (saved.url === undefined) delete process.env.UC_ENTITLEMENTS_URL;
      }
      // Back as a member, but the token revoked at removal stays revoked.
      expect(await asUser(token.plaintext, `/workspaces/${orgId}`)).toBe(401);
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

    it('revokes the credentials of a person with no membership row here, and only once', async () => {
      const orgId = randomUUID();
      const otherOrg = randomUUID();
      await provision(orgId);
      await provision(otherOrg);
      const membershipSvc = app.get(MembershipService);
      for (const enforced of [true, false]) {
        const ghost = await person(`gus.norow.${enforced}`);
        await join(ghost, otherOrg); // another active membership elsewhere
        const bound = await pat(ghost, orgId);
        const unbound = await pat(ghost, null);
        await db.m365Connection.create({
          data: {
            userId: ghost.id,
            workspaceId: orgId,
            m365UserId: `graph-${ghost.id}`,
            scopes: [],
            refreshTokenEnc: 'fixture-ciphertext',
          },
        });
        process.env.CUSTOMER_OPS_TENANCY_ENABLED = String(enforced);
        try {
          const preview = await membershipSvc.planMemberRemoval(orgId, ghost.keycloakId!);
          expect(preview).toMatchObject({
            is_member: false,
            revokes: {
              membership: false,
              workspace_tokens: 1,
              unbound_tokens: enforced ? 0 : 1,
              m365_connections: 1,
            },
            keeps: { unbound_tokens: enforced ? 1 : 0 },
          });
          expect(
            (await call('DELETE', `${BASE}/${orgId}/members/${ghost.keycloakId}`)).status,
          ).toBe(204);
          const snapshot = await db.personalAccessToken.findMany({
            where: { userId: ghost.id },
            orderBy: { id: 'asc' },
          });
          expect(
            (await db.personalAccessToken.findUniqueOrThrow({ where: { id: bound.id } })).revokedAt,
          ).not.toBeNull();
          const unboundAfter = await db.personalAccessToken.findUniqueOrThrow({
            where: { id: unbound.id },
          });
          expect(unboundAfter.revokedAt === null).toBe(enforced);
          expect(
            await db.m365Connection.count({ where: { userId: ghost.id, workspaceId: orgId } }),
          ).toBe(0);
          expect(await membershipOf(ghost, orgId)).toBeNull(); // no row created

          // The second call revokes nothing more.
          expect(
            (await call('DELETE', `${BASE}/${orgId}/members/${ghost.keycloakId}`)).status,
          ).toBe(204);
          expect(
            await db.personalAccessToken.findMany({
              where: { userId: ghost.id },
              orderBy: { id: 'asc' },
            }),
          ).toEqual(snapshot);
          expect((await membershipOf(ghost, otherOrg))!.status).toBe(MembershipStatus.ACTIVE);
        } finally {
          process.env.CUSTOMER_OPS_TENANCY_ENABLED = 'true';
        }
      }
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
    it("with PROVISIONING_ENABLED off, the app's own removal still revokes the person's credentials", async () => {
      const orgId = randomUUID();
      await provision(orgId);
      const owner = await person('fay.owner');
      const member = await person('flo.member');
      await join(owner, orgId, WorkspaceRole.OWNER);
      await join(member, orgId);
      const token = await pat(member, orgId);
      const session = ownerSession(owner);
      process.env.PROVISIONING_ENABLED = 'false';
      try {
        const plan = await asOwner(
          session,
          'GET',
          `/workspaces/${orgId}/members/${member.keycloakId}/removal`,
        );
        expect(plan.status).toBe(200);
        expect(plan.body.revokes).toMatchObject({ membership: true, workspace_tokens: 1 });
        // The preview never probes someone who is not on the roster.
        expect(
          (await asOwner(session, 'GET', `/workspaces/${orgId}/members/${randomUUID()}/removal`))
            .status,
        ).toBe(404);
        expect(
          (await asOwner(session, 'DELETE', `/workspaces/${orgId}/members/${member.keycloakId}`))
            .status,
        ).toBe(204);
        expect(
          (await db.personalAccessToken.findUniqueOrThrow({ where: { id: token.id } })).revokedAt,
        ).not.toBeNull();
        // Same answers as before: 404 the second time, 400 for the last owner.
        expect(
          (await asOwner(session, 'DELETE', `/workspaces/${orgId}/members/${member.keycloakId}`))
            .status,
        ).toBe(404);
        expect(
          (await asOwner(session, 'DELETE', `/workspaces/${orgId}/members/${owner.keycloakId}`))
            .status,
        ).toBe(400);
      } finally {
        process.env.PROVISIONING_ENABLED = 'true';
      }
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

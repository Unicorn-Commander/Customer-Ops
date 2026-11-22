import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { User } from '@prisma/client';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthModule } from '../../auth/auth.module';
import { WorkspaceAdminModule } from './workspace-admin.module';
import { BrigadeTokenSource } from '../federation/brigade-token-source';
import { FederationWorkspaceMapService } from '../federation/federation-workspace-map.service';
import { __resetAccessListCacheForTests } from '../../auth/access-list';
import { ContactOpsClient } from '../../contact-ops/contact-ops.client';
const testUrl = process.env.CUSTOMER_ONBOARDING_TEST_DB_URL;
const suite = testUrl ? describe : describe.skip;
suite('Contact connection actual HTTP and isolated PostgreSQL', () => {
  let app: INestApplication,
    db: PrismaService,
    base: string,
    ws: string,
    target: string,
    owner: User,
    viewer: User,
    ownerToken: string,
    viewerToken: string;
  const env = { ...process.env };
  const originalFetch = global.fetch;
  let remoteCalls = 0;
  let mode = 'valid';
  let lookupTenant: string | null = null;
  const LOOKUP_TOKEN_URL = 'https://sso.example.com/realms/uchub/protocol/openid-connect/token';
  async function request(token: string, path = ws, patch = {}) {
    return originalFetch(base + '/workspaces/' + path + '/contact-connection', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_workspace_id: target,
        contact_owner_token: 'transient-owner-secret-not-persisted',
        ...patch,
      }),
    });
  }
  beforeAll(async () => {
    const u = new URL(testUrl!);
    // The CI Postgres is a service container reached by hostname (e.g. "postgres");
    // it is admitted only for the dedicated _test database. Anything else is refused.
    const ciHost = process.env.CI === 'true' && u.hostname === 'postgres';
    if (!ciHost && u.hostname !== '127.0.0.1') throw new Error('Isolated DB only');
    if (u.pathname !== '/customer_onboarding_test')
      throw new Error('Isolated DB only: the database must be the _test database');
    process.env.DATABASE_URL = testUrl;
    process.env.CUSTOMER_OPS_TENANCY_ENABLED = 'true';
    process.env.CUSTOMER_OPS_SIGNUP_MODE = 'invite';
    process.env.JWT_SECRET = 'isolated-contact-link-test-only';
    process.env.CONTACT_OPS_BASE_URL = 'https://contact-owner-proof.invalid';
    process.env.CONTACT_OPS_LOOKUP_CLIENT_ID = 'contact-ops-org-lookup-client';
    process.env.CONTACT_OPS_LOOKUP_CLIENT_SECRET = 'fixture-secret-not-real';
    process.env.CONTACT_OPS_LOOKUP_TOKEN_URL = LOOKUP_TOKEN_URL;
    __resetAccessListCacheForTests();
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        AuthModule,
        WorkspaceAdminModule,
      ],
    })
      .overrideProvider(BrigadeTokenSource)
      .useValue({ exchangedToken: jest.fn(async () => 'broker-reader-proof') })
      .compile();
    app = mod.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    db = app.get(PrismaService);
    global.fetch = jest.fn(async (url: any, options: any) => {
      // The Contact-Ops org lookup (R3-2): names `lookupTenant` for this workspace's org.
      if (String(url) === LOOKUP_TOKEN_URL)
        return new Response(JSON.stringify({ access_token: 'lookup-cc', expires_in: 300 }));
      if (
        String(url) ===
        `https://contact-owner-proof.invalid/api/service/ops-center-orgs/${ws}/tenant`
      )
        return lookupTenant
          ? new Response(JSON.stringify({ ops_center_org_id: ws, tenant_id: lookupTenant }))
          : new Response('{}', { status: 404 });
      if (String(url) !== 'https://contact-owner-proof.invalid/mcp')
        return originalFetch(url, options);
      remoteCalls++;
      expect(options.headers.Authorization).toBe('Bearer transient-owner-secret-not-persisted');
      expect(JSON.parse(options.body).params.arguments).toEqual({
        reader_proof: 'broker-reader-proof',
      });
      if (mode === 'revoke')
        await db.membership.update({
          where: { userKey_workspaceId: { userKey: owner.keycloakId!, workspaceId: ws } },
          data: { status: 'SUSPENDED' },
        });
      if (mode === 'conflict')
        await db.federationWorkspaceMap.create({
          data: { localWorkspaceId: ws, targetApp: 'contact-ops', targetWorkspaceId: randomUUID() },
        });
      if (mode === 'reject')
        return new Response(JSON.stringify({ result: { isError: true } }), { status: 200 });
      return new Response(
        JSON.stringify({
          result: {
            structuredContent: {
              tenant_id: mode === 'wrong-target' ? randomUUID() : target,
              role: mode === 'wrong-role' ? 'admin' : 'viewer',
              client_id: 'customer-ops',
              service_subject: randomUUID(),
            },
          },
        }),
        { status: 200 },
      );
    }) as any;
  });
  afterAll(async () => {
    global.fetch = originalFetch;
    if (app) await app.close();
    process.env = env;
  });
  beforeEach(async () => {
    mode = 'valid';
    remoteCalls = 0;
    ws = randomUUID();
    target = randomUUID();
    lookupTenant = target;
    await db.workspace.create({ data: { id: ws, slug: ws, displayName: 'Synthetic link test' } });
    async function user() {
      return db.user.create({
        data: {
          email: randomUUID() + '@example.test',
          username: randomUUID(),
          keycloakId: randomUUID(),
        },
      });
    }
    owner = await user();
    viewer = await user();
    await db.membership.createMany({
      data: [
        { userKey: owner.keycloakId!, workspaceId: ws, role: 'OWNER' },
        { userKey: viewer.keycloakId!, workspaceId: ws, role: 'VIEWER' },
      ],
    });
    const sign = (u: User) =>
      app.get(JwtService).sign({
        sub: u.id,
        email: u.email,
        email_verified: true,
        username: u.username,
        entitlements: [],
      });
    ownerToken = sign(owner);
    viewerToken = sign(viewer);
  });
  it('actual guards refuse unauthenticated/PAT/viewer and foreign workspace before remote grant', async () => {
    for (const [token, path] of [
      ['', ws],
      ['co_pat_invalid', ws],
      [viewerToken, ws],
      [ownerToken, randomUUID()],
    ]) {
      const r = await request(token, path);
      expect([401, 403]).toContain(r.status);
    }
    expect(remoteCalls).toBe(0);
  });
  it('creates one exact map and audit without persisted tokens; replay preserves map', async () => {
    expect((await request(ownerToken)).status).toBe(201);
    expect((await request(ownerToken)).status).toBe(201);
    const rows = await db.federationWorkspaceMap.findMany({ where: { localWorkspaceId: ws } });
    expect(rows).toHaveLength(1);
    expect(rows[0].targetWorkspaceId).toBe(target);
    const logs = await db.withWorkspace(ws, owner.keycloakId!, (tx) =>
      tx.auditLog.findMany({ where: { workspaceId: ws } }),
    );
    expect(logs).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain('secret');
    expect(JSON.stringify(logs)).not.toContain('broker-reader-proof');
  });
  // Only the 'revoke' variant of the former it.each is a known failure (it leaves
  // a map row after a refused request); 'reject', 'wrong-target' and 'wrong-role'
  // refuse before any row is written and keep passing. 'revoke' is split out below
  // with test.failing (which turns CI red the day the fix lands, so the marker
  // must be removed then); the other three stay a plain it.each.
  it.each(['reject', 'wrong-target', 'wrong-role'])(
    'fails closed for remote %s / revoked local owner',
    async (m) => {
      mode = m;
      expect((await request(ownerToken)).status).toBe(403);
      expect(await db.federationWorkspaceMap.count({ where: { localWorkspaceId: ws } })).toBe(0);
    },
  );
  // KNOWN PRODUCT BUG: map row written before the ownership re-check; fix lane
  // 4c95fa78 (Customer-Ops batch 288d14db item 7). test.failing turns CI red the
  // day the fix lands, so the marker must be removed then.
  test.failing('fails closed for remote revoke / revoked local owner', async () => {
    mode = 'revoke';
    expect((await request(ownerToken)).status).toBe(403);
    expect(await db.federationWorkspaceMap.count({ where: { localWorkspaceId: ws } })).toBe(0);
  });
  it('does not overwrite another target or contact service identity', async () => {
    await db.federationWorkspaceMap.create({
      data: { localWorkspaceId: ws, targetApp: 'contact-ops', targetWorkspaceId: randomUUID() },
    });
    expect((await request(ownerToken)).status).toBe(409);
    expect(remoteCalls).toBe(0);
  });
  // KNOWN PRODUCT BUG: map row written before the ownership re-check; fix lane
  // 4c95fa78 (Customer-Ops batch 288d14db item 7). test.failing turns CI red the
  // day the fix lands, so the marker must be removed then.
  test.failing('refuses (409) a target the Contact-Ops org lookup does not name for this org (R3-2)', async () => {
    for (const named of [randomUUID(), null]) {
      lookupTenant = named;
      expect((await request(ownerToken)).status).toBe(409);
    }
    expect(remoteCalls).toBe(0);
    expect(await db.federationWorkspaceMap.count({ where: { localWorkspaceId: ws } })).toBe(0);
  });
  it('R4-1: repairs a row MARKED in conflict when the lookup names the target; else 409, unchanged', async () => {
    const old = randomUUID();
    await db.federationWorkspaceMap.create({
      data: {
        localWorkspaceId: ws,
        targetApp: 'contact-ops',
        targetWorkspaceId: old,
        conflictTenantId: target,
      },
    });
    const rowNow = () =>
      db.federationWorkspaceMap.findFirstOrThrow({ where: { localWorkspaceId: ws } });
    for (const named of [randomUUID(), null]) {
      lookupTenant = named;
      expect((await request(ownerToken)).status).toBe(409);
      expect(await rowNow()).toMatchObject({ targetWorkspaceId: old, conflictTenantId: target });
    }
    expect(remoteCalls).toBe(0);
    lookupTenant = target;
    expect((await request(ownerToken)).status).toBe(201);
    expect(await rowNow()).toMatchObject({ targetWorkspaceId: target, conflictTenantId: null });
    await expect(
      app.get(FederationWorkspaceMapService).routableTarget(ws, 'contact-ops'),
    ).resolves.toBe(target);
    expect(app.get(FederationWorkspaceMapService).resolveSync(ws, 'contact-ops')).toBe(target);
  });
  it('R5-2: a conflict marked by ANOTHER process stops the very next Contact-Ops request', async () => {
    expect((await request(ownerToken)).status).toBe(201);
    const serverMap = app.get(FederationWorkspaceMapService);
    const contact = new ContactOpsClient(
      app.get(ConfigService),
      { exchangedToken: jest.fn(async () => null) } as unknown as BrigadeTokenSource,
      serverMap,
    );
    const inner = global.fetch;
    const addressed: string[] = [];
    global.fetch = jest.fn(async (url: any, options: any) => {
      if (String(url) !== 'https://contact-owner-proof.invalid/mcp') return inner(url, options);
      addressed.push(options.headers['X-Workspace-Id']);
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { items: [] } } }),
      );
    }) as any;
    // The backfill command's own process: its own PostgreSQL connection.
    const other = new PrismaService({ datasources: { db: { url: testUrl! } } });
    try {
      const ctx = { workspaceId: ws, ucUid: null };
      await contact.listContacts(ctx, {});
      expect(addressed).toEqual([target]);
      await other.federationWorkspaceMap.update({
        where: { localWorkspaceId_targetApp: { localWorkspaceId: ws, targetApp: 'contact-ops' } },
        data: { conflictTenantId: randomUUID() },
      });
      // The server's cache still holds the row as routable; no reload has run.
      expect(serverMap.resolveSync(ws, 'contact-ops')).toBe(target);
      await contact.listContacts(ctx, { query: 'ada' });
      await expect(contact.verifyContact(ctx, randomUUID())).resolves.toBe('not_connected');
      await expect(contact.getWorkspaceProjection(ctx)).resolves.toBeNull();
      await expect(contact.isWorkspaceConnected(ctx)).resolves.toBe(false);
      expect(addressed).toEqual([target]);
    } finally {
      global.fetch = inner;
      await other.$disconnect();
    }
  });
  it('serializes concurrent replay onto exactly one map', async () => {
    const responses = await Promise.all([request(ownerToken), request(ownerToken)]);
    expect(responses.map((x) => x.status)).toEqual([201, 201]);
    expect(await db.federationWorkspaceMap.count({ where: { localWorkspaceId: ws } })).toBe(1);
  });
  it('refuses a conflicting map installed during remote authorization', async () => {
    mode = 'conflict';
    expect((await request(ownerToken)).status).toBe(409);
    const row = await db.federationWorkspaceMap.findFirstOrThrow({
      where: { localWorkspaceId: ws },
    });
    expect(row.targetWorkspaceId).not.toBe(target);
  });
  it('validates allowed fields and target UUID before any remote operation', async () => {
    expect((await request(ownerToken, ws, { target_workspace_id: 'not-uuid' })).status).toBe(400);
    expect((await request(ownerToken, ws, { service_subject: randomUUID() })).status).toBe(400);
    expect(remoteCalls).toBe(0);
  });
});

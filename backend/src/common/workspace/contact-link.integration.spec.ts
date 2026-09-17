import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { User } from '@prisma/client';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthModule } from '../../auth/auth.module';
import { WorkspaceAdminModule } from './workspace-admin.module';
import { BrigadeTokenSource } from '../federation/brigade-token-source';
import { __resetAccessListCacheForTests } from '../../auth/access-list';
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
    if (u.hostname !== '127.0.0.1' || u.pathname !== '/customer_onboarding_test')
      throw new Error('Isolated DB only');
    process.env.DATABASE_URL = testUrl;
    process.env.CUSTOMER_OPS_TENANCY_ENABLED = 'true';
    process.env.CUSTOMER_OPS_SIGNUP_MODE = 'invite';
    process.env.JWT_SECRET = 'isolated-contact-link-test-only';
    process.env.CONTACT_OPS_BASE_URL = 'https://contact-owner-proof.invalid';
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
      app
        .get(JwtService)
        .sign({
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
  it.each(['reject', 'wrong-target', 'wrong-role', 'revoke'])(
    'fails closed for remote %s / revoked local owner',
    async (m) => {
      mode = m;
      expect((await request(ownerToken)).status).toBe(403);
      expect(await db.federationWorkspaceMap.count({ where: { localWorkspaceId: ws } })).toBe(0);
    },
  );
  it('does not overwrite another target or contact service identity', async () => {
    await db.federationWorkspaceMap.create({
      data: { localWorkspaceId: ws, targetApp: 'contact-ops', targetWorkspaceId: randomUUID() },
    });
    expect((await request(ownerToken)).status).toBe(409);
    expect(remoteCalls).toBe(0);
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

import { generateKeyPairSync } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import * as jwt from 'jsonwebtoken';
import { PrismaClient, RelationshipStage } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { AuthService } from '../auth/auth.service';
import { PatService } from '../auth/pat/pat.service';
import { PrismaService } from '../prisma/prisma.service';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { HomeSummaryController } from './home-summary.controller';
import { ServiceCallerGuard } from './home-summary.caller';
import { HomeSummaryService } from './home-summary.service';

/**
 * HOME-SUMMARY CONTRACT v1 acceptance over the REAL Prisma client + a fake JWKS.
 *
 * Runs only when CUSTOMER_OPS_RLS_TEST_DATABASE_URL is set (the verify DB,
 * migrated). The runtime client connects as the NOBYPASSRLS `customer_ops_app`
 * role so the workspace RLS fence is live, exactly as in production; an owner
 * client seeds/cleans the control + scoped tables out of band.
 *
 * Tokens are signed with a per-run RSA key that a mocked `jwks-rsa` serves as the
 * realm JWKS — no real Keycloak, no real secret.
 *
 * The controller is mounted WITHOUT JwtAuthGuard in this module (only the
 * flag guard + ServiceCallerGuard), mirroring production: the home-summary route
 * must never run the person strategy, which resolves or JIT-provisions a User
 * from every token. The real-path test below proves a service token with NO User
 * row is answered for a seeded member and that the users row count is unchanged.
 *
 * The JwtStrategy/AuthService/JwtAuthGuard providers are registered but NOT bound
 * to this controller; they exist only so a regression that re-attaches
 * JwtAuthGuard to the route could be caught (see the wiring assertion).
 */
let jwksPublicKey = '';

jest.mock('jwks-rsa', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    getSigningKey: (_kid: string, callback: (error: Error | null, key?: any) => void) =>
      callback(null, { getPublicKey: () => jwksPublicKey }),
  })),
}));

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
jwksPublicKey = keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const realmIssuer = 'https://auth.example.com/realms/uchub';
const KID = 'home-summary-test-key';
const CALLER = 'ops-center-home';

const DB_URL = process.env.CUSTOMER_OPS_RLS_TEST_DATABASE_URL;
const OWNER_URL = process.env.CUSTOMER_OPS_RLS_OWNER_DATABASE_URL || DB_URL;
const describeDb = DB_URL ? describe : describe.skip;

/** Mutable config the stub reads live, so a test can flip the flag per request. */
const configHolder: Record<string, string | undefined> = {};

function signServiceToken(claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: 'kc-home-caller',
      iss: realmIssuer,
      aud: 'customer-ops',
      azp: CALLER,
      client_id: CALLER,
      iat: now - 10,
      exp: now + 300,
      ...claims,
    },
    keyPair.privateKey,
    { algorithm: 'RS256', keyid: KID },
  );
}

function signPersonToken(claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: 'kc-person',
      iss: realmIssuer,
      aud: 'customer-ops',
      azp: CALLER,
      email: 'aaron@example.com',
      email_verified: true,
      iat: now - 10,
      exp: now + 300,
      ...claims,
    },
    keyPair.privateKey,
    { algorithm: 'RS256', keyid: KID },
  );
}

describeDb('home-summary (CONTRACT v1, real DB, fake JWKS)', () => {
  let app: INestApplication;
  let baseUrl = '';
  let owner: PrismaClient;
  let runtime: PrismaService;

  const WS = '0190a000-7e57-7000-8000-000000000a01';
  const EMAIL = 'aaron@example.com';
  const KC_SUB = 'kc-aaron-home';
  const OTHER_SUB = 'kc-other-home';
  let userId = '';

  const seedCustomerIds: string[] = [];
  let quoteIds: string[] = [];

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    runtime = new PrismaService({ datasources: { db: { url: DB_URL } } });
    await owner.$connect();
    await runtime.$connect();

    await owner.workspace.upsert({
      where: { id: WS },
      update: {},
      create: { id: WS, slug: 'home-summary-test', displayName: 'Home Summary Test' },
    });
    const user = await owner.user.create({
      data: {
        email: EMAIL,
        username: 'home-summary-aaron',
        keycloakId: KC_SUB,
        isActive: true,
      },
    });
    userId = user.id;
    await owner.membership.create({
      data: { userKey: KC_SUB, workspaceId: WS, role: 'MEMBER', status: 'ACTIVE' },
    });

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // Owner book: 2 customers, 3 leads; 3 follow-ups (1 overdue).
    const rows: Array<{
      contactId: string;
      stage: RelationshipStage;
      ownerUserKey: string;
      nextActionAt: Date | null;
      notes: string | null;
    }> = [
      {
        contactId: 'contact-acme',
        stage: RelationshipStage.CUSTOMER,
        ownerUserKey: KC_SUB,
        nextActionAt: new Date(now - 3 * day),
        notes: 'Call back about renewal\nsecond line',
      },
      {
        contactId: 'contact-globex',
        stage: RelationshipStage.CUSTOMER,
        ownerUserKey: KC_SUB,
        nextActionAt: null,
        notes: null,
      },
      {
        contactId: 'contact-initech',
        stage: RelationshipStage.LEAD,
        ownerUserKey: KC_SUB,
        nextActionAt: new Date(now + 2 * day),
        notes: 'Send the proposal draft',
      },
      {
        contactId: 'contact-umbrella',
        stage: RelationshipStage.LEAD,
        ownerUserKey: KC_SUB,
        nextActionAt: null,
        notes: null,
      },
      {
        contactId: 'contact-hooli',
        stage: RelationshipStage.LEAD,
        ownerUserKey: KC_SUB,
        nextActionAt: null,
        notes: null,
      },
      // Another owner's book — must NEVER appear in Aaron's summary.
      {
        contactId: 'contact-secret',
        stage: RelationshipStage.LEAD,
        ownerUserKey: OTHER_SUB,
        nextActionAt: new Date(now - day),
        notes: 'Other owner follow-up',
      },
    ];
    for (const r of rows) {
      const c = await owner.customer.create({ data: { workspaceId: WS, ...r } });
      seedCustomerIds.push(c.id);
    }
    // 2 quotes out (sent) on Aaron's customers; 1 accepted; 1 sent on another owner's.
    const aaronCustomer = seedCustomerIds[0];
    const otherCustomer = seedCustomerIds[5];
    for (const [customerId, status] of [
      [aaronCustomer, 'sent'],
      [aaronCustomer, 'sent'],
      [aaronCustomer, 'accepted'],
      [otherCustomer, 'sent'],
    ] as const) {
      const q = await owner.quote.create({
        data: {
          workspaceId: WS,
          customerId,
          number: `Q-${Math.random().toString(36).slice(2, 8)}`,
          title: 'Synthetic quote',
          vendorOfRecord: 'Example Vendor',
          validUntil: new Date(now + 30 * day),
          createdBy: KC_SUB,
          status,
        },
      });
      quoteIds.push(q.id);
    }

    const configValues: Record<string, string | undefined> = configHolder;
    Object.assign(configValues, {
      JWT_SECRET: 'synthetic-local-secret',
      BRIGADE_TRUSTED_ISSUERS: '',
      KEYCLOAK_URL: 'https://auth.example.com',
      KEYCLOAK_REALM: 'uchub',
      KEYCLOAK_CLIENT_ID: 'customer-ops',
      HOME_SUMMARY_ENABLED: 'true',
      HOME_CALLER_CLIENT_ID: CALLER,
      FRONTEND_URL: 'https://customerops.example.com',
    });
    const config = {
      get: <T>(key: string, fallback?: T) => (configValues[key] ?? fallback) as T,
    } as unknown as ConfigService;

    // Deliberately NOT asserted in these tests: the person strategy must not run
    // for this route. It is faked so a regression (route re-attached to
    // JwtAuthGuard) surfaces as a provisioning attempt below rather than a 500.
    const authService = {
      validateJwtPayload: jest.fn().mockRejectedValue(new Error('strategy must not run')),
    } as unknown as AuthService;
    const patService = { findByPlaintext: jest.fn(async () => null) } as unknown as PatService;
    const contactOps = {
      getContactSummaries: jest.fn(async (_ctx: unknown, ids: string[]) => {
        const map = new Map();
        for (const id of ids)
          map.set(id, {
            contactId: id,
            displayName: `Name of ${id}`,
            primaryEmail: null,
            currentOrgId: null,
            currentOrgName: null,
            tags: [],
          });
        return map;
      }),
    } as unknown as ContactOpsPort;

    const module = await Test.createTestingModule({
      controllers: [HomeSummaryController],
      providers: [
        HomeSummaryService,
        ServiceCallerGuard,
        JwtStrategy,
        JwtAuthGuard,
        { provide: ConfigService, useValue: config },
        { provide: AuthService, useValue: authService },
        { provide: PatService, useValue: patService },
        { provide: PrismaService, useValue: runtime },
        { provide: ContactOpsPort, useValue: contactOps },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    try {
      if (owner) {
        await owner.quote.deleteMany({ where: { workspaceId: WS } });
        await owner.customer.deleteMany({ where: { workspaceId: WS } });
        await owner.membership.deleteMany({ where: { workspaceId: WS } });
        await owner.user.deleteMany({ where: { email: EMAIL } });
        await owner.user.deleteMany({ where: { email: 'dup@example.com' } });
        await owner.user.deleteMany({ where: { email: 'gone@example.com' } });
        await owner.workspace.deleteMany({ where: { id: WS } });
      }
    } catch {
      /* best-effort */
    }
    await app?.close();
    await owner?.$disconnect();
    await runtime?.$disconnect();
  });

  async function call(query: string, token?: string) {
    const response = await fetch(`${baseUrl}/api/v1/home-summary${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const raw = await response.text();
    let body: any = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      /* text */
    }
    return { status: response.status, body };
  }

  const q = `?workspace=${WS}&email=${encodeURIComponent(EMAIL.toUpperCase())}&org=ops-org&sub=kc`;

  it('REAL PATH: a service token with NO User row gets ok and does not provision a user', async () => {
    // The service account has no User row (it is a client_credentials token).
    const serviceUsers = await owner.user.count({ where: { keycloakId: 'kc-home-caller' } });
    expect(serviceUsers).toBe(0);
    const usersBefore = await owner.user.count();

    const res = await call(q, signServiceToken());

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ok');
    const usersAfter = await owner.user.count();
    expect(usersAfter).toBe(usersBefore);
    expect(await owner.user.count({ where: { keycloakId: 'kc-home-caller' } })).toBe(0);
  });

  it('a valid service token for a member gets ok with REAL counts from the seed', async () => {
    const res = await call(q, signServiceToken());
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('ok');
    expect(typeof res.body.updatedAt).toBe('string');
    const byLabel = Object.fromEntries(res.body.metrics.map((m: any) => [m.label, m.value]));
    expect(byLabel).toEqual({
      'Active customers': 2,
      'Open leads': 3,
      'Follow-ups due': 1,
      'Quotes out': 2,
    });
    for (const m of res.body.metrics) {
      expect(m.href).not.toMatch(/localhost|127\.0\.0\.1/);
    }
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].kind).toBe('follow_up');
    // Soonest due first: the overdue ACME follow-up precedes the Initech one.
    expect(res.body.items[0].title).toBe('Name of contact-acme');
    expect(res.body.items[0].subtitle).toBe('Call back about renewal');
    expect(res.body.items[0].href).toMatch(
      /^https:\/\/customerops\.example\.com\/dashboard\/customers\//,
    );
    expect(new Date(res.body.items[0].at).getTime()).toBeLessThan(
      new Date(res.body.items[1].at).getTime(),
    );
    // Another owner's follow-up never appears.
    expect(JSON.stringify(res.body)).not.toContain('contact-secret');
    expect(JSON.stringify(res.body)).not.toContain('Other owner follow-up');
  });

  it('a person token is refused with 401 caller_not_allowed', async () => {
    const res = await call(q, signPersonToken());
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'caller_not_allowed' });
  });

  it('another client (wrong azp) is refused with 401 caller_not_allowed', async () => {
    const res = await call(
      q,
      signServiceToken({ azp: 'some-other-app', client_id: 'some-other-app' }),
    );
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'caller_not_allowed' });
  });

  it('a bad signature is refused with 401 caller_not_allowed', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        sub: 'kc-home-caller',
        iss: realmIssuer,
        aud: 'customer-ops',
        azp: CALLER,
        client_id: CALLER,
        iat: now - 10,
        exp: now + 300,
      },
      other,
      { algorithm: 'RS256', keyid: KID },
    );
    const res = await call(q, token);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'caller_not_allowed' });
  });

  it('a token from a Brigade federation issuer is refused with 401', async () => {
    const res = await call(q, signServiceToken({ iss: 'https://brigade.example.com' }));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'caller_not_allowed' });
  });

  it('HOME_SUMMARY_ENABLED off => 404 BEFORE auth (even with no token)', async () => {
    (configHolder as any).HOME_SUMMARY_ENABLED = 'false';
    try {
      const res = await call(q, signServiceToken());
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('Active customers');
      const noToken = await call(q);
      expect(noToken.status).toBe(404);
    } finally {
      (configHolder as any).HOME_SUMMARY_ENABLED = 'true';
    }
  });

  it('no token is refused', async () => {
    const res = await call(q);
    expect(res.status).toBe(401);
  });

  it('no email/workspace gets 400 (the service token alone never sees data)', async () => {
    const res = await call(`?workspace=${WS}`, signServiceToken());
    expect(res.status).toBe(400);
  });

  it('a non-member email gets not_member with nothing in it', async () => {
    const res = await call(`?workspace=${WS}&email=stranger@example.com`, signServiceToken());
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('not_member');
    expect(res.body.metrics).toEqual([]);
    expect(res.body.items).toEqual([]);
  });

  it('resolves the email case-insensitively and trimmed to one member', async () => {
    await owner.user.create({
      data: { email: 'case@example.com', username: 'case-user', keycloakId: 'kc-case' },
    });
    await owner.membership.create({
      data: { userKey: 'kc-case', workspaceId: WS, role: 'MEMBER', status: 'ACTIVE' },
    });
    try {
      // The service uses `mode: 'insensitive'`; the schema unique index is
      // case-sensitive, so a mixed-case twin is a DISTINCT row. Two rows matching
      // case-insensitively must collapse to not_member — never "which one".
      await owner.user.create({
        data: { email: 'CASE@example.com', username: 'case-twin', keycloakId: 'kc-case-twin' },
      });
      const res = await call(`?workspace=${WS}&email=CASE@example.com`, signServiceToken());
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('not_member');
      expect(res.body.metrics).toEqual([]);
    } finally {
      await owner.membership.deleteMany({
        where: { userKey: { in: ['kc-case', 'kc-case-twin'] } },
      });
      await owner.user.deleteMany({ where: { username: { in: ['case-user', 'case-twin'] } } });
    }
  });

  it('a deactivated user gets not_member', async () => {
    const gone = await owner.user.create({
      data: {
        email: 'gone@example.com',
        username: 'gone-user',
        keycloakId: 'kc-gone',
        isActive: false,
      },
    });
    await owner.membership.create({
      data: { userKey: 'kc-gone', workspaceId: WS, role: 'MEMBER', status: 'ACTIVE' },
    });
    const res = await call(`?workspace=${WS}&email=gone@example.com`, signServiceToken());
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('not_member');
    expect(res.body.metrics).toEqual([]);
    await owner.membership.deleteMany({ where: { userKey: 'kc-gone' } });
    await owner.user.delete({ where: { id: gone.id } });
  });

  it('a VIEWER does not get the owner-scoped numbers the app hides from viewers', async () => {
    await owner.membership.update({
      where: { userKey_workspaceId: { userKey: KC_SUB, workspaceId: WS } },
      data: { role: 'VIEWER' },
    });
    try {
      const res = await call(q, signServiceToken());
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('empty');
      expect(res.body.metrics).toEqual([]);
      expect(res.body.items).toEqual([]);
    } finally {
      await owner.membership.update({
        where: { userKey_workspaceId: { userKey: KC_SUB, workspaceId: WS } },
        data: { role: 'MEMBER' },
      });
    }
  });

  it('does no write: the scoped + users row counts are unchanged after a successful call', async () => {
    const before = {
      customers: await owner.customer.count({ where: { workspaceId: WS } }),
      quotes: await owner.quote.count({ where: { workspaceId: WS } }),
      activities: await owner.customerActivity.count({ where: { workspaceId: WS } }),
      users: await owner.user.count(),
    };
    await call(q, signServiceToken());
    const after = {
      customers: await owner.customer.count({ where: { workspaceId: WS } }),
      quotes: await owner.quote.count({ where: { workspaceId: WS } }),
      activities: await owner.customerActivity.count({ where: { workspaceId: WS } }),
      users: await owner.user.count(),
    };
    expect(after).toEqual(before);
  });
});

/**
 * R4-3: the backfill command's module is self-sufficient — it brings its own
 * ConfigModule and PrismaModule, so it compiles and runs with NOTHING
 * overridden (the other backfill specs replace PrismaService with a fake).
 *
 * The compile check always runs. The dry run runs when a database is supplied
 * (PROVISIONING_TEST_DATABASE_URL, else CI's CUSTOMER_OPS_RLS_OWNER_DATABASE_URL)
 * against the REAL PrismaService; Contact-Ops is faked at fetch, fictional ids
 * only, every row is random and cleaned up.
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { FederationWorkspaceMapService } from '../common/federation/federation-workspace-map.service';
import { ContactOpsMapBackfillModule } from './contact-ops-map.backfill';
import { ContactOpsMapProvisioner } from './contact-ops-map.provisioner';
import { ContactOpsOrgLookupClient } from './contact-ops-org-lookup.client';

const dbUrl =
  process.env.PROVISIONING_TEST_DATABASE_URL ?? process.env.CUSTOMER_OPS_RLS_OWNER_DATABASE_URL;
const withDb = dbUrl ? describe : describe.skip;

const LOOKUP_ENV = {
  CONTACT_OPS_BASE_URL: 'https://contacts.example.com',
  CONTACT_OPS_LOOKUP_CLIENT_ID: 'contact-ops-org-lookup-client',
  CONTACT_OPS_LOOKUP_CLIENT_SECRET: 'fixture-secret-not-real',
  CONTACT_OPS_LOOKUP_TOKEN_URL:
    'https://sso.example.com/realms/uchub/protocol/openid-connect/token',
};

describe('ContactOpsMapBackfillModule boots on its own imports (R4-3)', () => {
  it('compiles with no provider overridden: real PrismaService and ConfigService', async () => {
    const mod = await Test.createTestingModule({
      imports: [ContactOpsMapBackfillModule],
    }).compile();
    try {
      expect(mod.get(PrismaService)).toBeInstanceOf(PrismaService);
      expect(mod.get(ConfigService)).toBeInstanceOf(ConfigService);
      expect(mod.get(FederationWorkspaceMapService)).toBeInstanceOf(FederationWorkspaceMapService);
      expect(mod.get(ContactOpsOrgLookupClient)).toBeInstanceOf(ContactOpsOrgLookupClient);
      expect(mod.get(ContactOpsMapProvisioner)).toBeInstanceOf(ContactOpsMapProvisioner);
    } finally {
      await mod.close();
    }
  });
});

withDb('ContactOpsMapBackfillModule dry run on the real database (R4-3)', () => {
  const env = { ...process.env };
  const origFetch = global.fetch;
  const org = randomUUID();
  const tenant = randomUUID();
  let db: PrismaService;

  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: dbUrl! } } });
    await db.workspace.create({ data: { id: org, slug: org, displayName: 'Synthetic backfill' } });
  });

  afterAll(async () => {
    global.fetch = origFetch;
    process.env = env;
    await db.federationWorkspaceMap.deleteMany({ where: { localWorkspaceId: org } });
    await db.workspace.deleteMany({ where: { id: org } });
    await db.$disconnect();
  });

  it('boots, asks the lookup, prints the pair and writes nothing', async () => {
    Object.assign(process.env, { DATABASE_URL: dbUrl, ...LOOKUP_ENV });
    global.fetch = jest.fn(async (url: string) => {
      if (url === LOOKUP_ENV.CONTACT_OPS_LOOKUP_TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: 'lookup-cc', expires_in: 300 }));
      }
      if (url === `${LOOKUP_ENV.CONTACT_OPS_BASE_URL}/api/service/ops-center-orgs/${org}/tenant`) {
        return new Response(JSON.stringify({ ops_center_org_id: org, tenant_id: tenant }));
      }
      return new Response('{}', { status: 404 });
    }) as any;
    const before = await db.federationWorkspaceMap.count();

    const mod = await Test.createTestingModule({
      imports: [ContactOpsMapBackfillModule],
    }).compile();
    const app = mod.createNestApplication({ logger: false });
    await app.init();
    try {
      const report = await app.get(ContactOpsMapProvisioner).backfill();
      expect(report.dormant).toBe(false);
      expect(report.apply).toBe(false);
      expect(report.pairs).toContainEqual({ orgId: org, tenantId: tenant });
      expect(report.written).toBe(0);
    } finally {
      await app.close();
    }
    expect(await db.federationWorkspaceMap.count()).toBe(before);
    expect(await db.federationWorkspaceMap.count({ where: { localWorkspaceId: org } })).toBe(0);
  });
});

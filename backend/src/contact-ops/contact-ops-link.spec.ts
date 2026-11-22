import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { __resetAccessListCacheForTests } from '../auth/access-list';
import { FederationWorkspaceMapService } from '../common/federation/federation-workspace-map.service';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';
import { ContactOpsClient } from './contact-ops.client';
import { ContactOpsOrgLookupClient } from './contact-ops-org-lookup.client';
import { ContactOpsMapProvisioner } from './contact-ops-map.provisioner';
import { CONTACT_LINK_RETRY_MS, ContactOpsLinkService } from './contact-ops-link.service';

/**
 * AUD-CR-1: a brand-new org gets its Contact-Ops link row at first sign-in with
 * no prior Ops-Center POST, and a tenant that appears later is picked up on the
 * next use. Real chain: AuthService -> ContactOpsLinkService -> map writer ->
 * org lookup client; only Postgres and the network are faked.
 *
 * Fictional orgs, people and hosts (example.com) only.
 */
const ORG = '0190c000-7e57-7000-8000-0000000000a1';
const SELF_SERVE_WS = '0190c000-7e57-7000-8000-0000000000b2';
const TENANT = 'cccccccc-0000-4000-8000-0000000000a1';
const TENANT_SELF = 'dddddddd-0000-4000-8000-0000000000b2';
const CO = 'https://contacts.example.com';
const TOKEN_URL = 'https://sso.example.com/realms/uchub/protocol/openid-connect/token';
const ENV: Record<string, string> = {
  CONTACT_OPS_BASE_URL: CO,
  CONTACT_OPS_SERVICE_TOKEN: 'static-fixture-token',
  CONTACT_OPS_LOOKUP_CLIENT_ID: 'contact-ops-org-lookup-client',
  CONTACT_OPS_LOOKUP_CLIENT_SECRET: 'fixture-secret-not-real',
  CONTACT_OPS_LOOKUP_TOKEN_URL: TOKEN_URL,
};

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type MapRow = {
  localWorkspaceId: string;
  targetApp: string;
  targetWorkspaceId: string;
  conflictTenantId?: string | null;
};

function makePrisma() {
  const rows: MapRow[] = [];
  const find = (k: { localWorkspaceId: string; targetApp: string }) =>
    rows.find((r) => r.localWorkspaceId === k.localWorkspaceId && r.targetApp === k.targetApp);
  const prisma: any = {
    rows,
    $transaction: jest.fn(async (fn: any): Promise<any> => fn(prisma)),
    $executeRaw: jest.fn(async () => 1),
    federationWorkspaceMap: {
      findMany: jest.fn(async () => rows.map((r) => ({ ...r }))),
      findUnique: jest.fn(async ({ where }: any) => {
        const r = find(where.localWorkspaceId_targetApp);
        return r ? { conflictTenantId: null, ...r } : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        rows.push({ ...data });
        return data;
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    user: {
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => ({
        id: 'local-' + data.keycloakId,
        isActive: true,
        ...data,
      })),
      update: jest.fn(async ({ data }: any) => data),
    },
  };
  return prisma;
}

/** Let the not-awaited sign-in link attempt finish (every fake answers at once). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

describe('Contact-Ops link at first sign-in (AUD-CR-1)', () => {
  const origFetch = global.fetch;
  /** org id -> the tenant Contact-Ops has for it right now (absent = 404). */
  let tenants: Record<string, string>;
  let lookups: string[];
  let prisma: ReturnType<typeof makePrisma>;
  let links: ContactOpsLinkService;
  let fedMap: FederationWorkspaceMapService;
  let config: ConfigService;

  beforeEach(() => {
    __resetAccessListCacheForTests();
    tenants = {};
    lookups = [];
    global.fetch = jest.fn(async (url: string) => {
      if (url === TOKEN_URL) return json(200, { access_token: 'lookup-cc', expires_in: 300 });
      const m = /\/api\/service\/ops-center-orgs\/([^/]+)\/tenant$/.exec(url);
      if (m) {
        const org = decodeURIComponent(m[1]);
        lookups.push(org);
        const t = tenants[org];
        return t
          ? json(200, { ops_center_org_id: org, tenant_id: t, tenant_slug: 's' })
          : json(404, { detail: 'none' });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as any;
    config = { get: (k: string) => ENV[k] } as unknown as ConfigService;
    prisma = makePrisma();
    fedMap = new FederationWorkspaceMapService(prisma, config);
    const lookup = new ContactOpsOrgLookupClient(config);
    links = new ContactOpsLinkService(
      prisma,
      lookup,
      new ContactOpsMapProvisioner(prisma, lookup, fedMap),
    );
  });

  afterEach(() => {
    global.fetch = origFetch;
    delete process.env.CUSTOMER_OPS_SIGNUP_MODE;
    delete process.env.CUSTOMER_OPS_ENTITLEMENTS_ENABLED;
    delete process.env.UC_ENTITLEMENTS_URL;
    jest.restoreAllMocks();
  });

  function authService(): {
    svc: AuthService;
    provisioning: { provisionSelfServeUser: jest.Mock; provisionEntitledOrgWorkspace: jest.Mock };
  } {
    // The stored ACTIVE membership rows: whatever this sign-in provisioned.
    const held: string[] = [];
    const provisioning = {
      provisionSelfServeUser: jest.fn(async (identity: any) => {
        held.push(SELF_SERVE_WS);
        return {
          user: {
            id: 'local-new',
            keycloakId: identity.keycloakId,
            email: identity.email,
            isActive: true,
          } as User,
          workspaceId: SELF_SERVE_WS,
          membership: {},
          workspaceIdSource: 'local-fallback',
        };
      }),
      provisionEntitledOrgWorkspace: jest.fn(async (req: any) => {
        held.push(req.orgId);
        return { workspaceId: req.orgId, membership: {}, workspaceIdSource: 'local-fallback' };
      }),
    };
    const svc = new AuthService(
      { sign: jest.fn(() => 'tok') } as unknown as JwtService,
      prisma,
      provisioning as any,
      {
        ensureSeededMembership: jest.fn(async () => undefined),
        listActiveMemberships: jest.fn(async () => held.map((workspaceId) => ({ workspaceId }))),
      } as any,
      { permitsIdentity: jest.fn().mockResolvedValue(false) } as any,
      links,
    );
    return { svc, provisioning };
  }

  it('Ops-Center org: first sign-in, no prior POST, writes the link row', async () => {
    tenants[ORG] = TENANT;
    process.env.CUSTOMER_OPS_ENTITLEMENTS_ENABLED = 'true';
    process.env.UC_ENTITLEMENTS_URL = 'https://ops.example.com/api/v1/entitlements';
    const fetchLookup = global.fetch as jest.Mock;
    global.fetch = jest.fn(async (url: string, init: any) =>
      url.startsWith('https://ops.example.com/')
        ? json(200, {
            org_id: ORG,
            role: 'owner',
            entitlements: ['customer_ops_access'],
            org_name: 'Harbor Example',
          })
        : fetchLookup(url, init),
    ) as any;
    const { svc, provisioning } = authService();

    await svc.validateKeycloakUser(
      'kc-new-owner',
      { email: 'owner@harbor.example.com', email_verified: true },
      'fixture-browser-bearer',
    );
    await settle();

    expect(provisioning.provisionEntitledOrgWorkspace).toHaveBeenCalled();
    expect(prisma.rows).toEqual([
      expect.objectContaining({
        localWorkspaceId: ORG,
        targetApp: 'contact-ops',
        targetWorkspaceId: TENANT,
      }),
    ]);
  });

  it('self-serve workspace: first sign-in asks the lookup for the stored workspace id', async () => {
    tenants[SELF_SERVE_WS] = TENANT_SELF;
    process.env.CUSTOMER_OPS_SIGNUP_MODE = 'open';
    const { svc, provisioning } = authService();

    await svc.validateKeycloakUser('kc-stranger', {
      email: 'stranger@example.com',
      email_verified: true,
    });
    await settle();

    expect(provisioning.provisionSelfServeUser).toHaveBeenCalled();
    expect(lookups).toEqual([SELF_SERVE_WS]);
    expect(prisma.rows).toEqual([
      expect.objectContaining({ localWorkspaceId: SELF_SERVE_WS, targetWorkspaceId: TENANT_SELF }),
    ]);
  });

  it('sign-in never fails or waits on Contact-Ops: no tenant yet means no row, no error', async () => {
    process.env.CUSTOMER_OPS_SIGNUP_MODE = 'open';
    const { svc } = authService();
    await expect(
      svc.validateKeycloakUser('kc-stranger', { email: 'stranger@example.com' }),
    ).resolves.toMatchObject({ keycloakId: 'kc-stranger' });
    await settle();
    expect(prisma.rows).toEqual([]);
  });

  it('a tenant created later is linked on next use, after the back-off, with no operator', async () => {
    const t0 = 1_000_000;
    expect(await links.ensureLinked(ORG, t0)).toBe(false);
    expect(lookups).toEqual([ORG]);

    tenants[ORG] = TENANT;
    // Inside the back-off: no second lookup, nothing stamped.
    expect(await links.ensureLinked(ORG, t0 + 10)).toBe(false);
    expect(lookups).toEqual([ORG]);
    expect(prisma.rows).toEqual([]);

    // After the back-off: asked again, row written once.
    expect(await links.ensureLinked(ORG, t0 + CONTACT_LINK_RETRY_MS)).toBe(true);
    expect(lookups).toEqual([ORG, ORG]);
    expect(prisma.rows).toHaveLength(1);

    // Idempotent: a linked workspace reads its row and never asks the lookup.
    expect(await links.ensureLinked(ORG, t0 + 10 * CONTACT_LINK_RETRY_MS)).toBe(true);
    expect(lookups).toEqual([ORG, ORG]);
    expect(prisma.rows).toHaveLength(1);
  });

  it('concurrent first uses share one lookup and write one row', async () => {
    tenants[ORG] = TENANT;
    const [a, b] = await Promise.all([links.ensureLinked(ORG), links.ensureLinked(ORG)]);
    expect([a, b]).toEqual([true, true]);
    expect(lookups).toEqual([ORG]);
    expect(prisma.rows).toHaveLength(1);
  });

  it('a tenant created after first sign-in is linked at a later sign-in, no operator', async () => {
    process.env.CUSTOMER_OPS_SIGNUP_MODE = 'open';
    const { svc } = authService();
    const person = { email: 'stranger@example.com', email_verified: true };
    const t0 = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);

    await svc.validateKeycloakUser('kc-stranger', person);
    await settle();
    expect(lookups).toEqual([SELF_SERVE_WS]);
    expect(prisma.rows).toEqual([]);

    tenants[SELF_SERVE_WS] = TENANT_SELF;
    // A request inside the back-off asks nothing (sign-in runs per request).
    await svc.validateKeycloakUser('kc-stranger', person);
    await settle();
    expect(lookups).toEqual([SELF_SERVE_WS]);

    clock.mockReturnValue(t0 + CONTACT_LINK_RETRY_MS + 1);
    await svc.validateKeycloakUser('kc-stranger', person);
    await settle();
    expect(lookups).toEqual([SELF_SERVE_WS, SELF_SERVE_WS]);
    expect(prisma.rows).toEqual([
      expect.objectContaining({ localWorkspaceId: SELF_SERVE_WS, targetWorkspaceId: TENANT_SELF }),
    ]);
  });

  it('a service, delegated or federation token never triggers the lookup or a write', async () => {
    tenants[SELF_SERVE_WS] = TENANT_SELF;
    process.env.CUSTOMER_OPS_SIGNUP_MODE = 'open';
    const { svc } = authService();
    // First a person signs up (the workspace exists); clear what that did.
    await svc.validateKeycloakUser('kc-stranger', {
      email: 'stranger@example.com',
      email_verified: true,
    });
    await settle();
    prisma.rows.length = 0;
    lookups.length = 0;
    const fresh = new ContactOpsLinkService(
      prisma,
      new ContactOpsOrgLookupClient(config),
      new ContactOpsMapProvisioner(prisma, new ContactOpsOrgLookupClient(config), fedMap),
    );
    (svc as any).contactLinks = fresh;

    for (const extra of [
      { client_id: 'ops-center-home' },
      { clientId: 'ops-center-home' },
      { act: { sub: 'agent' } },
      { __federationActor: true },
    ]) {
      await svc
        .validateKeycloakUser('kc-stranger', {
          email: 'stranger@example.com',
          email_verified: true,
          ...extra,
        })
        .catch(() => undefined);
      await settle();
    }
    expect(lookups).toEqual([]);
    expect(prisma.rows).toEqual([]);
  });

  it('Contact-Ops calls only read the link row: an unmapped workspace is not linked on use', async () => {
    tenants[ORG] = TENANT;
    const client = new ContactOpsClient(
      config,
      { exchangedToken: jest.fn().mockResolvedValue(null) } as unknown as BrigadeTokenSource,
      fedMap,
    );
    expect(await client.isWorkspaceConnected({ workspaceId: ORG, ucUid: null })).toBe(false);
    expect(lookups).toEqual([]);
    expect(prisma.rows).toEqual([]);
  });

  it('a link row removed later is noticed: nothing is remembered as linked in memory', async () => {
    tenants[ORG] = TENANT;
    const t0 = 1_000_000;
    expect(await links.ensureLinked(ORG, t0)).toBe(true);
    expect(prisma.rows).toHaveLength(1);

    // Conflict repair / manual fix deletes the row; Contact-Ops no longer has it.
    prisma.rows.length = 0;
    delete tenants[ORG];
    expect(await links.ensureLinked(ORG, t0 + 1)).toBe(false);
    expect(lookups).toEqual([ORG, ORG]);

    // The tenant comes back: linked again after the back-off, one row.
    tenants[ORG] = TENANT;
    expect(await links.ensureLinked(ORG, t0 + 1 + CONTACT_LINK_RETRY_MS)).toBe(true);
    expect(prisma.rows).toHaveLength(1);
  });

  it('never writes over an existing row', async () => {
    prisma.rows.push({
      localWorkspaceId: ORG,
      targetApp: 'contact-ops',
      targetWorkspaceId: TENANT_SELF,
    });
    tenants[ORG] = TENANT;
    expect(await links.ensureLinked(ORG)).toBe(true);
    expect(lookups).toEqual([]);
    expect(prisma.federationWorkspaceMap.create).not.toHaveBeenCalled();
    expect(prisma.rows[0].targetWorkspaceId).toBe(TENANT_SELF);
  });
});

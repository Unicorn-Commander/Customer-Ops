import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RelationshipStage, User } from '@prisma/client';
import { CustomersService } from '../customers/customers.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { entitlementsOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { FederationWorkspaceMapService } from '../common/federation/federation-workspace-map.service';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';
import { ContactOpsClient } from './contact-ops.client';
import { ContactOpsOrgLookupClient } from './contact-ops-org-lookup.client';
import { ContactOpsMapProvisioner } from './contact-ops-map.provisioner';

/**
 * C3 (GATE-175): two Ops-Center orgs A and B, each mapped to its own Contact-Ops
 * tenant BY THE ORG LOOKUP (the real lookup client -> map writer -> federation
 * map -> Contact-Ops client -> CustomersService chain; only Postgres and the
 * network are faked). Org A's contact search and relationship create can never
 * reach org B's tenant, and an org with no map — or whose lookup answer named
 * another org — answers 409, never a fallback to another tenant.
 *
 * Fictional orgs, people and hosts (example.com) only.
 */
const ORG_A = '0190b000-7e57-7000-8000-00000000000a';
const ORG_B = '0190b000-7e57-7000-8000-00000000000b';
const ORG_NONE = '0190b000-7e57-7000-8000-00000000000c';
const ORG_LIAR = '0190b000-7e57-7000-8000-00000000000d';
const TENANT_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const TENANT_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const CO = 'https://contacts.example.com';
const TOKEN_URL = 'https://sso.example.com/realms/uchub/protocol/openid-connect/token';
const ENV: Record<string, string> = {
  CONTACT_OPS_BASE_URL: CO,
  CONTACT_OPS_SERVICE_TOKEN: 'static-fixture-token',
  CONTACT_OPS_LOOKUP_CLIENT_ID: 'contact-ops-org-lookup-client',
  CONTACT_OPS_LOOKUP_CLIENT_SECRET: 'fixture-secret-not-real',
  CONTACT_OPS_LOOKUP_TOKEN_URL: TOKEN_URL,
};

/** The Contact-Ops lookup: A and B have tenants; NONE has none; LIAR's answer names B. */
const LOOKUP: Record<string, { status: number; body?: unknown }> = {
  [ORG_A]: {
    status: 200,
    body: { ops_center_org_id: ORG_A, tenant_id: TENANT_A, tenant_slug: 'a' },
  },
  [ORG_B]: {
    status: 200,
    body: { ops_center_org_id: ORG_B, tenant_id: TENANT_B, tenant_slug: 'b' },
  },
  [ORG_LIAR]: {
    status: 200,
    body: { ops_center_org_id: ORG_B, tenant_id: TENANT_B, tenant_slug: 'b' },
  },
};
/** Each Contact-Ops tenant owns only its own people. */
const PEOPLE: Record<string, Record<string, { name: string; email: string }>> = {
  [TENANT_A]: { 'pa-1': { name: 'Ann Alpha', email: 'ann@a.example.com' } },
  [TENANT_B]: { 'pb-1': { name: 'Bob Beta', email: 'bob@b.example.com' } },
};

function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** In-memory federation_workspace_map with the real unique key. */
function makePrisma() {
  const rows: Array<{ localWorkspaceId: string; targetApp: string; targetWorkspaceId: string }> =
    [];
  return {
    rows,
    federationWorkspaceMap: {
      findMany: jest.fn(async () => rows.map((r) => ({ ...r }))),
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.localWorkspaceId_targetApp;
        return (
          rows.find(
            (r) => r.localWorkspaceId === k.localWorkspaceId && r.targetApp === k.targetApp,
          ) ?? null
        );
      }),
      create: jest.fn(async ({ data }: any) => {
        rows.push({ ...data });
        return data;
      }),
    },
  };
}

function makeTx(ws: string) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ ws }]),
    customer: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({
        id: `cust-${data.contactId}`,
        priority: 'MEDIUM',
        source: null,
        notes: null,
        ownerUserKey: null,
        expectedValue: null,
        currency: 'USD',
        nextActionAt: null,
        isLost: false,
        lostReason: null,
        closedLostAt: null,
        createdAt: new Date('2026-11-18T00:00:00Z'),
        updatedAt: new Date('2026-11-18T00:00:00Z'),
        ...data,
        stage: data.stage ?? RelationshipStage.LEAD,
      })),
    },
    customerActivity: { create: jest.fn().mockResolvedValue({}) },
  };
}

const user = {
  id: 'local-ada',
  email: 'ada@example.com',
  keycloakId: 'kc-ada-sub',
  __entitlements: ['customer-ops'],
} as unknown as User & Partial<WithWorkspaceClaim>;

describe('contact-ops map isolation across orgs (C3)', () => {
  const origFetch = global.fetch;
  /** Every Contact-Ops tenant a contact read or write was addressed to. */
  let addressed: string[];
  let txs: Record<string, ReturnType<typeof makeTx>>;
  let svc: CustomersService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    addressed = [];
    txs = {};
    global.fetch = jest.fn(async (url: string, init: any) => {
      if (url === TOKEN_URL) return json(200, { access_token: 'lookup-cc', expires_in: 300 });
      const m = /\/api\/service\/ops-center-orgs\/([^/]+)\/tenant$/.exec(url);
      if (m) {
        const a = LOOKUP[decodeURIComponent(m[1])] ?? { status: 404, body: { detail: 'none' } };
        return json(a.status, a.body);
      }
      if (url !== `${CO}/mcp`) throw new Error(`unexpected fetch ${url}`);
      const tenant = init.headers['X-Workspace-Id'] as string;
      addressed.push(tenant);
      const { params } = JSON.parse(init.body);
      const people = PEOPLE[tenant] ?? {};
      if (params.name === 'get_person') {
        const p = people[params.arguments.person_id];
        return p
          ? json(200, {
              jsonrpc: '2.0',
              id: 1,
              result: {
                structuredContent: { person_id: params.arguments.person_id, display_name: p.name },
              },
            })
          : json(200, {
              jsonrpc: '2.0',
              id: 1,
              result: { isError: true, content: [{ type: 'text', text: 'Person not found' }] },
            });
      }
      const items = Object.entries(people).map(([id, p]) => ({
        person_id: id,
        display_name: p.name,
        primary_email: p.email,
      }));
      return json(200, {
        jsonrpc: '2.0',
        id: 1,
        result: { structuredContent: { items, count: items.length } },
      });
    }) as any;

    const config = { get: (k: string) => ENV[k] } as unknown as ConfigService;
    prisma = makePrisma();
    const fedMap = new FederationWorkspaceMapService(prisma as any, config);
    const writer = new ContactOpsMapProvisioner(
      prisma as any,
      new ContactOpsOrgLookupClient(config),
      fedMap,
    );
    for (const org of [ORG_A, ORG_B, ORG_NONE, ORG_LIAR]) await writer.ensureForOrg(org);

    const contact = new ContactOpsClient(
      config,
      { exchangedToken: jest.fn().mockResolvedValue(null) } as unknown as BrigadeTokenSource,
      fedMap,
    );
    const dormant = { isConfigured: jest.fn().mockReturnValue(false) } as any;
    const workspaces = {
      resolveAuthorized: jest.fn(async (_u: User, ws: string) => ws),
      effectiveEntitlements: jest.fn(async (u: any) => entitlementsOf(u)),
      runInWorkspace: jest.fn(async (ws: string, _uc: any, fn: any) => {
        txs[ws] = txs[ws] ?? makeTx(ws);
        return fn(txs[ws]);
      }),
    } as unknown as WorkspaceContextService;
    svc = new CustomersService(workspaces, contact, dormant, dormant, dormant, dormant, dormant);
  });

  afterEach(() => {
    global.fetch = origFetch;
  });

  it('the lookup mapped exactly A -> tenant A and B -> tenant B, and nothing else', () => {
    expect(prisma.rows).toEqual([
      { localWorkspaceId: ORG_A, targetApp: 'contact-ops', targetWorkspaceId: TENANT_A },
      { localWorkspaceId: ORG_B, targetApp: 'contact-ops', targetWorkspaceId: TENANT_B },
    ]);
  });

  it("org A's contact search only ever sees tenant A's people", async () => {
    const a = await svc.searchContactsForUser(user, 'b', ORG_A);
    expect(a.items.map((c) => c.contactId)).toEqual(['pa-1']);
    const b = await svc.searchContactsForUser(user, 'b', ORG_B);
    expect(b.items.map((c) => c.contactId)).toEqual(['pb-1']);
    expect(addressed).toEqual([TENANT_A, TENANT_B]);
  });

  it("org A cannot create a relationship on org B's contact; its own contact works", async () => {
    const err = await svc.createForUser(user, { contactId: 'pb-1' }, ORG_A).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(addressed).toEqual([TENANT_A]);
    expect(txs[ORG_A]).toBeUndefined();

    const ok = await svc.createForUser(user, { contactId: 'pa-1' }, ORG_A);
    expect(ok).toMatchObject({ contactId: 'pa-1' });
    expect(txs[ORG_A].customer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: ORG_A, contactId: 'pa-1' }),
    });
    expect(addressed).toEqual([TENANT_A, TENANT_A]);
  });

  it.each([
    ['no tenant (404)', ORG_NONE],
    ['an answer naming another org', ORG_LIAR],
  ])('an org with %s answers 409 and reaches no tenant', async (_label, org) => {
    const search = await svc.searchContactsForUser(user, 'b', org);
    expect(search).toEqual({ items: [], notConnected: true });
    for (const contactId of ['pa-1', 'pb-1']) {
      const err = await svc.createForUser(user, { contactId }, org).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: 'contact_ops_not_connected' });
    }
    expect(addressed).toEqual([]);
    expect(txs[org]).toBeUndefined();
  });
});

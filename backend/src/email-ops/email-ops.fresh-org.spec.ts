import { ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RelationshipStage, User } from '@prisma/client';
import { EmailOpsClient } from './email-ops.client';
import { FederationWorkspaceMapService } from '../common/federation/federation-workspace-map.service';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';
import {
  CustomersService,
  EMAIL_NOT_ACCEPTED_MESSAGE,
  EMAIL_UNAVAILABLE_MESSAGE,
} from '../customers/customers.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { entitlementsOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';

/**
 * AUD-CR-4: compose_email for a FRESHLY provisioned org: no federation map row,
 * no FEDERATION_WORKSPACE_MAP_SEED, no EMAIL_OPS_WORKSPACE_OVERRIDE. Real chain
 * (CustomersService -> EmailOpsClient -> federation map); Email-Ops and the DB
 * are faked at the wire.
 *
 * The contract this client speaks (email-ops.client.ts header; SUITE-IDENTITY
 * D2/D4): Email-Ops is addressed by the suite workspace id, a lowercase uuid,
 * in the JSON-RPC `workspace_id`, the X-Workspace-Id header and the bearer
 * claim, all the same. A fresh org's Customer-Ops workspace id IS that id, so
 * it goes on the wire unchanged and a compose Email-Ops accepts succeeds.
 * Whether the deployed Email-Ops knows a brand-new id is NOT provable here
 * (Email-Ops is another repo); if it refuses, the customer gets a plain reason,
 * no "retry" that cannot work, and no orphan link row. Contract note and the
 * open owner decision: docs/ops/email-ops-fresh-org-contract.md (the test
 * below keeps that note's table honest).
 *
 * Fictional people and hosts (example.com) only.
 */
const FRESH_ORG = '0190d000-7e57-7000-8000-0000000000f1';
const EO = 'https://mail.example.com';
const ENV: Record<string, string> = {
  EMAIL_OPS_BASE_URL: EO,
  EMAIL_OPS_SERVICE_TOKEN: 'static-fixture-token',
};
const user = {
  id: 'local-rep',
  email: 'rep@example.com',
  keycloakId: 'kc-rep',
  __entitlements: ['customer-ops', 'email-ops'],
} as unknown as User & Partial<WithWorkspaceClaim>;

function rpc(result: unknown) {
  const body = { jsonrpc: '2.0', id: 1, result };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
}

function setup(answer: () => Response | Promise<Response>) {
  const calls: Array<{ headers: Record<string, string>; args: Record<string, unknown> }> = [];
  global.fetch = jest.fn(async (url: string, init: any) => {
    if (url !== `${EO}/mcp`) throw new Error(`unexpected fetch ${url}`);
    calls.push({ headers: init.headers, args: JSON.parse(init.body).params.arguments });
    return answer();
  }) as any;
  const config = { get: (k: string) => ENV[k] } as unknown as ConfigService;
  // An empty federation_workspace_map: the fresh org has no row for any app.
  const prisma = { federationWorkspaceMap: { findMany: jest.fn(async () => []) } } as any;
  const fedMap = new FederationWorkspaceMapService(prisma, config);
  const client = new EmailOpsClient(
    config,
    { exchangedToken: jest.fn().mockResolvedValue(null) } as unknown as BrigadeTokenSource,
    fedMap,
  );

  const emailLinks: any[] = [];
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ ws: FRESH_ORG }]),
    customer: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'cust-1',
        workspaceId: FRESH_ORG,
        contactId: 'contact-7',
        stage: RelationshipStage.LEAD,
      }),
    },
    customerActivity: { create: jest.fn(async ({ data }: any) => data) },
    customerEmailLink: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => {
        const r = { id: 'eml-1', messageId: null, createdAt: new Date(), ...data };
        emailLinks.push(r);
        return r;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = emailLinks.find((l) => l.id === where.id);
        if (!r) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
        return Object.assign(r, data);
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const i = emailLinks.findIndex((l) => l.id === where.id && l.messageId === null);
        if (i >= 0) emailLinks.splice(i, 1);
        return { count: i >= 0 ? 1 : 0 };
      }),
    },
  };
  const workspaces = {
    resolveAuthorized: jest.fn().mockResolvedValue(FRESH_ORG),
    assertAgentsNotPaused: jest.fn().mockResolvedValue(undefined),
    effectiveEntitlements: jest.fn(async (u: any) => entitlementsOf(u)),
    runForUser: jest.fn(async (_u: User, fn: any) => fn(tx)),
    runInWorkspace: jest.fn(async (_ws: string, _uc: any, fn: any) => fn(tx)),
  } as unknown as WorkspaceContextService;
  const dormant = { isConfigured: jest.fn().mockReturnValue(false) } as any;
  const svc = new CustomersService(
    workspaces,
    { getContact: jest.fn().mockResolvedValue(null) } as unknown as ContactOpsPort,
    dormant,
    dormant,
    client,
    dormant,
    dormant,
  );
  return { svc, calls, emailLinks, fedMap };
}

const DTO = {
  toAddress: 'jane@customer.example.com',
  subject: 'Welcome',
  body: 'Hi Jane',
  mode: 'draft' as const,
  idempotencyKey: 'k-1',
};

describe('compose_email for a freshly provisioned org (AUD-CR-4)', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });

  it('no map row, no seed env: addressed by the workspace id itself, and succeeds', async () => {
    const { svc, calls, emailLinks, fedMap } = setup(() =>
      rpc({
        structuredContent: {
          id: 'msg-1',
          thread_id: 't-1',
          status: 'pending_approval',
          mode: 'draft',
          external_source: 'customer-ops',
          external_ref: 'cust:cust-1:email:k-1',
        },
      }),
    );
    await fedMap.reload();
    expect(fedMap.resolveSync(FRESH_ORG, 'email-ops')).toBeNull();

    const out = await svc.sendEmailForUser(user, 'cust-1', DTO, FRESH_ORG);

    expect(calls).toHaveLength(1);
    // The Email-Ops contract: one lowercase uuid workspace id, the same in the
    // body, the addressing header (and the bearer claim in brigade-sts mode).
    expect(calls[0].args.workspace_id).toBe(FRESH_ORG);
    expect(calls[0].headers['X-Workspace-Id']).toBe(FRESH_ORG);
    expect(FRESH_ORG).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(out.message).toMatchObject({ id: 'msg-1', status: 'pending_approval' });
    expect(emailLinks).toHaveLength(1);
    expect(emailLinks[0]).toMatchObject({ messageId: 'msg-1', workspaceId: FRESH_ORG });
  });

  it.each([
    [
      'a tool error',
      () => rpc({ isError: true, content: [{ type: 'text', text: 'workspace not provisioned' }] }),
    ],
    ['HTTP 404', () => ({ ok: false, status: 404, text: async () => '' }) as Response],
    ['HTTP 422', () => ({ ok: false, status: 422, text: async () => '' }) as Response],
  ])(
    'Email-Ops refuses the new org (%s): plain 422, no retry advice, no orphan link',
    async (_l, answer) => {
      const { svc, emailLinks } = setup(answer);
      const err = await svc.sendEmailForUser(user, 'cust-1', DTO, FRESH_ORG).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(err.getResponse()).toMatchObject({
        code: 'email_not_accepted',
        message: EMAIL_NOT_ACCEPTED_MESSAGE,
      });
      expect(EMAIL_NOT_ACCEPTED_MESSAGE).not.toMatch(/retry|Email-Ops|Stalwart|link/i);
      expect(emailLinks).toEqual([]);
    },
  );

  it('Email-Ops unreachable: 503 that says retrying is safe, link kept for the idempotent retry', async () => {
    const { svc, emailLinks } = setup(() => {
      throw new Error('ECONNREFUSED');
    });
    const err = await svc.sendEmailForUser(user, 'cust-1', DTO, FRESH_ORG).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toBe(EMAIL_UNAVAILABLE_MESSAGE);
    expect(EMAIL_UNAVAILABLE_MESSAGE).not.toMatch(/Email-Ops|Stalwart|link is recorded/);
    expect(emailLinks).toHaveLength(1);
  });

  it.each([401, 403])(
    'Email-Ops rejects our credential (HTTP %s): 503 retry-safe, link kept, not "not set up"',
    async (status) => {
      const { svc, emailLinks } = setup(
        () => ({ ok: false, status, text: async () => '' }) as Response,
      );
      const err = await svc.sendEmailForUser(user, 'cust-1', DTO, FRESH_ORG).catch((e) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err.message).toBe(EMAIL_UNAVAILABLE_MESSAGE);
      expect(emailLinks).toHaveLength(1);
    },
  );

  it('the contract note exists and matches the classes this client uses', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('fs');
    const note: string = readFileSync(
      require('path').join(__dirname, '../../../docs/ops/email-ops-fresh-org-contract.md'),
      'utf8',
    );
    expect(note).toMatch(/HTTP 400\/404\/409\/422 \| refused/);
    expect(note).toMatch(/HTTP 401\/403 \(our credential rejected\) \| unavailable/);
    expect(note).toMatch(/unverified/i);
  });

  it('a concurrent refused attempt removed the staged row: the accepted message still gets its link', async () => {
    let removeStaged = () => undefined as void;
    const { svc, emailLinks } = setup(() => {
      // Between staging and the answer, a parallel attempt on the same key was
      // refused and removed the (message-less) staged row.
      removeStaged();
      return rpc({
        structuredContent: {
          id: 'msg-1',
          thread_id: 't-1',
          status: 'pending_approval',
          mode: 'draft',
          external_source: 'customer-ops',
          external_ref: 'x',
          created_at: '2026-11-21T00:00:00Z',
        },
      });
    });
    removeStaged = () => void emailLinks.splice(0, emailLinks.length);
    const out = await svc.sendEmailForUser(user, 'cust-1', DTO, FRESH_ORG);
    expect(out.message.id).toBe('msg-1');
    expect(emailLinks).toHaveLength(1);
    expect(emailLinks[0]).toMatchObject({
      messageId: 'msg-1',
      workspaceId: FRESH_ORG,
      externalRef: 'cust:cust-1:email:k-1',
    });
  });
});

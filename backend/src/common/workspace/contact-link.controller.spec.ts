import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { ContactLinkController, ConnectContactDto } from './contact-link.controller';
import { OrgTenantLookup } from '../../contact-ops/contact-ops-org-lookup.client';

/**
 * R3-2: the owner connection route is a contact-ops map writer too, so it is
 * fenced by the same-org rule: the Contact-Ops org lookup for THIS workspace's
 * org id must name exactly the tenant asked for, else 409 and nothing is
 * written or asked of the remote owner. Postgres and Contact-Ops are faked;
 * fictional ids only.
 */
const WS = '0190d000-7e57-7000-8000-00000000000a';
const TENANT = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER = 'bbbbbbbb-0000-4000-8000-00000000000b';
const owner = { id: 'local-ada', keycloakId: 'kc-ada' } as User;

function setup(answer: OrgTenantLookup) {
  const rows: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    workspace: { findUnique: jest.fn().mockResolvedValue({ id: WS, status: 'active' }) },
    membership: {
      findUnique: jest.fn().mockResolvedValue({ role: 'OWNER', status: 'ACTIVE' }),
    },
    federationWorkspaceMap: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(async ({ create }: any) => {
        rows.push(create);
        return create;
      }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    workspace: { findUnique: jest.fn().mockResolvedValue({ id: WS, status: 'active' }) },
    federationWorkspaceMap: { findUnique: jest.fn().mockResolvedValue(null) },
    withWorkspace: jest.fn(async (_ws: string, _k: string, fn: any) => fn(tx)),
  };
  const lookup = { lookupTenant: jest.fn(async () => answer) };
  const brigade = { exchangedToken: jest.fn().mockResolvedValue('reader-proof') };
  const config = {
    get: (k: string) => (k === 'CONTACT_OPS_BASE_URL' ? 'https://contacts.example.com' : undefined),
  } as unknown as ConfigService;
  const mapping = { reload: jest.fn().mockResolvedValue(undefined) };
  const membership = { assertOwner: jest.fn().mockResolvedValue(undefined) };
  const ctl = new ContactLinkController(
    membership as any,
    prisma as any,
    brigade as any,
    config,
    mapping as any,
    lookup as any,
  );
  return { ctl, rows, lookup, brigade, tx };
}

function dto(target = TENANT): ConnectContactDto {
  return Object.assign(new ConnectContactDto(), {
    target_workspace_id: target,
    contact_owner_token: 'transient-owner-token-not-real-000',
  });
}

describe('ContactLinkController contact-ops writes are fenced by the org lookup (R3-2)', () => {
  const origFetch = global.fetch;
  const origTenancy = process.env.CUSTOMER_OPS_TENANCY_ENABLED;
  let remote: jest.Mock;

  beforeEach(() => {
    process.env.CUSTOMER_OPS_TENANCY_ENABLED = 'true';
    remote = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          structuredContent: {
            tenant_id: TENANT,
            role: 'viewer',
            client_id: 'customer-ops',
            service_subject: 'svc-customer-ops',
          },
        },
      }),
    }));
    global.fetch = remote as any;
  });

  afterEach(() => {
    global.fetch = origFetch;
    if (origTenancy === undefined) delete process.env.CUSTOMER_OPS_TENANCY_ENABLED;
    else process.env.CUSTOMER_OPS_TENANCY_ENABLED = origTenancy;
  });

  it('writes the row when the lookup for this org names exactly the tenant asked', async () => {
    const { ctl, rows, lookup } = setup({ kind: 'tenant', tenantId: TENANT, tenantSlug: 'a' });
    await expect(ctl.connect(owner, WS, dto())).resolves.toMatchObject({
      target_workspace_id: TENANT,
    });
    expect(lookup.lookupTenant).toHaveBeenCalledWith(WS);
    expect(rows).toEqual([
      { localWorkspaceId: WS, targetApp: 'contact-ops', targetWorkspaceId: TENANT },
    ]);
  });

  it.each<[string, OrgTenantLookup]>([
    ['names another tenant', { kind: 'tenant', tenantId: OTHER, tenantSlug: 'b' }],
    ['has no tenant', { kind: 'no_tenant' }],
    ['answers for another org', { kind: 'mismatch', detail: 'answer names another org id' }],
    ['is unavailable', { kind: 'unavailable', detail: 'timeout' }],
  ])('409 and no write, no remote call, when the lookup %s', async (_label, answer) => {
    const { ctl, rows, brigade } = setup(answer);
    const err = await ctl.connect(owner, WS, dto()).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(rows).toEqual([]);
    expect(brigade.exchangedToken).not.toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();
  });

  it("a dormant lookup answers 409 'Contact-Ops link is not available yet'", async () => {
    const { ctl, rows } = setup({ kind: 'dormant' });
    const err = await ctl.connect(owner, WS, dto()).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe('Contact-Ops link is not available yet');
    expect(rows).toEqual([]);
    expect(remote).not.toHaveBeenCalled();
  });
});

import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, User } from '@prisma/client';
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

type Row = {
  localWorkspaceId: string;
  targetApp: string;
  targetWorkspaceId: string;
  conflictTenantId: string | null;
};

function setup(answer: OrgTenantLookup, pre: Row | null = null) {
  const rows: Array<Record<string, unknown>> = [];
  /** The one contact-ops row, as the fake database holds it. */
  let row: Row | null = pre ? { ...pre } : null;
  let afterRead: (() => void) | null = null;
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    workspace: { findUnique: jest.fn().mockResolvedValue({ id: WS, status: 'active' }) },
    membership: {
      findUnique: jest.fn().mockResolvedValue({ role: 'OWNER', status: 'ACTIVE' }),
    },
    federationWorkspaceMap: {
      findUnique: jest.fn(async () => {
        const read = row ? { ...row } : null;
        // A writer that lands between this read and the owner's write (R5-1).
        afterRead?.();
        afterRead = null;
        return read;
      }),
      // Postgres semantics: the unique (local_workspace_id, target_app) key.
      create: jest.fn(async ({ data }: any) => {
        if (row) throw uniqueViolation();
        rows.push(data);
        row = { conflictTenantId: null, ...data };
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit =
          !!row &&
          Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
        if (hit) Object.assign(row!, data);
        return { count: hit ? 1 : 0 };
      }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    workspace: { findUnique: jest.fn().mockResolvedValue({ id: WS, status: 'active' }) },
    federationWorkspaceMap: { findUnique: jest.fn(async () => (row ? { ...row } : null)) },
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
  return {
    ctl,
    rows,
    lookup,
    brigade,
    tx,
    mapping,
    row: () => row,
    /** Run `fn` right after the owner transaction's next read of the row. */
    interleave: (fn: (put: (r: Row) => void) => void) => {
      afterRead = () => fn((r) => (row = { ...r }));
    },
  };
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
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

  describe('R4-1: the owner repairs a row marked in conflict', () => {
    // R3-1 kept the old tenant (OTHER) and marked the row: the lookup said TENANT.
    const conflicted: Row = {
      localWorkspaceId: WS,
      targetApp: 'contact-ops',
      targetWorkspaceId: OTHER,
      conflictTenantId: TENANT,
    };

    it('lookup confirms the target -> row re-pointed to it, mark cleared, map reloaded (routable)', async () => {
      const { ctl, row, lookup, tx, mapping } = setup(
        { kind: 'tenant', tenantId: TENANT, tenantSlug: 'a' },
        conflicted,
      );
      await expect(ctl.connect(owner, WS, dto())).resolves.toMatchObject({
        target_workspace_id: TENANT,
      });
      expect(lookup.lookupTenant).toHaveBeenCalledWith(WS);
      expect(row()).toEqual({ ...conflicted, targetWorkspaceId: TENANT, conflictTenantId: null });
      // One write, inside the owner transaction, and audited.
      expect(tx.federationWorkspaceMap.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
      expect(mapping.reload).toHaveBeenCalled();
    });

    it.each<[string, OrgTenantLookup]>([
      ['names another tenant', { kind: 'tenant', tenantId: OTHER, tenantSlug: 'b' }],
      ['has no tenant', { kind: 'no_tenant' }],
      ['is unavailable', { kind: 'unavailable', detail: 'timeout' }],
    ])('lookup %s -> 409 and the row is unchanged', async (_label, answer) => {
      const { ctl, row, tx, brigade } = setup(answer, conflicted);
      const err = await ctl.connect(owner, WS, dto()).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(row()).toEqual(conflicted);
      expect(tx.federationWorkspaceMap.updateMany).not.toHaveBeenCalled();
      expect(tx.federationWorkspaceMap.create).not.toHaveBeenCalled();
      expect(brigade.exchangedToken).not.toHaveBeenCalled();
      expect(remote).not.toHaveBeenCalled();
    });

    it('a row that differs and is NOT conflicted keeps the 409 before any lookup (no silent re-point)', async () => {
      const plain: Row = { ...conflicted, conflictTenantId: null };
      const { ctl, row, lookup, tx } = setup(
        { kind: 'tenant', tenantId: TENANT, tenantSlug: 'a' },
        plain,
      );
      const err = await ctl.connect(owner, WS, dto()).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(lookup.lookupTenant).not.toHaveBeenCalled();
      expect(row()).toEqual(plain);
      expect(tx.federationWorkspaceMap.updateMany).not.toHaveBeenCalled();
      expect(tx.federationWorkspaceMap.create).not.toHaveBeenCalled();
    });
  });

  describe('R4-2: tenant ids are compared in canonical (lowercase) form', () => {
    it('an UPPERCASE lookup answer, owner grant and stored row all name the same tenant', async () => {
      remote.mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            structuredContent: {
              tenant_id: TENANT.toUpperCase(),
              role: 'viewer',
              client_id: 'customer-ops',
              service_subject: 'svc-customer-ops',
            },
          },
        }),
      }));
      const stored: Row = {
        localWorkspaceId: WS,
        targetApp: 'contact-ops',
        targetWorkspaceId: TENANT.toUpperCase(),
        conflictTenantId: null,
      };
      const { ctl, row } = setup(
        { kind: 'tenant', tenantId: TENANT.toUpperCase(), tenantSlug: 'a' },
        stored,
      );
      await expect(ctl.connect(owner, WS, dto(TENANT.toUpperCase()))).resolves.toMatchObject({
        target_workspace_id: TENANT,
      });
      expect(row()).toMatchObject({ targetWorkspaceId: TENANT, conflictTenantId: null });
    });
  });
});

describe('R5-1: the owner write is conditional on the row exactly as it checked', () => {
  const origFetch = global.fetch;
  const origTenancy = process.env.CUSTOMER_OPS_TENANCY_ENABLED;

  beforeEach(() => {
    process.env.CUSTOMER_OPS_TENANCY_ENABLED = 'true';
    global.fetch = jest.fn(async () => ({
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
    })) as any;
  });

  afterEach(() => {
    global.fetch = origFetch;
    if (origTenancy === undefined) delete process.env.CUSTOMER_OPS_TENANCY_ENABLED;
    else process.env.CUSTOMER_OPS_TENANCY_ENABLED = origTenancy;
  });

  it('provisioning inserts tenant B between the owner read and write -> B kept, owner 409', async () => {
    const { ctl, row, interleave, tx } = setup({
      kind: 'tenant',
      tenantId: TENANT,
      tenantSlug: 'a',
    });
    const B: Row = {
      localWorkspaceId: WS,
      targetApp: 'contact-ops',
      targetWorkspaceId: OTHER,
      conflictTenantId: null,
    };
    interleave((put) => put(B));
    const err = await ctl.connect(owner, WS, dto()).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(row()).toEqual(B);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('a conflicted row re-marked by another writer between read and write -> 409, unchanged', async () => {
    const conflicted: Row = {
      localWorkspaceId: WS,
      targetApp: 'contact-ops',
      targetWorkspaceId: OTHER,
      conflictTenantId: TENANT,
    };
    const { ctl, row, interleave } = setup(
      { kind: 'tenant', tenantId: TENANT, tenantSlug: 'a' },
      conflicted,
    );
    const THIRD = 'cccccccc-0000-4000-8000-00000000000c';
    interleave((put) => put({ ...conflicted, conflictTenantId: THIRD }));
    const err = await ctl.connect(owner, WS, dto()).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(row()).toEqual({ ...conflicted, conflictTenantId: THIRD });
  });

  it('takes the per-workspace contact-ops advisory lock BEFORE it reads the row', async () => {
    const { ctl, tx } = setup({ kind: 'tenant', tenantId: TENANT, tenantSlug: 'a' });
    await ctl.connect(owner, WS, dto());
    const lock = tx.$executeRaw.mock.calls.findIndex((c: any[]) =>
      String(c[0]?.join?.('') ?? c[0]).includes('pg_advisory_xact_lock'),
    );
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(tx.$executeRaw.mock.calls[lock].slice(1)).toEqual([`${WS}:contact-ops`]);
    expect(tx.$executeRaw.mock.invocationCallOrder[lock]).toBeLessThan(
      tx.federationWorkspaceMap.findUnique.mock.invocationCallOrder[0],
    );
  });
});

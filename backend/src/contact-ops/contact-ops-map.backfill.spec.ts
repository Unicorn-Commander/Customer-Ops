import { ContactOpsMapProvisioner } from './contact-ops-map.provisioner';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import {
  backfillExitCode,
  ContactOpsMapBackfillModule,
  formatBackfill,
  parseBackfillArgs,
} from './contact-ops-map.backfill';
import { OrgTenantLookup } from './contact-ops-org-lookup.client';

/**
 * C4: the idempotent re-run for workspaces that already exist (Kit runs it; the
 * backfill is Kit's, DESK-189). For each ACTIVE workspace with an Ops-Center org
 * id (the workspace id is the org id, contract D) and NO contact-ops map row:
 * ask the lookup, and write the row by the C1 rule. Dry-run by default.
 * Postgres and Contact-Ops are faked; fictional ids only.
 */
const ORG_A = '0190c000-7e57-7000-8000-00000000000a';
const ORG_B = '0190c000-7e57-7000-8000-00000000000b';
const ORG_MAPPED = '0190c000-7e57-7000-8000-00000000000c';
const ORG_SUSPENDED = '0190c000-7e57-7000-8000-00000000000d';
const ORG_DOWN = '0190c000-7e57-7000-8000-00000000000e';
const TENANT_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const TENANT_KEPT = 'cccccccc-0000-4000-8000-00000000000c';
// GATE-212: three rows that already exist before the run.
const ORG_OK = '0190c000-7e57-7000-8000-0000000000f1';
const ORG_CONFLICT = '0190c000-7e57-7000-8000-0000000000f2';
const ORG_UNCONFIRMED = '0190c000-7e57-7000-8000-0000000000f3';
const TENANT_OK = 'eeeeeeee-0000-4000-8000-0000000000f1';
const TENANT_ROW_F2 = 'eeeeeeee-0000-4000-8000-0000000000f2';
const TENANT_LOOKUP_F2 = 'ffffffff-0000-4000-8000-0000000000f2';
const TENANT_ROW_F3 = 'eeeeeeee-0000-4000-8000-0000000000f3';

/** The real conditional update the provisioner uses to set/clear the conflict mark. */
function conflictUpdateMany(rows: Array<Record<string, any>>) {
  return jest.fn(async ({ where, data }: any) => {
    const r = rows.find(
      (x) =>
        x.localWorkspaceId === where.localWorkspaceId &&
        x.targetApp === where.targetApp &&
        x.targetWorkspaceId === where.targetWorkspaceId,
    );
    if (!r || (r.conflictTenantId ?? null) === data.conflictTenantId) return { count: 0 };
    r.conflictTenantId = data.conflictTenantId;
    return { count: 1 };
  });
}

function setup() {
  const workspaces = [
    { id: ORG_A, status: 'active' },
    { id: ORG_B, status: 'active' },
    { id: ORG_MAPPED, status: 'active' },
    { id: ORG_SUSPENDED, status: 'suspended' },
    { id: ORG_DOWN, status: 'active' },
    { id: 'legacy-workspace', status: 'active' },
  ];
  const rows: Array<Record<string, any>> = [
    { localWorkspaceId: ORG_MAPPED, targetApp: 'contact-ops', targetWorkspaceId: TENANT_KEPT },
  ];
  const prisma = {
    // One transaction holding the R5-1 lock: the fake runs it on itself.
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    $executeRaw: jest.fn(async () => 1),
    workspace: {
      findMany: jest.fn(async ({ where }: any) =>
        workspaces.filter((w) => !where?.status || w.status === where.status),
      ),
    },
    federationWorkspaceMap: {
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((r) => !where?.targetApp || r.targetApp === where.targetApp),
      ),
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
      updateMany: conflictUpdateMany(rows),
    },
  };
  const answers: Record<string, OrgTenantLookup> = {
    [ORG_A]: { kind: 'tenant', tenantId: TENANT_A, tenantSlug: 'a' },
    [ORG_B]: { kind: 'no_tenant' },
    [ORG_MAPPED]: {
      kind: 'tenant',
      tenantId: 'dddddddd-0000-4000-8000-00000000000d',
      tenantSlug: 'x',
    },
    [ORG_DOWN]: { kind: 'unavailable', detail: 'http_503' },
  };
  const lookup = {
    isConfigured: jest.fn().mockReturnValue(true),
    lookupTenant: jest.fn(async (org: string) => answers[org] ?? { kind: 'no_tenant' }),
  };
  const fedMap = { reload: jest.fn().mockResolvedValue(undefined) };
  const svc = new ContactOpsMapProvisioner(prisma as any, lookup as any, fedMap as any);
  return { svc, rows, lookup, fedMap, prisma, answers };
}

describe('ContactOpsMapProvisioner.backfill (C4)', () => {
  it('DRY-RUN by default: asks for active, unmapped org workspaces (and verifies the mapped one), writes nothing', async () => {
    const { svc, rows, lookup } = setup();
    const report = await svc.backfill();
    expect(report.apply).toBe(false);
    expect(lookup.lookupTenant.mock.calls.map((c) => c[0]).sort()).toEqual(
      [ORG_A, ORG_B, ORG_DOWN, ORG_MAPPED].sort(),
    );
    expect(report.pairs).toEqual([{ orgId: ORG_A, tenantId: TENANT_A }]);
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        { orgId: ORG_B, reason: 'no_tenant' },
        { orgId: ORG_DOWN, reason: 'unavailable' },
      ]),
    );
    expect(report.written).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it('--apply writes the C1 row; a second run finds nothing left to do (idempotent)', async () => {
    const { svc, rows, lookup, fedMap } = setup();
    const first = await svc.backfill({ apply: true });
    expect(first.written).toBe(1);
    expect(rows).toContainEqual({
      localWorkspaceId: ORG_A,
      targetApp: 'contact-ops',
      targetWorkspaceId: TENANT_A,
    });
    // The pre-existing row keeps its tenant although the lookup disagrees; it is
    // only marked in conflict (unroutable, R3-1).
    expect(rows).toContainEqual({
      localWorkspaceId: ORG_MAPPED,
      targetApp: 'contact-ops',
      targetWorkspaceId: TENANT_KEPT,
      conflictTenantId: 'dddddddd-0000-4000-8000-00000000000d',
    });
    expect(fedMap.reload).toHaveBeenCalled();

    lookup.lookupTenant.mockClear();
    const second = await svc.backfill({ apply: true });
    expect(second.written).toBe(0);
    // ORG_A and ORG_MAPPED are only verified now, never written again.
    expect(lookup.lookupTenant.mock.calls.map((c) => c[0]).sort()).toEqual(
      [ORG_A, ORG_B, ORG_DOWN, ORG_MAPPED].sort(),
    );
    expect(second.existing.map((e) => [e.orgId, e.status])).toEqual(
      expect.arrayContaining([
        [ORG_A, 'confirmed'],
        [ORG_MAPPED, 'conflict'],
      ]),
    );
  });

  it('DORMANT: no lookup, nothing written, and the report says so', async () => {
    const { svc, lookup, rows } = setup();
    lookup.isConfigured.mockReturnValue(false);
    const report = await svc.backfill({ apply: true });
    expect(report.dormant).toBe(true);
    expect(lookup.lookupTenant).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });
});

describe('a conflict discovered during --apply counts (R3-6)', () => {
  it('a row another writer installed with ANOTHER tenant between check and write -> CONFLICT, exit 2', async () => {
    const { svc, rows, prisma, answers } = setup();
    // The only pre-existing row is confirmed, so the run would otherwise exit 0.
    answers[ORG_MAPPED] = { kind: 'tenant', tenantId: TENANT_KEPT, tenantSlug: 'kept' };
    const RACED = 'abababab-0000-4000-8000-00000000000a';
    prisma.federationWorkspaceMap.create.mockImplementation(async ({ data }: any) => {
      if (data.localWorkspaceId === ORG_A) {
        rows.push({ localWorkspaceId: ORG_A, targetApp: 'contact-ops', targetWorkspaceId: RACED });
        throw new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      rows.push({ ...data });
      return data;
    });
    const report = await svc.backfill({ apply: true });
    expect(report.written).toBe(0);
    expect(report.existing).toContainEqual({
      orgId: ORG_A,
      rowTenantId: RACED,
      status: 'conflict',
      lookupTenantId: TENANT_A,
    });
    expect(formatBackfill(report)).toContain(
      `${ORG_A} -> ${RACED}: CONFLICT (lookup answers ${TENANT_A})`,
    );
    expect(backfillExitCode(report)).toBe(2);
    // the raced row keeps its tenant and is marked unroutable (R3-1)
    expect(rows.find((r) => r.localWorkspaceId === ORG_A)).toMatchObject({
      targetWorkspaceId: RACED,
      conflictTenantId: TENANT_A,
    });
  });
});

/**
 * GATE-212 (point 3 of GATE-175): an EXISTING contact-ops row is re-checked on
 * every run, dry-run and --apply alike: confirmed / conflict / unconfirmed, for
 * a person to read. Nothing is deleted, overwritten or widened.
 */
function setupExisting() {
  const workspaces = [
    { id: ORG_OK, status: 'active' },
    { id: ORG_CONFLICT, status: 'active' },
    { id: ORG_UNCONFIRMED, status: 'active' },
  ];
  const rows: Array<Record<string, any>> = [
    { localWorkspaceId: ORG_OK, targetApp: 'contact-ops', targetWorkspaceId: TENANT_OK },
    { localWorkspaceId: ORG_CONFLICT, targetApp: 'contact-ops', targetWorkspaceId: TENANT_ROW_F2 },
    {
      localWorkspaceId: ORG_UNCONFIRMED,
      targetApp: 'contact-ops',
      targetWorkspaceId: TENANT_ROW_F3,
    },
  ];
  const before = JSON.stringify(rows);
  const prisma = {
    // One transaction holding the R5-1 lock: the fake runs it on itself.
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    $executeRaw: jest.fn(async () => 1),
    workspace: {
      findMany: jest.fn(async ({ where }: any) =>
        workspaces.filter((w) => !where?.status || w.status === where.status),
      ),
    },
    federationWorkspaceMap: {
      findMany: jest.fn(async ({ where }: any) =>
        rows
          .filter((r) => !where?.targetApp || r.targetApp === where.targetApp)
          .map((r) => ({ ...r })),
      ),
      // The R5-1 re-read under the lock.
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.localWorkspaceId_targetApp;
        const r = rows.find(
          (x) => x.localWorkspaceId === k.localWorkspaceId && x.targetApp === k.targetApp,
        );
        return r ? { ...r } : null;
      }),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      updateMany: conflictUpdateMany(rows),
    },
  };
  const answers: Record<string, OrgTenantLookup> = {
    [ORG_OK]: { kind: 'tenant', tenantId: TENANT_OK, tenantSlug: 'ok' },
    [ORG_CONFLICT]: { kind: 'tenant', tenantId: TENANT_LOOKUP_F2, tenantSlug: 'other' },
    [ORG_UNCONFIRMED]: { kind: 'no_tenant' },
  };
  const lookup = {
    isConfigured: jest.fn().mockReturnValue(true),
    lookupTenant: jest.fn(async (org: string) => answers[org] ?? { kind: 'no_tenant' }),
  };
  const fedMap = { reload: jest.fn().mockResolvedValue(undefined) };
  const svc = new ContactOpsMapProvisioner(prisma as any, lookup as any, fedMap as any);
  return { svc, rows, before, prisma, lookup, answers };
}

describe('ContactOpsMapProvisioner.backfill verifies EXISTING rows (GATE-212)', () => {
  const expected = [
    { orgId: ORG_OK, rowTenantId: TENANT_OK, status: 'confirmed', lookupTenantId: TENANT_OK },
    {
      orgId: ORG_CONFLICT,
      rowTenantId: TENANT_ROW_F2,
      status: 'conflict',
      lookupTenantId: TENANT_LOOKUP_F2,
    },
    {
      orgId: ORG_UNCONFIRMED,
      rowTenantId: TENANT_ROW_F3,
      status: 'unconfirmed',
      reason: 'no_tenant',
    },
  ];

  it.each([false, true])(
    'apply=%s: asks the lookup for each mapped org, reports each row, changes no tenant',
    async (apply) => {
      const { svc, rows, before, prisma, lookup } = setupExisting();
      const report = await svc.backfill({ apply });
      expect(lookup.lookupTenant.mock.calls.map((c) => c[0]).sort()).toEqual(
        [ORG_OK, ORG_CONFLICT, ORG_UNCONFIRMED].sort(),
      );
      expect(report.existing).toEqual(expected);
      expect(report.written).toBe(0);
      for (const m of ['create', 'update', 'upsert', 'delete', 'deleteMany']) {
        expect((prisma.federationWorkspaceMap as any)[m]).not.toHaveBeenCalled();
      }
      if (!apply) {
        // a dry run is byte-identical: not even the conflict mark is written
        expect(JSON.stringify(rows)).toBe(before);
        expect(prisma.federationWorkspaceMap.updateMany).not.toHaveBeenCalled();
      } else {
        // --apply only marks the conflicting row unroutable (R3-1); every tenant is kept
        const marked = JSON.parse(before);
        marked[1].conflictTenantId = TENANT_LOOKUP_F2;
        expect(rows).toEqual(marked);
      }
      expect(backfillExitCode(report)).toBe(2);
    },
  );

  it('--apply clears the conflict mark once the lookup confirms the row (R3-1)', async () => {
    const { svc, rows, answers } = setupExisting();
    await svc.backfill({ apply: true });
    expect(rows[1].conflictTenantId).toBe(TENANT_LOOKUP_F2);
    answers[ORG_CONFLICT] = { kind: 'tenant', tenantId: TENANT_ROW_F2, tenantSlug: 'b' };
    await svc.backfill({ apply: true });
    expect(rows[1]).toMatchObject({ targetWorkspaceId: TENANT_ROW_F2, conflictTenantId: null });
  });

  it('an unavailable lookup leaves the row unconfirmed (never confirmed)', async () => {
    const { svc, answers } = setupExisting();
    answers[ORG_OK] = { kind: 'unavailable', detail: 'http_503' };
    const report = await svc.backfill();
    expect(report.existing[0]).toEqual({
      orgId: ORG_OK,
      rowTenantId: TENANT_OK,
      status: 'unconfirmed',
      reason: 'unavailable',
    });
  });

  it('exit code 0 only when every existing row is confirmed; dormant stays 1', async () => {
    const { svc, answers, lookup } = setupExisting();
    answers[ORG_CONFLICT] = { kind: 'tenant', tenantId: TENANT_ROW_F2, tenantSlug: 'b' };
    answers[ORG_UNCONFIRMED] = { kind: 'tenant', tenantId: TENANT_ROW_F3, tenantSlug: 'c' };
    const report = await svc.backfill({ apply: true });
    expect(report.existing.every((e) => e.status === 'confirmed')).toBe(true);
    expect(backfillExitCode(report)).toBe(0);
    lookup.isConfigured.mockReturnValue(false);
    expect(backfillExitCode(await svc.backfill())).toBe(1);
  });

  it('prints the existing rows in their own section for a person', async () => {
    const { svc } = setupExisting();
    const out = formatBackfill(await svc.backfill());
    expect(out).toContain('EXISTING ROWS');
    expect(out).toContain(`${ORG_OK} -> ${TENANT_OK}: confirmed`);
    expect(out).toContain(
      `${ORG_CONFLICT} -> ${TENANT_ROW_F2}: CONFLICT (lookup answers ${TENANT_LOOKUP_F2})`,
    );
    expect(out).toContain(`${ORG_UNCONFIRMED} -> ${TENANT_ROW_F3}: UNCONFIRMED (no_tenant)`);
    expect(out).toMatch(/1 confirmed, 1 conflict, 1 unconfirmed/);
  });
});

describe('tenant ids are compared in canonical (lowercase) form (R4-2)', () => {
  const ORG_UP = '0190c000-7e57-7000-8000-0000000000f4';
  const TENANT_UP = 'abcdef00-0000-4000-8000-0000000000f4';

  function upper(rowTenant: string, lookupTenant: string) {
    const ctx = setup();
    ctx.rows.length = 0;
    ctx.rows.push({
      localWorkspaceId: ORG_UP,
      targetApp: 'contact-ops',
      targetWorkspaceId: rowTenant,
    });
    ctx.answers[ORG_UP] = { kind: 'tenant', tenantId: lookupTenant, tenantSlug: 'up' };
    return ctx;
  }

  it.each([
    ['an UPPERCASE row and a lowercase answer', TENANT_UP.toUpperCase(), TENANT_UP],
    ['a lowercase row and an UPPERCASE answer', TENANT_UP, TENANT_UP.toUpperCase()],
  ])('%s are the same tenant: confirmed, never marked in conflict', async (_l, row, answer) => {
    for (const apply of [false, true]) {
      const { svc, rows } = upper(row, answer);
      const report = await svc.backfill({ apply });
      expect(report.existing.find((e) => e.orgId === ORG_UP)).toMatchObject({
        status: 'confirmed',
      });
      expect(backfillExitCode(report)).toBe(0);
      expect(rows[0].conflictTenantId ?? null).toBeNull();
      expect(rows[0].targetWorkspaceId).toBe(row);
    }
    const { svc, rows } = upper(row, answer);
    await expect(svc.ensureForOrg(ORG_UP)).resolves.toEqual({
      kind: 'already',
      tenantId: TENANT_UP,
    });
    expect(rows[0].conflictTenantId ?? null).toBeNull();
  });

  it('an UPPERCASE answer is written as the canonical lowercase tenant id', async () => {
    const { svc, rows, answers } = setup();
    answers[ORG_A] = { kind: 'tenant', tenantId: TENANT_A.toUpperCase(), tenantSlug: 'a' };
    await expect(svc.ensureForOrg(ORG_A)).resolves.toEqual({ kind: 'written', tenantId: TENANT_A });
    expect(rows.find((r) => r.localWorkspaceId === ORG_A)?.targetWorkspaceId).toBe(TENANT_A);
  });
});

describe('the backfill command', () => {
  it('is a dry run unless --apply is given; refuses unknown flags', () => {
    expect(parseBackfillArgs([])).toEqual({ apply: false });
    expect(parseBackfillArgs(['--apply'])).toEqual({ apply: true });
    expect(() => parseBackfillArgs(['--force'])).toThrow(/--force/);
  });

  it('prints org id -> tenant id pairs and the skipped orgs', () => {
    const out = formatBackfill({
      apply: false,
      dormant: false,
      pairs: [{ orgId: ORG_A, tenantId: TENANT_A }],
      skipped: [{ orgId: ORG_B, reason: 'no_tenant' }],
      written: 0,
      existing: [],
    });
    expect(out).toContain(`${ORG_A} -> ${TENANT_A}`);
    expect(out).toContain(`${ORG_B} skipped: no_tenant`);
    expect(out).toMatch(/DRY RUN/);
  });
});

/**
 * R3-3: booting the command must not write. The federation map's boot
 * lifecycle (FEDERATION_WORKSPACE_MAP_SEED upserts, refresh timer) is not run
 * in command context, so a default dry run writes nothing even with a seed set.
 */
describe('the backfill command boots without seeding (R3-3)', () => {
  const env = { ...process.env };
  const origFetch = global.fetch;
  afterEach(() => {
    process.env = { ...env };
    global.fetch = origFetch;
  });

  it.each([
    ['dormant lookup', false],
    ['configured lookup', true],
  ])(
    '%s: a dry run with FEDERATION_WORKSPACE_MAP_SEED set writes nothing',
    async (_l, configured) => {
      process.env.FEDERATION_WORKSPACE_MAP_SEED = JSON.stringify({
        [ORG_MAPPED]: { 'contact-ops': TENANT_A, 'email-ops': 'seed-email' },
        [ORG_A]: { 'project-ops': 'seed-project' },
      });
      for (const k of [
        'CONTACT_OPS_BASE_URL',
        'CONTACT_OPS_LOOKUP_CLIENT_ID',
        'CONTACT_OPS_LOOKUP_CLIENT_SECRET',
        'CONTACT_OPS_LOOKUP_TOKEN_URL',
      ]) {
        if (configured)
          process.env[k] = k.endsWith('_URL') ? 'https://co.example.com/t' : 'fixture';
        else delete process.env[k];
      }
      global.fetch = jest.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () =>
          String(url).endsWith('/t')
            ? { access_token: 'lookup-cc', expires_in: 300 }
            : { ops_center_org_id: ORG_A, tenant_id: TENANT_A },
      })) as any;
      const rows = [
        { localWorkspaceId: ORG_MAPPED, targetApp: 'contact-ops', targetWorkspaceId: TENANT_KEPT },
      ];
      const before = JSON.stringify(rows);
      const writes = [
        'create',
        'createMany',
        'update',
        'updateMany',
        'upsert',
        'delete',
        'deleteMany',
      ];
      const fwm: Record<string, jest.Mock> = {
        findMany: jest.fn(async () => rows.map((r) => ({ ...r }))),
        findUnique: jest.fn(async () => null),
      };
      for (const m of writes) fwm[m] = jest.fn();
      const prisma = {
        federationWorkspaceMap: fwm,
        workspace: { findMany: jest.fn(async () => [{ id: ORG_A, status: 'active' }]) },
      };
      const mod = await Test.createTestingModule({ imports: [ContactOpsMapBackfillModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .compile();
      const app = mod.createNestApplication({ logger: false });
      await app.init();
      try {
        const report = await app.get(ContactOpsMapProvisioner).backfill({ apply: false });
        expect(report.apply).toBe(false);
        expect(report.dormant).toBe(!configured);
        for (const m of writes) expect(fwm[m]).not.toHaveBeenCalled();
        expect(JSON.stringify(rows)).toBe(before);
      } finally {
        await app.close();
      }
    },
  );
});

describe('R5-1: every provisioner write of the contact-ops row is serialized by the owner lock', () => {
  const ORG = '0190c000-7e57-7000-8000-0000000000a1';
  const ROW_TENANT = 'eeeeeeee-0000-4000-8000-0000000000a1';
  const LOOKUP_TENANT = 'ffffffff-0000-4000-8000-0000000000a1';

  /** Writes are accepted only inside a transaction, after the advisory lock for that org. */
  function lockedSetup(pre: Record<string, any> | null, tenantId: string) {
    let row = pre ? { ...pre } : null;
    const order: string[] = [];
    let locked = false;
    const refuse = (op: string) =>
      jest.fn(async () => {
        throw new Error(`unlocked ${op} of the contact-ops row`);
      });
    const tx = {
      $executeRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
        if (sql.join('').includes('pg_advisory_xact_lock') && values[0] === `${ORG}:contact-ops`) {
          locked = true;
          order.push('lock');
        }
        return 1;
      }),
      federationWorkspaceMap: {
        findUnique: jest.fn(async () => {
          order.push(locked ? 'read' : 'unlocked-read');
          return row ? { ...row } : null;
        }),
        create: jest.fn(async ({ data }: any) => {
          order.push(locked ? 'create' : 'unlocked-create');
          row = { conflictTenantId: null, ...data };
          return row;
        }),
        updateMany: jest.fn(async ({ data }: any) => {
          order.push(locked ? 'update' : 'unlocked-update');
          Object.assign(row!, data);
          return { count: 1 };
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: any) => {
        locked = false;
        try {
          return await fn(tx);
        } finally {
          locked = false;
        }
      }),
      workspace: { findMany: jest.fn(async () => [{ id: ORG, status: 'active' }]) },
      federationWorkspaceMap: {
        findMany: jest.fn(async () => (row ? [{ ...row }] : [])),
        findUnique: jest.fn(async () => (row ? { ...row } : null)),
        create: refuse('create'),
        updateMany: refuse('updateMany'),
        upsert: refuse('upsert'),
      },
    };
    const lookup = {
      isConfigured: () => true,
      lookupTenant: jest.fn(async () => ({ kind: 'tenant', tenantId, tenantSlug: 'a' })),
    };
    const fedMap = { reload: jest.fn().mockResolvedValue(undefined) };
    const svc = new ContactOpsMapProvisioner(prisma as any, lookup as any, fedMap as any);
    return { svc, order, row: () => row };
  }

  it('provisioning insert: lock, then read, then insert (one transaction)', async () => {
    const { svc, order, row } = lockedSetup(null, LOOKUP_TENANT);
    await expect(svc.ensureForOrg(ORG)).resolves.toEqual({
      kind: 'written',
      tenantId: LOOKUP_TENANT,
    });
    expect(order).toEqual(['lock', 'read', 'create']);
    expect(row()).toMatchObject({ targetWorkspaceId: LOOKUP_TENANT });
  });

  it('conflict mark (provisioning replay): lock, then read, then the conditional mark', async () => {
    const pre = {
      localWorkspaceId: ORG,
      targetApp: 'contact-ops',
      targetWorkspaceId: ROW_TENANT,
      conflictTenantId: null,
    };
    const { svc, order, row } = lockedSetup(pre, LOOKUP_TENANT);
    await expect(svc.ensureForOrg(ORG)).resolves.toMatchObject({ kind: 'conflict' });
    expect(order).toEqual(['lock', 'read', 'update']);
    expect(row()).toMatchObject({ targetWorkspaceId: ROW_TENANT, conflictTenantId: LOOKUP_TENANT });
  });

  it('backfill --apply verifying an existing row: lock, then read, then the conditional mark', async () => {
    const pre = {
      localWorkspaceId: ORG,
      targetApp: 'contact-ops',
      targetWorkspaceId: ROW_TENANT,
      conflictTenantId: null,
    };
    const { svc, order } = lockedSetup(pre, LOOKUP_TENANT);
    const report = await svc.backfill({ apply: true });
    expect(report.existing).toEqual([expect.objectContaining({ status: 'conflict' })]);
    expect(order).toEqual(['lock', 'read', 'update']);
  });
});

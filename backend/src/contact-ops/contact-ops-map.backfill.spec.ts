import { ContactOpsMapProvisioner } from './contact-ops-map.provisioner';
import { backfillExitCode, formatBackfill, parseBackfillArgs } from './contact-ops-map.backfill';
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

function setup() {
  const workspaces = [
    { id: ORG_A, status: 'active' },
    { id: ORG_B, status: 'active' },
    { id: ORG_MAPPED, status: 'active' },
    { id: ORG_SUSPENDED, status: 'suspended' },
    { id: ORG_DOWN, status: 'active' },
    { id: 'legacy-workspace', status: 'active' },
  ];
  const rows = [
    { localWorkspaceId: ORG_MAPPED, targetApp: 'contact-ops', targetWorkspaceId: TENANT_KEPT },
  ];
  const prisma = {
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
    [ORG_DOWN]: { kind: 'unavailable', detail: 'HTTP 503' },
  };
  const lookup = {
    isConfigured: jest.fn().mockReturnValue(true),
    lookupTenant: jest.fn(async (org: string) => answers[org] ?? { kind: 'no_tenant' }),
  };
  const fedMap = { reload: jest.fn().mockResolvedValue(undefined) };
  const svc = new ContactOpsMapProvisioner(prisma as any, lookup as any, fedMap as any);
  return { svc, rows, lookup, fedMap };
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
    // The pre-existing row is never touched, even though the lookup disagrees.
    expect(rows).toContainEqual({
      localWorkspaceId: ORG_MAPPED,
      targetApp: 'contact-ops',
      targetWorkspaceId: TENANT_KEPT,
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
  const rows = [
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
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      updateMany: jest.fn(),
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
    'apply=%s: asks the lookup for each mapped org, reports each row, modifies none',
    async (apply) => {
      const { svc, rows, before, prisma, lookup } = setupExisting();
      const report = await svc.backfill({ apply });
      expect(lookup.lookupTenant.mock.calls.map((c) => c[0]).sort()).toEqual(
        [ORG_OK, ORG_CONFLICT, ORG_UNCONFIRMED].sort(),
      );
      expect(report.existing).toEqual(expected);
      expect(report.written).toBe(0);
      // byte-identical, and no write path was even attempted
      expect(JSON.stringify(rows)).toBe(before);
      for (const m of ['create', 'update', 'upsert', 'delete', 'deleteMany', 'updateMany']) {
        expect((prisma.federationWorkspaceMap as any)[m]).not.toHaveBeenCalled();
      }
      expect(backfillExitCode(report)).toBe(2);
    },
  );

  it('an unavailable lookup leaves the row unconfirmed (never confirmed)', async () => {
    const { svc, answers } = setupExisting();
    answers[ORG_OK] = { kind: 'unavailable', detail: 'HTTP 503' };
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

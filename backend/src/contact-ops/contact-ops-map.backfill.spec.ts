import { ContactOpsMapProvisioner } from './contact-ops-map.provisioner';
import { formatBackfill, parseBackfillArgs } from './contact-ops-map.backfill';
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
  it('DRY-RUN by default: asks only for active, unmapped org workspaces and writes nothing', async () => {
    const { svc, rows, lookup } = setup();
    const report = await svc.backfill();
    expect(report.apply).toBe(false);
    expect(lookup.lookupTenant.mock.calls.map((c) => c[0]).sort()).toEqual(
      [ORG_A, ORG_B, ORG_DOWN].sort(),
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
    expect(lookup.lookupTenant.mock.calls.map((c) => c[0]).sort()).toEqual(
      [ORG_B, ORG_DOWN].sort(),
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
    });
    expect(out).toContain(`${ORG_A} -> ${TENANT_A}`);
    expect(out).toContain(`${ORG_B} skipped: no_tenant`);
    expect(out).toMatch(/DRY RUN/);
  });
});

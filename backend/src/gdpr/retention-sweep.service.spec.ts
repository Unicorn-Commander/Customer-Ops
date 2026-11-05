import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetentionSweepService } from './retention-sweep.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { GdprService } from './gdpr.service';

/**
 * RetentionSweepService — the DORMANT-record retention sweep. The load-bearing
 * contract: it PURGES NOTHING until an operator opts in on all three axes —
 *   (1) CUSTOMER_OPS_RETENTION_SWEEP_ENABLED on,
 *   (2) the workspace has a positive retention window, and
 *   (3) CUSTOMER_OPS_RETENTION_SWEEP_SOURCES names at least one prefix.
 * When enabled, only dormant source-scoped LEAD rows are eligible, and dry-run
 * returns counts without exposing customer identity or invoking erasure.
 */

const WS = '0190a000-7e57-7000-8000-00000000c007';
const DAY_MS = 86_400_000;

type CustomerFixture = {
  id: string;
  source: string | null;
  stage: 'LEAD' | 'PROSPECT' | 'CUSTOMER';
  updatedAt: Date;
};

function makeConfig(enabled: boolean, sources?: string): ConfigService {
  return {
    get: (k: string) => {
      if (k === 'CUSTOMER_OPS_RETENTION_SWEEP_ENABLED') return enabled ? 'true' : 'false';
      if (k === 'CUSTOMER_OPS_RETENTION_SWEEP_SOURCES') return sources;
      return undefined;
    },
  } as unknown as ConfigService;
}

function makePrisma(eligible: Array<{ id: string; retentionDays: number | null }>): PrismaService {
  return {
    workspace: {
      findMany: jest.fn().mockResolvedValue(eligible),
      findUnique: jest.fn(async ({ where }: any) => eligible.find((w) => w.id === where.id) ?? null),
    },
  } as unknown as PrismaService;
}

/** Apply the measured query shape so the fixture proves all three predicates. */
function makeWorkspaces(rows: CustomerFixture[]): WorkspaceContextService {
  const findMany = jest.fn(async ({ where, select }: any) => {
    const matches = rows.filter(
      (row) =>
        row.updatedAt < where.updatedAt.lt &&
        row.stage === where.stage &&
        where.OR.some((condition: any) =>
          row.source?.startsWith(condition.source.startsWith),
        ),
    );
    return matches.map((row) =>
      select.id ? { id: row.id, source: row.source } : { source: row.source },
    );
  });
  const tx = { customer: { findMany } };
  return {
    runInWorkspace: jest.fn(async (_ws: string, _uid: any, fn: (t: any) => any) => fn(tx)),
  } as unknown as WorkspaceContextService;
}

function makeGdpr(): { svc: GdprService; erased: any[] } {
  const erased: any[] = [];
  const svc = {
    eraseCustomerCore: jest.fn(
      async (
        ws: string,
        id: string,
        actor: any,
        reason: string,
        sourcePrefix?: string,
      ) => {
        erased.push({ ws, id, actor, reason, sourcePrefix });
        return { erased: true, customerId: id, removed: {}, graphNodesDeleted: 0 };
      },
    ),
  } as unknown as GdprService;
  return { svc, erased };
}

function dormant(over: Partial<CustomerFixture> = {}): CustomerFixture {
  return {
    id: 'cust-fictional-old-lead',
    source: 'talking-website-example',
    stage: 'LEAD',
    updatedAt: new Date(Date.now() - 31 * DAY_MS),
    ...over,
  };
}

describe('RetentionSweepService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('PURGES NOTHING when the flag is OFF (no prisma read, no erase)', async () => {
    const prisma = makePrisma([{ id: WS, retentionDays: 30 }]);
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(
      makeConfig(false),
      prisma,
      makeWorkspaces([dormant()]),
      gdpr.svc,
    );

    const res = await svc.sweepOnce();

    expect(res).toEqual({ enabled: false, workspacesScanned: 0, customersPurged: 0 });
    expect(prisma.workspace.findMany).not.toHaveBeenCalled();
    expect(gdpr.erased).toHaveLength(0);
  });

  it('fails closed for an empty scope, purges nothing, and warns once per pass', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const prisma = makePrisma([{ id: WS, retentionDays: 30 }]);
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(
      makeConfig(true),
      prisma,
      makeWorkspaces([dormant()]),
      gdpr.svc,
    );

    const res = await svc.sweepOnce();

    expect(res).toEqual({ enabled: true, workspacesScanned: 0, customersPurged: 0 });
    expect(prisma.workspace.findMany).not.toHaveBeenCalled();
    expect(gdpr.erased).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('retention sweep has no source scope; nothing purged');
  });

  it('purges a matching dormant LEAD and keeps the retention audit reason', async () => {
    const prisma = makePrisma([{ id: WS, retentionDays: 30 }]);
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(
      makeConfig(true, 'talking-website-'),
      prisma,
      makeWorkspaces([dormant({ id: 'cust-fictional-matching-lead' })]),
      gdpr.svc,
    );

    const res = await svc.sweepOnce();

    expect(res).toEqual({ enabled: true, workspacesScanned: 1, customersPurged: 1 });
    expect(gdpr.erased).toEqual([
      {
        ws: WS,
        id: 'cust-fictional-matching-lead',
        actor: null,
        reason: 'retention',
        sourcePrefix: 'talking-website-',
      },
    ]);
  });

  it('does not purge a matching dormant PROSPECT or CUSTOMER', async () => {
    const prisma = makePrisma([{ id: WS, retentionDays: 30 }]);
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(
      makeConfig(true, 'talking-website-'),
      prisma,
      makeWorkspaces([
        dormant({ id: 'cust-fictional-prospect', stage: 'PROSPECT' }),
        dormant({ id: 'cust-fictional-customer', stage: 'CUSTOMER' }),
      ]),
      gdpr.svc,
    );

    await svc.sweepOnce();

    expect(gdpr.erased).toHaveLength(0);
  });

  it('does not purge a non-matching dormant LEAD', async () => {
    const prisma = makePrisma([{ id: WS, retentionDays: 30 }]);
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(
      makeConfig(true, 'talking-website-'),
      prisma,
      makeWorkspaces([dormant({ source: 'm365-sent-example' })]),
      gdpr.svc,
    );

    await svc.sweepOnce();

    expect(gdpr.erased).toHaveLength(0);
  });

  it('does not purge a matching recent LEAD', async () => {
    const prisma = makePrisma([{ id: WS, retentionDays: 30 }]);
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(
      makeConfig(true, 'talking-website-'),
      prisma,
      makeWorkspaces([
        dormant({ updatedAt: new Date(Date.now() - 1 * DAY_MS) }),
      ]),
      gdpr.svc,
    );

    await svc.sweepOnce();

    expect(gdpr.erased).toHaveLength(0);
  });

  it('applies updatedAt, stage, and OR source-prefix predicates inside RLS', async () => {
    const prisma = makePrisma([{ id: WS, retentionDays: 10 }]);
    const workspaces = makeWorkspaces([dormant()]);
    const svc = new RetentionSweepService(
      makeConfig(true, 'talking-website-, assistant-'),
      prisma,
      workspaces,
      makeGdpr().svc,
    );

    await svc.sweepOnce();

    const call = (workspaces.runInWorkspace as jest.Mock).mock.calls[0];
    const captureTx = { customer: { findMany: jest.fn().mockResolvedValue([]) } };
    await call[2](captureTx);
    const query = captureTx.customer.findMany.mock.calls[0][0];
    expect(query.where.updatedAt.lt).toBeInstanceOf(Date);
    expect(Math.round((Date.now() - query.where.updatedAt.lt.getTime()) / DAY_MS)).toBe(10);
    expect(query.where.stage).toBe('LEAD');
    expect(query.where.OR).toEqual([
      { source: { startsWith: 'talking-website-' } },
      { source: { startsWith: 'assistant-' } },
    ]);
  });

  it('dry-run returns counts only, selects no ids, and erases nothing', async () => {
    const prisma = makePrisma([{ id: WS, retentionDays: 30 }]);
    const workspaces = makeWorkspaces([
      dormant({ id: 'cust-fictional-dry-run' }),
      dormant({ id: 'cust-fictional-prospect', stage: 'PROSPECT' }),
    ]);
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(
      makeConfig(true, 'talking-website-'),
      prisma,
      workspaces,
      gdpr.svc,
    );

    const res = await svc.sweepOnce({ dryRun: true });

    expect(res).toEqual({
      eligible: 1,
      wouldPurge: 1,
      bySource: { 'talking-website-': 1 },
    });
    expect(gdpr.erased).toHaveLength(0);
    const query = (workspaces.runInWorkspace as jest.Mock).mock.calls[0][2];
    const captureTx = { customer: { findMany: jest.fn().mockResolvedValue([]) } };
    await query(captureTx);
    expect(captureTx.customer.findMany.mock.calls[0][0].select).toEqual({ source: true });
  });

  it('dry-run attributes several source prefixes without exposing source values', async () => {
    const prisma = makePrisma([{ id: WS, retentionDays: 30 }]);
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(
      makeConfig(true, 'talking-website-, assistant-'),
      prisma,
      makeWorkspaces([
        dormant({ source: 'talking-website-example' }),
        dormant({ source: 'assistant-example' }),
        dormant({ source: 'm365-sent-example' }),
      ]),
      gdpr.svc,
    );

    const res = await svc.sweepOnce({ dryRun: true });

    expect(res).toEqual({
      eligible: 2,
      wouldPurge: 2,
      bySource: { 'talking-website-': 1, 'assistant-': 1 },
    });
    expect(JSON.stringify(res)).not.toContain('example');
    expect(gdpr.erased).toHaveLength(0);
  });

  it('owner-triggered dry-run applies the same source scope', async () => {
    const prisma = makePrisma([{ id: WS, retentionDays: 30 }]);
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(
      makeConfig(true, 'talking-website-'),
      prisma,
      makeWorkspaces([dormant()]),
      gdpr.svc,
    );

    const res = await svc.sweepWorkspace(WS, undefined, { dryRun: true });

    expect(res).toEqual({
      eligible: 1,
      wouldPurge: 1,
      bySource: { 'talking-website-': 1 },
    });
    expect(gdpr.erased).toHaveLength(0);
  });

  it('sweepWorkspace is a no-op (0) when the flag is off', async () => {
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(
      makeConfig(false, 'talking-website-'),
      makePrisma([{ id: WS, retentionDays: 30 }]),
      makeWorkspaces([dormant()]),
      gdpr.svc,
    );
    expect(await svc.sweepWorkspace(WS)).toBe(0);
    expect(gdpr.erased).toHaveLength(0);
  });

  it('sweepWorkspace skips a workspace with no retention window', async () => {
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(
      makeConfig(true, 'talking-website-'),
      makePrisma([{ id: WS, retentionDays: null }]),
      makeWorkspaces([dormant()]),
      gdpr.svc,
    );
    expect(await svc.sweepWorkspace(WS)).toBe(0);
    expect(gdpr.erased).toHaveLength(0);
  });

  it('onModuleInit starts no timer when disabled', () => {
    const svc = new RetentionSweepService(
      makeConfig(false),
      makePrisma([]),
      makeWorkspaces([]),
      makeGdpr().svc,
    );
    svc.onModuleInit();
    // No timer to clear — destroy is safe + idempotent.
    expect(() => svc.onModuleDestroy()).not.toThrow();
  });
});

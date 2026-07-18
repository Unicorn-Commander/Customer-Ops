import { ConfigService } from '@nestjs/config';
import { RetentionSweepService } from './retention-sweep.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { GdprService } from './gdpr.service';

/**
 * RetentionSweepService — the DORMANT-record retention sweep. The load-bearing
 * contract: it PURGES NOTHING until an operator opts in on BOTH axes —
 *   (1) CUSTOMER_OPS_RETENTION_SWEEP_ENABLED on, AND
 *   (2) the workspace has a positive retention window.
 * When enabled, it erases dormant customers through the shared GdprService path.
 */

const WS = '0190a000-7e57-7000-8000-00000000c007';

function makeConfig(enabled: boolean): ConfigService {
  return {
    get: (k: string) =>
      k === 'CUSTOMER_OPS_RETENTION_SWEEP_ENABLED' ? (enabled ? 'true' : 'false') : undefined,
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

/** runInWorkspace hands back the dormant customer ids the sweep will erase. */
function makeWorkspaces(dormantIds: string[]): WorkspaceContextService {
  const tx = { customer: { findMany: jest.fn().mockResolvedValue(dormantIds.map((id) => ({ id }))) } };
  return {
    runInWorkspace: jest.fn(async (_ws: string, _uid: any, fn: (t: any) => any) => fn(tx)),
  } as unknown as WorkspaceContextService;
}

function makeGdpr(): { svc: GdprService; erased: any[] } {
  const erased: any[] = [];
  const svc = {
    eraseCustomerCore: jest.fn(async (ws: string, id: string, actor: any, reason: string) => {
      erased.push({ ws, id, actor, reason });
      return { erased: true, customerId: id, removed: {}, graphNodesDeleted: 0 };
    }),
  } as unknown as GdprService;
  return { svc, erased };
}

describe('RetentionSweepService', () => {
  it('PURGES NOTHING when the flag is OFF (no prisma read, no erase)', async () => {
    const prisma = makePrisma([{ id: WS, retentionDays: 30 }]);
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(makeConfig(false), prisma, makeWorkspaces(['c1']), gdpr.svc);

    const res = await svc.sweepOnce();

    expect(res).toEqual({ enabled: false, workspacesScanned: 0, customersPurged: 0 });
    expect(prisma.workspace.findMany).not.toHaveBeenCalled();
    expect(gdpr.erased).toHaveLength(0);
  });

  it('sweepOnce erases dormant customers per eligible workspace when enabled', async () => {
    const prisma = makePrisma([{ id: WS, retentionDays: 30 }]);
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(
      makeConfig(true),
      prisma,
      makeWorkspaces(['c1', 'c2']),
      gdpr.svc,
    );

    const res = await svc.sweepOnce();

    expect(res.enabled).toBe(true);
    expect(res.workspacesScanned).toBe(1);
    expect(res.customersPurged).toBe(2);
    expect(gdpr.erased.map((e) => e.id)).toEqual(['c1', 'c2']);
    // Erased as a system job with the retention reason (→ DELETE audit tag).
    expect(gdpr.erased[0]).toMatchObject({ ws: WS, actor: null, reason: 'retention' });
  });

  it('applies the retention window as an updatedAt < cutoff filter', async () => {
    const prisma = makePrisma([{ id: WS, retentionDays: 10 }]);
    const workspaces = makeWorkspaces(['c1']);
    const svc = new RetentionSweepService(makeConfig(true), prisma, workspaces, makeGdpr().svc);

    await svc.sweepOnce();

    // The GUC-scoped read filters on updatedAt < a cutoff ~10 days ago.
    const tx = (workspaces.runInWorkspace as jest.Mock).mock.results[0].value;
    // runInWorkspace already invoked fn(tx); assert the query shape via the fn call.
    const call = (workspaces.runInWorkspace as jest.Mock).mock.calls[0];
    const fn = call[2];
    const captureTx = { customer: { findMany: jest.fn().mockResolvedValue([]) } };
    await fn(captureTx);
    const where = captureTx.customer.findMany.mock.calls[0][0].where;
    expect(where.updatedAt.lt).toBeInstanceOf(Date);
    const ageDays = (Date.now() - where.updatedAt.lt.getTime()) / 86_400_000;
    expect(Math.round(ageDays)).toBe(10);
    void tx;
  });

  it('sweepWorkspace is a no-op (0) when the flag is off', async () => {
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(
      makeConfig(false),
      makePrisma([{ id: WS, retentionDays: 30 }]),
      makeWorkspaces(['c1']),
      gdpr.svc,
    );
    expect(await svc.sweepWorkspace(WS)).toBe(0);
    expect(gdpr.erased).toHaveLength(0);
  });

  it('sweepWorkspace skips a workspace with no retention window', async () => {
    const gdpr = makeGdpr();
    const svc = new RetentionSweepService(
      makeConfig(true),
      makePrisma([{ id: WS, retentionDays: null }]),
      makeWorkspaces(['c1']),
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

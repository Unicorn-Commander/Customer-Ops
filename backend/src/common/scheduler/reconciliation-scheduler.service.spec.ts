import { ConfigService } from '@nestjs/config';
import { ReconciliationSchedulerService } from './reconciliation-scheduler.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LeadIntakeService } from '../../lead-intake/lead-intake.service';
import { CustomersService } from '../../customers/customers.service';
import { GraphIngestService } from '../../graph/graph-ingest.service';

function build(
  env: Record<string, string | undefined>,
  overrides: {
    workspaces?: Array<{ id: string }>;
    leads?: Partial<LeadIntakeService>;
    customers?: Partial<CustomersService>;
    graph?: Partial<GraphIngestService>;
  } = {},
) {
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  const prisma = {
    workspace: { findMany: jest.fn().mockResolvedValue(overrides.workspaces ?? []) },
  } as unknown as PrismaService;
  const leads = { reconcilePendingSystem: jest.fn(), ...overrides.leads } as unknown as LeadIntakeService;
  const customers = {
    refreshInvoiceCachesSystem: jest.fn(),
    ...overrides.customers,
  } as unknown as CustomersService;
  const graph = { backfillWorkspace: jest.fn(), ...overrides.graph } as unknown as GraphIngestService;
  return {
    svc: new ReconciliationSchedulerService(config, prisma, leads, customers, graph),
    prisma,
    leads,
    customers,
    graph,
  };
}

describe('ReconciliationSchedulerService', () => {
  it('is disabled by default (starts no timers)', () => {
    const { svc } = build({});
    svc.onModuleInit();
    expect((svc as any).timers.length).toBe(0);
  });

  it('respects an explicit enable flag', () => {
    const { svc } = build({ RECONCILE_SCHEDULER_ENABLED: 'true' });
    expect((svc as any).enabled).toBe(true);
  });

  it('treats a per-job cadence of 0 as disabled', () => {
    const { svc } = build({
      RECONCILE_SCHEDULER_ENABLED: 'true',
      RECONCILE_LEADS_INTERVAL_MS: '0',
      REFRESH_INVOICES_INTERVAL_MS: '0',
      REPAIR_GRAPH_INTERVAL_MS: '0',
    });
    svc.onModuleInit();
    // All three jobs disabled → no timers registered.
    expect((svc as any).timers.length).toBe(0);
  });

  it('single-flight: skips a tick while the prior run of the same job is in flight', async () => {
    const { svc } = build({});
    let running = 0;
    let maxConcurrent = 0;
    const job = jest.fn(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    });

    // Fire two guards concurrently; the 2nd must be skipped.
    await Promise.all([(svc as any).guard('j', job), (svc as any).guard('j', job)]);
    expect(job).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1);
  });

  it('runs a job for every workspace and isolates a per-workspace failure', async () => {
    const reconcile = jest
      .fn()
      .mockResolvedValueOnce({ scanned: 2, resolved: 1, stillOpen: 1, provisionalUpgraded: 0 })
      .mockRejectedValueOnce(new Error('boom')) // ws-2 fails
      .mockResolvedValueOnce({ scanned: 1, resolved: 1, stillOpen: 0, provisionalUpgraded: 0 });
    const { svc, leads } = build(
      {},
      {
        workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }, { id: 'ws-3' }],
        leads: { reconcilePendingSystem: reconcile } as any,
      },
    );

    await (svc as any).runLeadReconciliation();
    // All three attempted; ws-2's throw did not abort ws-3.
    expect(leads.reconcilePendingSystem).toHaveBeenCalledTimes(3);
  });
});

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { LeadIntakeService } from '../../lead-intake/lead-intake.service';
import { CustomersService } from '../../customers/customers.service';
import { GraphIngestService } from '../../graph/graph-ingest.service';

/**
 * ReconciliationSchedulerService — the background maintenance loop.
 *
 * The reconciliation / invoice-refresh / graph-repair jobs previously ran ONLY
 * when someone POSTed the matching endpoint. That means a workspace whose
 * operator never clicks "reconcile" accumulates PENDING leads, stale invoice
 * statuses, and a drifting graph indefinitely. This service runs those same
 * jobs on an interval, per workspace, with the SYSTEM actor.
 *
 * TENANCY (binding): each job is invoked through the service's `*System`
 * entrypoint, which binds the workspace explicitly via runInWorkspace (the RLS
 * GUC chokepoint). The system actor has no membership — correct, because there
 * is no user; the workspace itself is the tenancy boundary, enforced by RLS.
 * Federation uses the app-to-app Brigade token (already the federation credential
 * for every seam), never a user token.
 *
 * SAFETY:
 *   - FLAG-GATED, OFF by default (RECONCILE_SCHEDULER_ENABLED). A deploy opts in.
 *   - Each job's cadence is env-configurable; a cadence of 0 disables THAT job,
 *     so an operator can turn on just graph-repair, etc.
 *   - SINGLE-FLIGHT per job: a tick that starts while the prior run is still
 *     going is skipped (a slow federation pass never stacks overlapping runs).
 *   - Per-workspace error isolation: one workspace failing never aborts the pass
 *     or the loop. Every tick logs a one-line summary.
 *   - Startup JITTER staggers the jobs so N replicas / a fresh boot don't all
 *     fire at t=0.
 *
 * Deliberately dependency-free (setInterval, not @nestjs/schedule) — the cadence
 * is coarse (minutes), so a cron parser would be over-engineering.
 */
@Injectable()
export class ReconciliationSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationSchedulerService.name);

  private readonly timers: NodeJS.Timeout[] = [];
  /** Single-flight guards, keyed by job name. */
  private readonly running = new Set<string>();
  private stopped = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly leads: LeadIntakeService,
    private readonly customers: CustomersService,
    private readonly graph: GraphIngestService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'Reconciliation scheduler DISABLED (set RECONCILE_SCHEDULER_ENABLED=true to run ' +
          'lead-reconciliation / invoice-refresh / graph-repair on an interval).',
      );
      return;
    }

    const leadMs = this.intervalMs('RECONCILE_LEADS_INTERVAL_MS', 5 * 60_000);
    const invoiceMs = this.intervalMs('REFRESH_INVOICES_INTERVAL_MS', 15 * 60_000);
    const graphMs = this.intervalMs('REPAIR_GRAPH_INTERVAL_MS', 60 * 60_000);

    this.schedule('lead-reconciliation', leadMs, () => this.runLeadReconciliation());
    this.schedule('invoice-refresh', invoiceMs, () => this.runInvoiceRefresh());
    this.schedule('graph-repair', graphMs, () => this.runGraphRepair());

    this.logger.log(
      `Reconciliation scheduler ENABLED — leads=${describe(leadMs)} ` +
        `invoices=${describe(invoiceMs)} graph=${describe(graphMs)}.`,
    );
  }

  onModuleDestroy(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  // ── job registration ──

  /** Register a repeating job (cadence 0 == disabled) with a small startup jitter. */
  private schedule(name: string, intervalMs: number, job: () => Promise<void>): void {
    if (intervalMs <= 0) {
      this.logger.log(`Reconciliation scheduler: '${name}' cadence is 0 — job disabled.`);
      return;
    }
    // Stagger initial fire across [0, min(interval, 60s)) so jobs don't all start
    // at once and N replicas don't collide on the same instant.
    const jitter = Math.floor(Math.random() * Math.min(intervalMs, 60_000));
    const start = setTimeout(() => {
      if (this.stopped) return;
      void this.guard(name, job);
      const timer = setInterval(() => void this.guard(name, job), intervalMs);
      this.timers.push(timer);
    }, jitter);
    // setTimeout handle is also cleared on destroy (clearInterval accepts it).
    this.timers.push(start);
  }

  /** Single-flight wrapper: skip a tick if the prior run of `name` is still going. */
  private async guard(name: string, job: () => Promise<void>): Promise<void> {
    if (this.stopped) return;
    if (this.running.has(name)) {
      this.logger.warn(`Reconciliation scheduler: '${name}' still running — skipping this tick.`);
      return;
    }
    this.running.add(name);
    const started = Date.now();
    try {
      await job();
    } catch (err) {
      this.logger.error(`Reconciliation scheduler: '${name}' failed: ${(err as Error).message}`);
    } finally {
      this.running.delete(name);
      this.logger.debug(`Reconciliation scheduler: '${name}' tick done in ${Date.now() - started}ms.`);
    }
  }

  // ── jobs ──

  private async runLeadReconciliation(): Promise<void> {
    let resolved = 0;
    let scanned = 0;
    await this.forEachWorkspace('lead-reconciliation', async (workspaceId) => {
      const r = await this.leads.reconcilePendingSystem(workspaceId);
      scanned += r.scanned;
      resolved += r.resolved + r.provisionalUpgraded;
    });
    if (scanned > 0) {
      this.logger.log(`lead-reconciliation: scanned ${scanned}, resolved/upgraded ${resolved}.`);
    }
  }

  private async runInvoiceRefresh(): Promise<void> {
    let refreshed = 0;
    let polled = 0;
    await this.forEachWorkspace('invoice-refresh', async (workspaceId) => {
      const r = await this.customers.refreshInvoiceCachesSystem(workspaceId);
      polled += r.polled;
      refreshed += r.refreshed;
    });
    if (polled > 0) {
      this.logger.log(`invoice-refresh: polled ${polled}, refreshed ${refreshed}.`);
    }
  }

  private async runGraphRepair(): Promise<void> {
    let nodes = 0;
    let edges = 0;
    await this.forEachWorkspace('graph-repair', async (workspaceId) => {
      const r = await this.graph.backfillWorkspace(workspaceId);
      nodes += r.nodes;
      edges += r.edges;
    });
    if (nodes > 0 || edges > 0) {
      this.logger.log(`graph-repair: ${nodes} nodes, ${edges} edges reindexed.`);
    }
  }

  // ── helpers ──

  /**
   * Run `fn` for every workspace, one at a time (bounded load), isolating errors
   * so one workspace can never abort the pass. Enumerating the workspaces table
   * needs no GUC — it is not RLS-fenced (it is the registry mirror, keyed by id).
   */
  private async forEachWorkspace(
    job: string,
    fn: (workspaceId: string) => Promise<void>,
  ): Promise<void> {
    let workspaces: Array<{ id: string }>;
    try {
      workspaces = await this.prisma.workspace.findMany({ select: { id: true } });
    } catch (err) {
      this.logger.error(`${job}: could not list workspaces: ${(err as Error).message}`);
      return;
    }
    for (const { id } of workspaces) {
      if (this.stopped) return;
      try {
        await fn(id);
      } catch (err) {
        this.logger.warn(`${job}: workspace ${id} failed: ${(err as Error).message}`);
      }
    }
  }

  private get enabled(): boolean {
    const raw = this.config.get<string>('RECONCILE_SCHEDULER_ENABLED');
    return /^(true|1|yes|on)$/i.test((raw ?? '').trim());
  }

  /** Parse a non-negative-integer interval (ms) env var, else the default. A
   *  value of 0 is meaningful (disables that job), so it is preserved. */
  private intervalMs(key: string, fallback: number): number {
    const raw = this.config.get<string>(key);
    if (raw === undefined || raw === null || `${raw}`.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }
}

/** Human-readable cadence for the boot log. */
function describe(ms: number): string {
  if (ms <= 0) return 'off';
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

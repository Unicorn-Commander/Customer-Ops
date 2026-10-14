/**
 * RetentionSweepService — the DORMANT-record data-retention sweep.
 *
 * Mirrors the Contact-Ops `retention_sweep` posture: a flag-gated background job
 * that purges customer records whose last activity predates a workspace's
 * configured retention window. It is DOUBLY inert by default and PURGES NOTHING
 * until an operator explicitly opts in:
 *
 *   1. CUSTOMER_OPS_RETENTION_SWEEP_ENABLED (default OFF) — the master switch.
 *      With it off, the timer never starts and every manual trigger is a no-op.
 *   2. workspaces.retention_days (default NULL) — a workspace with no window set
 *      is skipped even when the flag is on.
 *
 * A "dormant" record is a customer whose `updatedAt` predates
 * (now − retentionDays). Purge reuses the exact on-request erasure path
 * (GdprService.eraseCustomerCore → Postgres PII delete + FalkorDB cleanup +
 * a DELETE audit row tagged reason:'retention'), so a swept record leaves the
 * same compliance trail as an operator-initiated erasure.
 *
 * SCHEDULING: no @nestjs/schedule dependency (not in the tree) — a self-managed
 * interval started in onModuleInit ONLY when the flag is enabled, cleared on
 * shutdown. The interval never overlaps itself (a `running` latch). The sweep is
 * also callable directly (sweepOnce / sweepWorkspace) for an owner-triggered run
 * and for tests.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { retentionSweepEnabled, retentionSweepIntervalMs } from '../common/workspace/feature-flags';
import { GdprService } from './gdpr.service';

/** The outcome of a sweep pass (structural counts for logging / the API). */
export interface SweepResult {
  enabled: boolean;
  workspacesScanned: number;
  customersPurged: number;
}

@Injectable()
export class RetentionSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionSweepService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspaceContextService,
    private readonly gdpr: GdprService,
  ) {}

  private get enabled(): boolean {
    return retentionSweepEnabled((k) => this.config.get<string>(k));
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'Retention sweep DISABLED (CUSTOMER_OPS_RETENTION_SWEEP_ENABLED off) — no purge timer.',
      );
      return;
    }
    const intervalMs = retentionSweepIntervalMs((k) => this.config.get<string>(k));
    this.logger.warn(
      `Retention sweep ENABLED — purging dormant records every ${Math.round(intervalMs / 3600000)}h ` +
        'for workspaces with a retention window set.',
    );
    // Unref so the timer never keeps the process alive on its own.
    this.timer = setInterval(() => {
      void this.sweepOnce().catch((err) =>
        this.logger.error(`Retention sweep pass failed: ${(err as Error).message}`),
      );
    }, intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── sweep ───────────────────────────────────────────────────────────────

  /**
   * One sweep pass over EVERY workspace that has a retention window. No-op (and
   * returns enabled:false) when the master flag is off — the fail-closed guard
   * that guarantees "purges nothing until enabled". Overlap-safe (a concurrent
   * call while a pass is in flight returns immediately).
   */
  async sweepOnce(): Promise<SweepResult> {
    if (!this.enabled) return { enabled: false, workspacesScanned: 0, customersPurged: 0 };
    if (this.running) {
      this.logger.debug('Retention sweep already in progress — skipping this pass.');
      return { enabled: true, workspacesScanned: 0, customersPurged: 0 };
    }
    this.running = true;
    try {
      // `workspaces` is the control table (not RLS-fenced): read the opted-in
      // workspaces directly. Only those with a positive window are eligible.
      const eligible = await this.prisma.workspace.findMany({
        where: { retentionDays: { gt: 0 } },
        select: { id: true, retentionDays: true },
      });
      let purged = 0;
      for (const ws of eligible) {
        if (ws.retentionDays == null) continue;
        purged += await this.purgeWorkspace(ws.id, ws.retentionDays);
      }
      if (eligible.length > 0) {
        this.logger.log(
          `Retention sweep: scanned ${eligible.length} workspace(s), purged ${purged} dormant customer(s).`,
        );
      }
      return { enabled: true, workspacesScanned: eligible.length, customersPurged: purged };
    } finally {
      this.running = false;
    }
  }

  /**
   * Sweep ONE workspace by its configured window. Reads the workspace's
   * retentionDays if not supplied; returns 0 (no-op) when the flag is off, the
   * workspace has no window, or nothing is dormant. Owner-authorization is the
   * CALLER's responsibility (the timer is a system job; the API route owner-gates
   * before calling).
   */
  async sweepWorkspace(workspaceId: string, retentionDays?: number | null): Promise<number> {
    if (!this.enabled) return 0;
    let days = retentionDays;
    if (days == null) {
      const ws = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { retentionDays: true },
      });
      days = ws?.retentionDays ?? null;
    }
    if (days == null || days <= 0) return 0;
    return this.purgeWorkspace(workspaceId, days);
  }

  /**
   * The per-workspace purge: find the dormant customer ids (updatedAt before the
   * cutoff) inside the workspace GUC, then erase each through the shared erasure
   * path (system actor, reason:'retention'). Erasure is per-customer + best-effort
   * (eraseCustomerCore never throws on a missing row), so one bad row can't wedge
   * the pass.
   */
  private async purgeWorkspace(workspaceId: string, retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const ids = await this.workspaces.runInWorkspace(workspaceId, null, (tx) =>
      tx.customer.findMany({
        where: { updatedAt: { lt: cutoff } },
        select: { id: true },
      }),
    );
    let purged = 0;
    for (const { id } of ids) {
      const res = await this.gdpr.eraseCustomerCore(workspaceId, id, null, 'retention');
      if (res.erased) purged += 1;
    }
    return purged;
  }
}

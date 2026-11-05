/**
 * RetentionSweepService — the DORMANT-record data-retention sweep.
 *
 * Mirrors the Contact-Ops `retention_sweep` posture: a flag-gated background job
 * that purges customer records whose last activity predates a workspace's
 * configured retention window. It is TRIPLY inert by default and PURGES NOTHING
 * until an operator explicitly opts in:
 *
 *   1. CUSTOMER_OPS_RETENTION_SWEEP_ENABLED (default OFF) — the master switch.
 *      With it off, the timer never starts and every manual trigger is a no-op.
 *   2. workspaces.retention_days (default NULL) — a workspace with no window set
 *      is skipped even when the flag is on.
 *   3. CUSTOMER_OPS_RETENTION_SWEEP_SOURCES (default EMPTY) — an unset/empty
 *      source scope skips the whole pass even when the other two gates are on.
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
import { RelationshipStage } from '@prisma/client';
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

/** Options for a sweep pass. Dry-run never calls the erasure primitive. */
export interface SweepOptions {
  dryRun?: boolean;
}

/** Count-only dry-run output. It intentionally contains no customer identity. */
export interface SweepDryRunResult {
  eligible: number;
  wouldPurge: number;
  bySource: Record<string, number>;
}

type CustomerSource = { source: string | null };

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
        'for workspaces with a retention window and source scope set.',
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
   * that guarantees "purges nothing until enabled". A missing source scope is
   * also fail-closed: it warns once and does not even scan workspaces. Overlap-
   * safe (a concurrent call while a pass is in flight returns immediately).
   */
  async sweepOnce(): Promise<SweepResult>;
  async sweepOnce(options: { dryRun?: false }): Promise<SweepResult>;
  async sweepOnce(options: { dryRun: true }): Promise<SweepDryRunResult>;
  async sweepOnce(options: SweepOptions = {}): Promise<SweepResult | SweepDryRunResult> {
    const dryRun = options.dryRun === true;
    if (!this.enabled) {
      return dryRun
        ? this.emptyDryRunResult()
        : { enabled: false, workspacesScanned: 0, customersPurged: 0 };
    }
    if (this.running) {
      this.logger.debug('Retention sweep already in progress — skipping this pass.');
      return dryRun
        ? this.emptyDryRunResult()
        : { enabled: true, workspacesScanned: 0, customersPurged: 0 };
    }
    this.running = true;
    try {
      const sourcePrefixes = this.sourcePrefixes();
      if (sourcePrefixes.length === 0) {
        this.warnNoSourceScope();
        return dryRun
          ? this.emptyDryRunResult()
          : { enabled: true, workspacesScanned: 0, customersPurged: 0 };
      }

      // `workspaces` is the control table (not RLS-fenced): read the opted-in
      // workspaces directly. Only those with a positive window are eligible.
      const eligibleWorkspaces = await this.prisma.workspace.findMany({
        where: { retentionDays: { gt: 0 } },
        select: { id: true, retentionDays: true },
      });

      if (dryRun) {
        const summary = this.emptyDryRunResult();
        for (const ws of eligibleWorkspaces) {
          if (ws.retentionDays == null) continue;
          this.addDryRunResult(
            summary,
            await this.purgeWorkspace(ws.id, ws.retentionDays, sourcePrefixes, true),
          );
        }
        return summary;
      }

      let purged = 0;
      for (const ws of eligibleWorkspaces) {
        if (ws.retentionDays == null) continue;
        purged += await this.purgeWorkspace(ws.id, ws.retentionDays, sourcePrefixes, false);
      }
      if (eligibleWorkspaces.length > 0) {
        this.logger.log(
          `Retention sweep: scanned ${eligibleWorkspaces.length} workspace(s), purged ${purged} dormant customer(s).`,
        );
      }
      return {
        enabled: true,
        workspacesScanned: eligibleWorkspaces.length,
        customersPurged: purged,
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Sweep ONE workspace by its configured window. Reads the workspace's
   * retentionDays if not supplied; returns 0 (or count-only dry-run output) when
   * the flag is off, the workspace has no window, or nothing is dormant. Owner-
   * authorization is the CALLER's responsibility (the timer is a system job; the
   * API route owner-gates before calling).
   */
  async sweepWorkspace(workspaceId: string, retentionDays?: number | null): Promise<number>;
  async sweepWorkspace(
    workspaceId: string,
    retentionDays: number | null | undefined,
    options: { dryRun: true },
  ): Promise<SweepDryRunResult>;
  async sweepWorkspace(
    workspaceId: string,
    retentionDays?: number | null,
    options?: SweepOptions,
  ): Promise<number | SweepDryRunResult>;
  async sweepWorkspace(
    workspaceId: string,
    retentionDays?: number | null,
    options: SweepOptions = {},
  ): Promise<number | SweepDryRunResult> {
    const dryRun = options.dryRun === true;
    if (!this.enabled) return dryRun ? this.emptyDryRunResult() : 0;

    const sourcePrefixes = this.sourcePrefixes();
    if (sourcePrefixes.length === 0) {
      this.warnNoSourceScope();
      return dryRun ? this.emptyDryRunResult() : 0;
    }

    let days = retentionDays;
    if (days == null) {
      const ws = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { retentionDays: true },
      });
      days = ws?.retentionDays ?? null;
    }
    if (days == null || days <= 0) return dryRun ? this.emptyDryRunResult() : 0;
    if (dryRun) return this.purgeWorkspace(workspaceId, days, sourcePrefixes, true);
    return this.purgeWorkspace(workspaceId, days, sourcePrefixes, false);
  }

  /**
   * The per-workspace purge: find dormant LEAD customers whose source matches a
   * configured prefix inside the workspace GUC, then erase each through the
   * shared erasure path (system actor, reason:'retention'). Erasure is per-
   * customer + best-effort (eraseCustomerCore never throws on a missing row), so
   * one bad row can't wedge the pass. Dry-run selects source only and returns
   * structural counts.
   */
  private async purgeWorkspace(
    workspaceId: string,
    retentionDays: number,
    sourcePrefixes: string[],
    dryRun: true,
  ): Promise<SweepDryRunResult>;
  private async purgeWorkspace(
    workspaceId: string,
    retentionDays: number,
    sourcePrefixes: string[],
    dryRun: false,
  ): Promise<number>;
  private async purgeWorkspace(
    workspaceId: string,
    retentionDays: number,
    sourcePrefixes: string[],
    dryRun: boolean,
  ): Promise<number | SweepDryRunResult> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const where = {
      updatedAt: { lt: cutoff },
      stage: RelationshipStage.LEAD,
      OR: sourcePrefixes.map((prefix) => ({ source: { startsWith: prefix } })),
    };

    if (dryRun) {
      const sources = await this.workspaces.runInWorkspace(workspaceId, null, (tx) =>
        tx.customer.findMany({ where, select: { source: true } }),
      );
      return this.summarizeDryRun(sources, sourcePrefixes);
    }

    const candidates = await this.workspaces.runInWorkspace(workspaceId, null, (tx) =>
      tx.customer.findMany({ where, select: { id: true, source: true } }),
    );
    let purged = 0;
    for (const { id, source } of candidates) {
      const sourcePrefix = this.matchingPrefix(source, sourcePrefixes);
      const res = await this.gdpr.eraseCustomerCore(
        workspaceId,
        id,
        null,
        'retention',
        sourcePrefix,
      );
      if (res.erased) purged += 1;
    }
    return purged;
  }

  private sourcePrefixes(): string[] {
    const raw = this.config.get<string>('CUSTOMER_OPS_RETENTION_SWEEP_SOURCES');
    if (!raw) return [];
    return [
      ...new Set(
        raw
          .split(',')
          .map((prefix) => prefix.trim())
          .filter(Boolean),
      ),
    ];
  }

  private matchingPrefix(
    source: string | null | undefined,
    prefixes: string[],
  ): string | undefined {
    if (typeof source !== 'string') return undefined;
    return prefixes.find((prefix) => source.startsWith(prefix));
  }

  private emptyDryRunResult(): SweepDryRunResult {
    return { eligible: 0, wouldPurge: 0, bySource: {} };
  }

  private summarizeDryRun(sources: CustomerSource[], sourcePrefixes: string[]): SweepDryRunResult {
    const bySource: Record<string, number> = {};
    for (const { source } of sources) {
      const prefix = this.matchingPrefix(source, sourcePrefixes);
      if (prefix) bySource[prefix] = (bySource[prefix] ?? 0) + 1;
    }
    return { eligible: sources.length, wouldPurge: sources.length, bySource };
  }

  private addDryRunResult(total: SweepDryRunResult, part: SweepDryRunResult): void {
    total.eligible += part.eligible;
    total.wouldPurge += part.wouldPurge;
    for (const [source, count] of Object.entries(part.bySource)) {
      total.bySource[source] = (total.bySource[source] ?? 0) + count;
    }
  }

  private warnNoSourceScope(): void {
    this.logger.warn('retention sweep has no source scope; nothing purged');
  }
}

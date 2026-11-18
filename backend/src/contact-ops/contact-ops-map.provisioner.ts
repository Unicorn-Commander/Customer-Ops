/**
 * Writes a workspace's `contact-ops` row in federation_workspace_map from
 * Contact-Ops' org lookup — and from nothing else (DESK-189 a-c, GATE-175).
 *
 * A wrong row points one org's Customer-Ops at another org's contacts, so:
 *   - the row's target is the lookup's tenant_id for THAT org id, written only
 *     when the answer names the same org id (the lookup client checks that);
 *     never a name, slug, email or first match;
 *   - an existing row is never changed here: if it disagrees with the lookup it
 *     is logged and left for a person to re-verify (GATE-175 point 3);
 *   - no tenant / dormant / Contact-Ops unavailable -> no row, and the manual
 *     relationship create keeps answering 409 contact_ops_not_connected.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FederationWorkspaceMapService } from '../common/federation/federation-workspace-map.service';
import { ContactOpsOrgLookupClient } from './contact-ops-org-lookup.client';

export const CONTACT_OPS_TARGET_APP = 'contact-ops';

export type ContactOpsMapOutcome =
  | { kind: 'written'; tenantId: string }
  | { kind: 'already'; tenantId: string }
  | { kind: 'conflict'; existingTenantId: string; lookupTenantId: string }
  | { kind: 'skipped'; reason: 'dormant' | 'no_tenant' | 'mismatch' | 'unavailable' };

export interface ContactOpsMapBackfillReport {
  apply: boolean;
  /** The lookup is not configured: nothing was asked and nothing written. */
  dormant: boolean;
  /** org id -> tenant id from the lookup (written only when `apply`). */
  pairs: Array<{ orgId: string; tenantId: string }>;
  skipped: Array<{ orgId: string; reason: string }>;
  written: number;
  /** Every contact-ops row that existed before the run, re-checked (GATE-212). Never modified. */
  existing: ContactOpsMapRowCheck[];
}

/**
 * One existing row against the lookup: confirmed (same tenant), conflict (the
 * lookup names another tenant), unconfirmed (no tenant / mismatch / unavailable).
 */
export type ContactOpsMapRowCheck =
  | { orgId: string; rowTenantId: string; status: 'confirmed'; lookupTenantId: string }
  | { orgId: string; rowTenantId: string; status: 'conflict'; lookupTenantId: string }
  | { orgId: string; rowTenantId: string; status: 'unconfirmed'; reason: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ContactOpsMapProvisioner {
  private readonly logger = new Logger(ContactOpsMapProvisioner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lookup: ContactOpsOrgLookupClient,
    private readonly federationMap: FederationWorkspaceMapService,
  ) {}

  /** Ensure the contact-ops map row for the workspace bound to this org id. */
  async ensureForOrg(orgId: string): Promise<ContactOpsMapOutcome> {
    const answer = await this.lookupFor(orgId);
    if (answer.kind !== 'tenant') return answer;
    return this.writeRow(orgId, answer.tenantId);
  }

  /**
   * The re-run for existing workspaces (admin only: the management command
   * `contact-ops-map.backfill`, never an HTTP route). For each ACTIVE workspace
   * with an Ops-Center org id (contract D: the workspace id IS the org id, a
   * uuid) and NO contact-ops row, ask the lookup; with `apply`, write the row by
   * the same rule as provisioning. Dry-run by default. Idempotent: a mapped
   * workspace is never written again, and an existing row is never changed.
   *
   * Both modes also VERIFY every existing contact-ops row (GATE-212): the lookup
   * is asked for that row's org id and the row is reported confirmed / conflict
   * / unconfirmed for a person. Nothing is deleted, overwritten or widened.
   */
  async backfill(opts: { apply?: boolean } = {}): Promise<ContactOpsMapBackfillReport> {
    const apply = opts.apply === true;
    const report: ContactOpsMapBackfillReport = {
      apply,
      dormant: !this.lookup.isConfigured(),
      pairs: [],
      skipped: [],
      written: 0,
      existing: [],
    };
    if (report.dormant) return report;

    const existingRows = await this.prisma.federationWorkspaceMap.findMany({
      where: { targetApp: CONTACT_OPS_TARGET_APP },
      select: { localWorkspaceId: true, targetWorkspaceId: true },
      orderBy: { localWorkspaceId: 'asc' },
    });
    for (const row of existingRows) {
      report.existing.push(await this.verifyRow(row.localWorkspaceId, row.targetWorkspaceId));
    }
    const mapped = new Set(existingRows.map((r) => r.localWorkspaceId));
    const candidates = (
      await this.prisma.workspace.findMany({
        where: { status: 'active' },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).filter((w) => UUID_RE.test(w.id) && !mapped.has(w.id));

    for (const { id: orgId } of candidates) {
      const answer = await this.lookupFor(orgId);
      if (answer.kind !== 'tenant') {
        report.skipped.push({ orgId, reason: answer.reason });
        continue;
      }
      report.pairs.push({ orgId, tenantId: answer.tenantId });
      if (!apply) continue;
      const outcome = await this.writeRow(orgId, answer.tenantId);
      if (outcome.kind === 'written') report.written += 1;
      if (outcome.kind === 'conflict') report.skipped.push({ orgId, reason: 'conflict' });
    }
    return report;
  }

  /** Read-only: compares one existing row with the lookup; never writes. */
  private async verifyRow(orgId: string, rowTenantId: string): Promise<ContactOpsMapRowCheck> {
    const answer = await this.lookupFor(orgId);
    if (answer.kind !== 'tenant') {
      return { orgId, rowTenantId, status: 'unconfirmed', reason: answer.reason };
    }
    if (answer.tenantId === rowTenantId) {
      return { orgId, rowTenantId, status: 'confirmed', lookupTenantId: answer.tenantId };
    }
    this.compare(orgId, rowTenantId, answer.tenantId); // logs the disagreement
    return { orgId, rowTenantId, status: 'conflict', lookupTenantId: answer.tenantId };
  }

  private async lookupFor(
    orgId: string,
  ): Promise<
    { kind: 'tenant'; tenantId: string } | Extract<ContactOpsMapOutcome, { kind: 'skipped' }>
  > {
    const answer = await this.lookup.lookupTenant(orgId);
    if (answer.kind !== 'tenant') {
      // No row. The relationship create keeps answering 409 until a replay or
      // the re-run (scripts) finds a tenant.
      if (answer.kind === 'no_tenant') {
        this.logger.log(`contact-ops map: Contact-Ops has no tenant for org ${orgId}; no row`);
      } else if (answer.kind !== 'dormant') {
        this.logger.warn(
          `contact-ops map: lookup for org ${orgId} ${answer.kind} (${answer.detail}); no row, ` +
            'retried on the next provisioning replay or re-run',
        );
      }
      return { kind: 'skipped', reason: answer.kind };
    }
    return { kind: 'tenant', tenantId: answer.tenantId };
  }

  private async writeRow(orgId: string, tenantId: string): Promise<ContactOpsMapOutcome> {
    const existing = await this.currentTarget(orgId);
    if (existing !== null) return this.compare(orgId, existing, tenantId);
    try {
      await this.prisma.federationWorkspaceMap.create({
        data: {
          localWorkspaceId: orgId,
          targetApp: CONTACT_OPS_TARGET_APP,
          targetWorkspaceId: tenantId,
        },
      });
    } catch (error) {
      // A concurrent replay (or a person) wrote the row first: compare, never overwrite.
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.currentTarget(orgId);
      if (raced === null) throw error;
      return this.compare(orgId, raced, tenantId);
    }
    await this.federationMap.reload();
    this.logger.log(`contact-ops map written for org ${orgId} -> tenant ${tenantId}`);
    return { kind: 'written', tenantId };
  }

  private compare(orgId: string, existing: string, tenantId: string): ContactOpsMapOutcome {
    if (existing === tenantId) return { kind: 'already', tenantId };
    this.logger.error(
      `contact-ops map for org ${orgId} points at tenant ${existing} but the Contact-Ops ` +
        `lookup answers ${tenantId}; NOT overwritten — a person must re-verify this row (GATE-175).`,
    );
    return { kind: 'conflict', existingTenantId: existing, lookupTenantId: tenantId };
  }

  private async currentTarget(orgId: string): Promise<string | null> {
    const row = await this.prisma.federationWorkspaceMap.findUnique({
      where: {
        localWorkspaceId_targetApp: { localWorkspaceId: orgId, targetApp: CONTACT_OPS_TARGET_APP },
      },
    });
    return row ? row.targetWorkspaceId : null;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

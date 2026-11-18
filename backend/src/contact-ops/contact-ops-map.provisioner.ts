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
    const answer = await this.lookup.lookupTenant(orgId);
    if (answer.kind !== 'tenant') {
      return { kind: 'skipped', reason: answer.kind };
    }
    return this.writeRow(orgId, answer.tenantId);
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

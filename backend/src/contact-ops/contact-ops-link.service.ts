/**
 * Writes a workspace's Contact-Ops link row without an operator (AUD-CR-1).
 *
 * Before this, the contact-ops row in federation_workspace_map was written only
 * when Ops-Center POSTed /provisioning (and Contact-Ops already had a tenant),
 * or by the manual backfill. A workspace created at first sign-in, or whose
 * Contact-Ops tenant appeared after the POST, stayed unlinked.
 *
 * Now the same writer (ContactOpsMapProvisioner.ensureForOrg: the lookup's
 * tenant for exactly this org id, never overwriting an existing row) runs:
 *   - at sign-in, for the workspace the sign-in just provisioned or joined
 *     (the stored workspace row's id: the Ops-Center org id, or the self-serve
 *     workspace id), without holding the sign-in up;
 *   - whenever a Contact-Ops call finds no routable row for a workspace, so a
 *     tenant that appears later is picked up on next use.
 *
 * Idempotent and bounded: a workspace is remembered as linked only after the row
 * exists; one lookup per workspace is in flight at a time; a lookup that finds
 * no tenant is retried after RETRY_MS, not on every request. An existing row
 * (including one marked in conflict) is left to the provisioner's rules and the
 * backfill; this service never writes over it.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ContactOpsOrgLookupClient } from './contact-ops-org-lookup.client';
import { CONTACT_OPS_TARGET_APP, ContactOpsMapProvisioner } from './contact-ops-map.provisioner';

/** How long to wait before asking the lookup again for a workspace with no tenant. */
export const CONTACT_LINK_RETRY_MS = 60_000;

@Injectable()
export class ContactOpsLinkService {
  private readonly logger = new Logger(ContactOpsLinkService.name);
  private readonly linked = new Set<string>();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly lastMiss = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly lookup: ContactOpsOrgLookupClient,
    private readonly provisioner: ContactOpsMapProvisioner,
  ) {}

  /**
   * True when the workspace has a contact-ops row (now or after this call).
   * Never throws.
   */
  async ensureLinked(workspaceId: string, now: number = Date.now()): Promise<boolean> {
    if (!workspaceId || !this.lookup.isConfigured()) return false;
    if (this.linked.has(workspaceId)) return true;
    const pending = this.inFlight.get(workspaceId);
    if (pending) return pending;
    const missedAt = this.lastMiss.get(workspaceId);
    if (missedAt !== undefined && now - missedAt < CONTACT_LINK_RETRY_MS) return false;

    const attempt = this.attempt(workspaceId, now).finally(() => this.inFlight.delete(workspaceId));
    this.inFlight.set(workspaceId, attempt);
    return attempt;
  }

  private async attempt(workspaceId: string, now: number): Promise<boolean> {
    try {
      const existing = await this.prisma.federationWorkspaceMap.findUnique({
        where: {
          localWorkspaceId_targetApp: {
            localWorkspaceId: workspaceId,
            targetApp: CONTACT_OPS_TARGET_APP,
          },
        },
        select: { targetWorkspaceId: true },
      });
      if (existing) {
        this.markLinked(workspaceId);
        return true;
      }
      const outcome = await this.provisioner.ensureForOrg(workspaceId);
      if (outcome.kind === 'written' || outcome.kind === 'already') {
        this.markLinked(workspaceId);
        return true;
      }
      // conflict: a row exists but is not routable; skipped: no tenant yet.
      this.lastMiss.set(workspaceId, now);
      return false;
    } catch (error) {
      this.lastMiss.set(workspaceId, now);
      this.logger.warn(`contact-ops link for ${workspaceId} not written: ${(error as Error).name}`);
      return false;
    }
  }

  private markLinked(workspaceId: string): void {
    this.linked.add(workspaceId);
    this.lastMiss.delete(workspaceId);
  }
}

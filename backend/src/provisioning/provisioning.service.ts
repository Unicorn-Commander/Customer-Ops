import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Workspace } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipService } from '../common/workspace/membership.service';
import { UcRegistryClient } from '../common/uc-registry/uc-registry.client';
import { isUuidV7 } from '../common/uc-registry/uuidv7';
import { ContactOpsMapProvisioner } from '../contact-ops/contact-ops-map.provisioner';
import { PROVISIONING_APP_KEY, WORKSPACE_STATES, WorkspaceState } from './provisioning.config';

/** The control plane's workspace id format (contract D). */
export const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;

export interface WorkspaceStatusView {
  workspace_id: string;
  status: string;
}

/**
 * Contract D, the app side: Ops-Center creates, reads, transitions and removes
 * members from the Customer-Ops workspace bound to one of its organizations.
 *
 * BINDING: the workspace id IS the Ops-Center org_id. That is the binding the
 * sign-in path already uses (WorkspaceProvisioningService
 * .provisionEntitledOrgWorkspace keys the workspace mirror row on the org id), so
 * a workspace created here and one created at a member's first sign-in are the
 * same row, whichever comes first.
 *
 * PEOPLE stay just in time: the owner is not created here. Their membership is
 * created at their first sign-in from the control plane's entitlement answer.
 * `owner.email` is never stored or logged; nothing from the body but the org id,
 * slug and display name is kept.
 *
 * CONTACT-OPS MAP: every POST (the first one and each replay) asks Contact-Ops'
 * org lookup for this org id and writes the workspace's contact-ops map row from
 * the answer when there is none yet (ContactOpsMapProvisioner).
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: MembershipService,
    private readonly registry: UcRegistryClient,
    private readonly contactMap: ContactOpsMapProvisioner,
  ) {}

  /** POST: create or adopt the org's workspace. `created` is false on a replay. */
  async ensureWorkspace(
    body: unknown,
    idempotencyKey: string | undefined,
  ): Promise<{ created: boolean; view: WorkspaceStatusView }> {
    const input = parseCreateBody(body);
    if ((idempotencyKey ?? '').trim() !== `${input.orgId}:${PROVISIONING_APP_KEY}`) {
      throw new BadRequestException(
        `Idempotency-Key must be "<org_id>:${PROVISIONING_APP_KEY}" for this org_id.`,
      );
    }

    const existing = await this.prisma.workspace.findUnique({ where: { id: input.orgId } });
    if (existing) return this.withContactMap(false, existing);

    // Register with uc-registry only when the org id is a v7 the registry will
    // accept as-is: for any other id the client would mint and register a
    // DIFFERENT id, leaving an orphan registry row. The local mirror keeps the org id.
    if (isUuidV7(input.orgId)) await this.register(input);

    for (const slug of input.slugs) {
      try {
        const created = await this.prisma.workspace.create({
          data: { id: input.orgId, slug, displayName: input.displayName },
        });
        this.logger.log(`Provisioned workspace ${created.id} for its Ops-Center organization`);
        return this.withContactMap(true, created);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Either a concurrent call / first sign-in created this org's row (adopt
        // it), or the slug belongs to another workspace (try the next candidate).
        const raced = await this.prisma.workspace.findUnique({ where: { id: input.orgId } });
        if (raced) return this.withContactMap(false, raced);
      }
    }
    throw new BadRequestException('No free slug for this workspace.');
  }

  private async withContactMap(
    created: boolean,
    ws: Workspace,
  ): Promise<{ created: boolean; view: WorkspaceStatusView }> {
    // The map is best effort here: provisioning succeeds whatever the lookup
    // or the map write does, and the next replay tries again.
    try {
      await this.contactMap.ensureForOrg(ws.id);
    } catch (error) {
      this.logger.warn(`contact-ops map for ${ws.id} not written: ${(error as Error).name}`);
    }
    return { created, view: view(ws) };
  }

  private async register(input: CreateInput): Promise<void> {
    // A provisioning replay finds the mirror row and returns early, so it never
    // re-registers: a failed registration here is NOT retried. Say so.
    const notRetried =
      'NOT retried (a provisioning replay adopts the existing row); re-run ' +
      'POST /workspaces on uc-registry with this org id (idempotent on the id).';
    try {
      const minted = await this.registry.mintWorkspaceId({
        workspaceId: input.orgId,
        slug: input.slugs[0],
        displayName: input.displayName,
        ownerUcUid: input.ownerSubject,
        ownerIsDefault: true,
      });
      if (minted?.source !== 'uc-registry') {
        this.logger.warn(
          `uc-registry registration not confirmed for ${input.orgId} (${minted.source}); ${notRetried}`,
        );
      }
    } catch (error) {
      // Degrade-clean, exactly like the sign-in path.
      this.logger.warn(
        `uc-registry registration failed for ${input.orgId}: ${(error as Error).name}; ${notRetried}`,
      );
    }
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceStatusView> {
    return view(await this.findOrThrow(workspaceId));
  }

  /** PATCH: any state may follow any other; nothing is deleted. */
  async setState(workspaceId: string, body: unknown): Promise<WorkspaceStatusView> {
    const state = (body as { state?: unknown } | null)?.state;
    if (typeof state !== 'string' || !(WORKSPACE_STATES as readonly string[]).includes(state)) {
      throw new BadRequestException(`state must be one of: ${WORKSPACE_STATES.join(', ')}.`);
    }
    const ws = await this.findOrThrow(workspaceId);
    if (ws.status === state) return view(ws);
    const updated = await this.prisma.workspace.update({
      where: { id: ws.id },
      data: { status: state as WorkspaceState },
    });
    this.logger.log(`Workspace ${ws.id} state ${ws.status} -> ${updated.status} (control plane)`);
    return view(updated);
  }

  /** DELETE member: 404 for an unknown workspace; an unknown subject changes nothing. */
  async removeMember(workspaceId: string, subject: string): Promise<void> {
    await this.findOrThrow(workspaceId);
    await this.membership.removeMember(workspaceId, subject, { protectLastOwner: false });
  }

  private async findOrThrow(workspaceId: string): Promise<Workspace> {
    const ws = WORKSPACE_ID_PATTERN.test(workspaceId)
      ? await this.prisma.workspace.findUnique({ where: { id: workspaceId } })
      : null;
    if (!ws) throw new NotFoundException('Workspace not found');
    return ws;
  }
}

function view(ws: Workspace): WorkspaceStatusView {
  return { workspace_id: ws.id, status: ws.status };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

interface CreateInput {
  orgId: string;
  displayName: string;
  ownerSubject: string | null;
  /** Slug candidates, in order: the control plane's slug, then the sign-in path's. */
  slugs: string[];
}

function parseCreateBody(body: unknown): CreateInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('A JSON object body is required.');
  }
  const b = body as Record<string, unknown>;
  const orgId = typeof b.org_id === 'string' ? b.org_id.trim() : '';
  if (!WORKSPACE_ID_PATTERN.test(orgId)) {
    throw new BadRequestException('org_id must match [A-Za-z0-9][A-Za-z0-9_-]{0,254}.');
  }
  const owner = b.owner as Record<string, unknown> | undefined;
  const ownerSubject =
    owner && typeof owner.subject === 'string' && owner.subject.trim()
      ? owner.subject.trim()
      : null;
  const rawName = typeof b.display_name === 'string' ? b.display_name.trim().slice(0, 200) : '';
  const displayName = rawName || `Organization ${orgId.slice(0, 8)}`;

  const slugs: string[] = [];
  const asked = typeof b.slug === 'string' ? normalizeSlug(b.slug) : '';
  if (asked) slugs.push(asked);
  // The sign-in path's slug for the same org (provisionEntitledOrgWorkspace), then the full id.
  slugs.push(`org-${orgId.slice(0, 8).toLowerCase()}`);
  slugs.push(`org-${normalizeSlug(orgId) || orgId.toLowerCase()}`);
  return { orgId, displayName, ownerSubject, slugs: [...new Set(slugs)] };
}

function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

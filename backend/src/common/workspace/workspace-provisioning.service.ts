/**
 * WorkspaceProvisioningService — the self-serve onboarding keystone.
 *
 * When CUSTOMER_OPS_SIGNUP_MODE=open, a verified SSO user who is NOT matched by
 * the access list still gets in: instead of the invite-only rejection, they
 * auto-provision THEIR OWN workspace. This service materializes that, atomically:
 *
 *   1. MINT a NEW canonical workspace id from uc-registry (the suite authority —
 *      Customer-Ops never authoritatively mints one; SUITE-IDENTITY §0.1). The
 *      mint is degrade-clean: a local uuidv7 fallback when uc-registry is
 *      unconfigured/unreachable (UcRegistryClient owns that + the WARN). This
 *      external call runs BEFORE/OUTSIDE the DB transaction (the same discipline
 *      as the lead-intake → Contact-Ops upsert).
 *   2. In ONE Prisma transaction: create the User row, create the Workspace
 *      mirror row (id == the minted id), and create an OWNER Membership with
 *      isDefault=true. All-or-nothing: a stranger never ends up with a User but
 *      no workspace (or vice-versa).
 *
 * IDEMPOTENCY / RACE-SAFETY: this only ever runs for a user with NO User row
 * (the auth gate's step 3). If two requests for the same brand-new sub race, the
 * unique constraints (User.keycloakId / User.email / User.username) make exactly
 * one transaction win; the loser surfaces as a unique-violation that the caller
 * resolves by re-reading the now-existing user. We expose a typed result so the
 * caller can distinguish "I provisioned" from "someone else just did".
 *
 * TENANCY: this is the ONE place Customer-Ops creates a Workspace row for a
 * self-serve tenant. It does NOT weaken the membership gate — it SEEDS it (an
 * OWNER membership IS the gate being satisfied). It is only reachable from the
 * open-signup branch; invite mode never calls it.
 */

import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Membership, Prisma, User, WorkspaceRole } from '@prisma/client';
import { MembershipStatus } from '@prisma/client';
import { PrismaService, WorkspaceTxClient } from '../../prisma/prisma.service';
import { MembershipService } from './membership.service';
import { UcRegistryClient } from '../uc-registry/uc-registry.client';
import { uuidv7 } from '../uc-registry/uuidv7';

/** The verified identity fields the provisioner needs off the SSO token/profile. */
export interface ProvisionIdentity {
  /** The uchub `sub` — the canonical identity key + the Membership.userKey. */
  keycloakId: string;
  email: string;
  /** Preferred username; falls back to email when absent. */
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface ProvisionResult {
  user: User;
  workspaceId: string;
  membership: Membership;
  /** Where the workspace id came from (uc-registry vs the local degrade path). */
  workspaceIdSource: 'uc-registry' | 'local-fallback';
}

/** The organization membership returned by the Ops-Center entitlement lookup. */
export interface EntitledOrgWorkspaceRequest {
  user: User;
  orgId: string;
  orgName?: string | null;
  role?: string | null;
}

export interface EntitledOrgWorkspaceResult {
  workspaceId: string;
  membership: Membership;
  workspaceIdSource: 'uc-registry' | 'local-fallback' | 'existing';
}

@Injectable()
export class WorkspaceProvisioningService {
  private readonly logger = new Logger(WorkspaceProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: UcRegistryClient,
  ) {}

  /**
   * Provision a self-serve user: their User row + a fresh owned Workspace + an
   * OWNER membership, in one transaction. The workspace id is minted from
   * uc-registry first (outside the tx). Throws ConflictException if a concurrent
   * request already created the User (the caller re-reads).
   */
  async provisionSelfServeUser(identity: ProvisionIdentity): Promise<ProvisionResult> {
    const email = identity.email.trim();
    // Username uniqueness: prefer the SSO preferred_username, else the email; the
    // User.username unique constraint guarantees we never silently collide.
    const username = identity.username?.trim() || email;
    const displayName = this.deriveDisplayName(identity, email);

    // 1. Mint the canonical workspace id OUTSIDE the tx (degrade-clean; never
    // throws). We mint the uuidv7 app-side FIRST so the slug + the mirror row are
    // derived from the SAME id whether or not uc-registry confirms it (the
    // suite-preferred "supply the UUID; the registry records it idempotently"
    // flow — handoff-uc-registry §"uuidv7 minting"). The slug must be globally
    // unique (Workspace.slug @unique) AND it is immutable at the registry, so it
    // is finalized here, before the round-trip — never a throwaway suggestion.
    const candidateId = uuidv7();
    const slug = this.deriveSlug(email, candidateId);
    const minted = await this.registry.mintWorkspaceId({
      workspaceId: candidateId,
      displayName,
      slug,
      ownerUcUid: identity.keycloakId,
    });
    const workspaceId = minted.workspaceId;

    // 2. Materialize the tenant atomically. uc_uid attribution = the new owner.
    let result: ProvisionResult;
    try {
      result = await this.prisma.withWorkspace(workspaceId, identity.keycloakId, async (tx) =>
        this.createTenant(tx, identity, {
          workspaceId,
          slug,
          displayName,
          username,
          email,
          source: minted.source,
        }),
      );
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        // A concurrent request for the same brand-new sub/email won the race.
        this.logger.warn(
          `Self-serve provision raced for ${email} — a concurrent signup already created the user.`,
        );
        throw new ConflictException('User already provisioned (concurrent signup).');
      }
      throw err;
    }

    this.logger.log(
      `Self-serve provisioned ${email} (sub ${identity.keycloakId}) → OWNER of new workspace ` +
        `${workspaceId} [id source: ${minted.source}]`,
    );
    return result;
  }

  /**
   * Ensure the Customer-Ops workspace that corresponds to an entitled
   * Ops-Center organization. The org id is the idempotency key and is also the
   * local workspace id, so every user in one org joins the same workspace.
   *
   * The registry client is still called for a new mirror row. Some Ops-Center
   * org ids are UUID v4 while the legacy registry client validates UUID v7; if
   * it cannot confirm the supplied id, the local mirror keeps the org id and
   * reports the same local-fallback posture as self-serve provisioning.
   */
  async provisionEntitledOrgWorkspace(
    request: EntitledOrgWorkspaceRequest,
  ): Promise<EntitledOrgWorkspaceResult> {
    const orgId = request.orgId.trim();
    if (!orgId) throw new Error('Entitled organization id is required');

    const userKey = MembershipService.membershipKey(request.user);
    const role =
      request.role?.trim().toLowerCase() === 'owner' ? WorkspaceRole.OWNER : WorkspaceRole.MEMBER;
    const slug = `org-${orgId.slice(0, 8).toLowerCase()}`;
    const displayName = request.orgName?.trim() || `Organization ${orgId.slice(0, 8)}`;
    const existing = await this.prisma.workspace.findUnique({ where: { id: orgId } });

    let source: EntitledOrgWorkspaceResult['workspaceIdSource'] = existing
      ? 'existing'
      : 'local-fallback';
    if (!existing) {
      try {
        const minted = await this.registry.mintWorkspaceId({
          workspaceId: orgId,
          slug,
          displayName,
          ownerUcUid: role === WorkspaceRole.OWNER ? userKey : null,
          ownerIsDefault: true,
        });
        source = minted.workspaceId === orgId ? minted.source : 'local-fallback';
        if (minted.workspaceId !== orgId) {
          this.logger.warn(
            `uc-registry could not confirm entitled org workspace id ${orgId}; keeping the org id locally`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `uc-registry entitlement registration failed for ${orgId}: ${(error as Error).message}`,
        );
      }
    }

    try {
      const result = await this.materializeEntitledOrgWorkspace({
        orgId,
        userKey,
        role,
        slug,
        displayName,
      });
      return { workspaceId: orgId, membership: result.membership, workspaceIdSource: source };
    } catch (error) {
      // Two first logins for a new org can race on the Workspace primary key.
      // Re-run the idempotent transaction after the winner commits.
      if (!this.isUniqueViolation(error)) throw error;
      const raced = await this.prisma.workspace.findUnique({ where: { id: orgId } });
      if (!raced) throw error;
      const result = await this.materializeEntitledOrgWorkspace({
        orgId,
        userKey,
        role,
        slug,
        displayName,
      });
      return {
        workspaceId: orgId,
        membership: result.membership,
        workspaceIdSource: 'existing',
      };
    }
  }

  private async materializeEntitledOrgWorkspace(fields: {
    orgId: string;
    userKey: string;
    role: WorkspaceRole;
    slug: string;
    displayName: string;
  }): Promise<{ membership: Membership }> {
    return this.prisma.withWorkspace(fields.orgId, fields.userKey, async (tx) => {
      const workspace =
        (await tx.workspace.findUnique({ where: { id: fields.orgId } })) ??
        (await tx.workspace.create({
          data: {
            id: fields.orgId,
            slug: fields.slug,
            displayName: fields.displayName,
          },
        }));
      const hasAny = await tx.membership.findFirst({ where: { userKey: fields.userKey } });
      const membership = await tx.membership.upsert({
        where: {
          userKey_workspaceId: { userKey: fields.userKey, workspaceId: workspace.id },
        },
        update: { status: MembershipStatus.ACTIVE },
        create: {
          userKey: fields.userKey,
          workspaceId: workspace.id,
          role: fields.role,
          status: MembershipStatus.ACTIVE,
          isDefault: !hasAny,
        },
      });
      return { membership };
    });
  }

  /**
   * The atomic body: User + Workspace mirror + OWNER membership. Runs inside
   * withWorkspace so the writes carry the GUCs (correct + forward-compatible
   * under live RLS — though Workspace/User are control tables, not RLS-fenced).
   */
  private async createTenant(
    tx: WorkspaceTxClient,
    identity: ProvisionIdentity,
    fields: {
      workspaceId: string;
      slug: string;
      displayName: string;
      username: string;
      email: string;
      source: 'uc-registry' | 'local-fallback';
    },
  ): Promise<ProvisionResult> {
    const user = await tx.user.create({
      data: {
        email: fields.email,
        username: fields.username,
        firstName: identity.firstName?.trim() || '',
        lastName: identity.lastName?.trim() || '',
        keycloakId: identity.keycloakId,
      },
    });

    await tx.workspace.create({
      data: {
        id: fields.workspaceId,
        slug: fields.slug,
        displayName: fields.displayName,
        // A self-serve signup lands on the shared-SaaS defaults (the schema
        // defaults): standard isolation, shared tier, active. uc-registry remains
        // the authority for richer tier/isolation; this mirror row just needs to
        // exist so the FK + the membership gate resolve.
      },
    });

    // The membership key is the same one the gate reads (sub/keycloakId, else id).
    const userKey = MembershipService.membershipKey(user);
    const membership = await tx.membership.create({
      data: {
        userKey,
        workspaceId: fields.workspaceId,
        role: WorkspaceRole.OWNER,
        status: MembershipStatus.ACTIVE,
        isDefault: true,
      },
    });

    return { user, workspaceId: fields.workspaceId, membership, workspaceIdSource: fields.source };
  }

  // --- derivations ---------------------------------------------------------

  /** A human label for the new workspace: "<Name>'s Workspace", else the email. */
  private deriveDisplayName(identity: ProvisionIdentity, email: string): string {
    const first = identity.firstName?.trim();
    const last = identity.lastName?.trim();
    const name = [first, last].filter(Boolean).join(' ').trim();
    if (name) return `${name}'s Workspace`;
    const local = email.split('@')[0]?.trim();
    return local ? `${local}'s Workspace` : 'My Workspace';
  }

  /**
   * A globally-unique, url-safe slug. Base = the email local-part lowercased to
   * `[a-z0-9-]` (so it reads nicely); suffix = the last 8 hex of the workspace
   * id (uniqueness guarantee — Workspace.slug is @unique). The id is minted
   * app-side before this is called, so the suffix is always the real workspace
   * id's tail (the slug + id + mirror row are all coherent). The `|| uuidv7()`
   * guard is a belt-and-suspenders fallback only.
   */
  private deriveSlug(email: string, workspaceId: string): string {
    const local = (email.split('@')[0] || 'workspace')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    const base = local || 'workspace';
    const idForSuffix = workspaceId || uuidv7();
    const suffix = idForSuffix.replace(/-/g, '').slice(-8);
    return `${base}-${suffix}`;
  }

  private isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  }
}

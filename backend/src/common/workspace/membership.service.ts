import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Membership, MembershipStatus, Prisma, User, WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveUserAccess } from '../../auth/access-list';
import { tenancyEnabled } from './feature-flags';
import { provisioningEnabled } from '../../provisioning/provisioning.config';
import { defaultWorkspaceId } from './workspace.util';

/**
 * Workspace membership resolution + gating (SUITE-IDENTITY §3, §D5).
 *
 * The cross-app contract: a valid uchub token JIT-provisions the User row, but
 * grants ZERO workspace access until an explicit Membership row exists. The
 * allow-list (CUSTOMER_OPS_ACCESS_LIST) is a membership-SEEDING convenience —
 * NOT "the tenant". Membership is what gates.
 *
 * Rollout-safety: every gate here is a no-op while CUSTOMER_OPS_TENANCY_ENABLED
 * is off (its default). With the flag off, callers fall back to
 * DEFAULT_WORKSPACE_ID exactly as before. With the flag on, workspace routes
 * 403 without an active membership and the membership-derived workspace drives
 * the RLS GUC.
 */
@Injectable()
export class MembershipService {
  private readonly logger = new Logger(MembershipService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get enabled(): boolean {
    return tenancyEnabled((k) => this.config.get<string>(k));
  }

  /**
   * The single bootstrap/dogfood workspace id seeded by the RLS migration.
   *
   * A BLANK `DEFAULT_WORKSPACE_ID` IS TREATED AS ABSENT. ConfigService's default
   * argument only applies to `undefined`, so `DEFAULT_WORKSPACE_ID=` (explicitly
   * empty, which is easy to produce in a compose file or a templated env) used to
   * make this getter return `''` — and that `''` flowed straight through
   * `resolveAndAuthorize` into `PatService.create`, which persisted a PAT row
   * with `workspaceId: ''`. Such a token is UNBINDABLE: the auth chokepoint's
   * sentinel refuses it on every request, so a token that minted with a 201 is
   * dead on arrival and cannot be fixed by re-minting. Normalise here, at the
   * write side, rather than letting an empty string become a persisted binding.
   */
  get bootstrapWorkspaceId(): string {
    return defaultWorkspaceId((k) => this.config.get<string>(k));
  }

  /**
   * The membership key for a user == uchub `sub` == User.keycloakId. Local
   * (non-SSO) users have no keycloakId; their membership key falls back to the
   * local user id so the dogfood seed still resolves.
   */
  static membershipKey(user: Pick<User, 'id' | 'keycloakId'>): string {
    return user.keycloakId ?? user.id;
  }

  /**
   * Load the workspace mirror rows for a set of ids (display fields for the
   * list_my_workspaces projection). Read-through accessor so callers don't need
   * their own Prisma dependency.
   */
  async findWorkspaces(ids: string[]) {
    if (ids.length === 0) return [];
    return this.prisma.workspace.findMany({ where: { id: { in: ids } } });
  }

  /** All ACTIVE memberships for a user (keyed by sub/keycloakId or local id). */
  async listActiveMemberships(user: Pick<User, 'id' | 'keycloakId'>): Promise<Membership[]> {
    const userKey = MembershipService.membershipKey(user);
    return this.prisma.membership.findMany({
      where: { userKey, status: MembershipStatus.ACTIVE },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /** True iff the user has an ACTIVE membership in `workspaceId`. */
  async isActiveMember(
    user: Pick<User, 'id' | 'keycloakId'>,
    workspaceId: string,
  ): Promise<boolean> {
    const userKey = MembershipService.membershipKey(user);
    const m = await this.prisma.membership.findUnique({
      where: { userKey_workspaceId: { userKey, workspaceId } },
    });
    return !!m && m.status === MembershipStatus.ACTIVE;
  }

  /**
   * Resolve the workspace a request should run in for `user`, and ensure the
   * user is an active member of it.
   *
   *  - Flag OFF (default): returns the requested/default workspace WITHOUT a
   *    membership check (today's single-tenant behavior, never throws).
   *  - Flag ON: the user must have an active membership; an allow-listed user
   *    with no membership is seeded JIT into the bootstrap workspace; anyone
   *    else gets a 403. The requested workspace (path/header/claim) must be one
   *    the user actually belongs to, else 403.
   *
   * @param requestedWorkspaceId optional explicit target (from path/header/claim).
   */
  async resolveAndAuthorize(user: User, requestedWorkspaceId?: string | null): Promise<string> {
    const fallback = this.bootstrapWorkspaceId;

    if (!this.enabled) {
      // Inert: behave exactly as before — claim/requested wins, else default.
      return requestedWorkspaceId?.trim() || fallback;
    }

    // Tenancy live: membership gates. Seed allow-listed users JIT.
    await this.ensureSeededMembership(user);

    const memberships = await this.listActiveMemberships(user);
    if (memberships.length === 0) {
      this.logger.warn(
        `403 workspace access for ${user.email} (${MembershipService.membershipKey(user)}): no active membership`,
      );
      throw new ForbiddenException('No workspace access for this user.');
    }

    if (requestedWorkspaceId?.trim()) {
      const target = requestedWorkspaceId.trim();
      if (!memberships.some((m) => m.workspaceId === target)) {
        this.logger.warn(`403 workspace access for ${user.email}: not a member of ${target}`);
        throw new ForbiddenException('Not a member of the requested workspace.');
      }
      return target;
    }

    // No explicit target: the default membership, else the first.
    const def = memberships.find((m) => m.isDefault) ?? memberships[0];
    return def.workspaceId;
  }

  /**
   * If `user` is on the SSO allow-list but has no membership yet, seed one into
   * the bootstrap workspace at the role mapped from their access-list role.
   * Idempotent. Only runs when tenancy is enabled.
   */
  async ensureSeededMembership(user: User): Promise<void> {
    if (!this.enabled) return;
    const userKey = MembershipService.membershipKey(user);

    const existing = await this.prisma.membership.findFirst({ where: { userKey } });
    if (existing) return;

    const access = resolveUserAccess(user.email);
    if (!access.allowed) return; // not allow-listed -> no seed; gate will 403.

    const workspaceId = this.bootstrapWorkspaceId;
    // Only seed if the bootstrap workspace actually exists locally.
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) {
      this.logger.warn(
        `Cannot seed membership for ${user.email}: bootstrap workspace ${workspaceId} not present`,
      );
      return;
    }

    const role = MembershipService.suiteRoleForAccess(access.role);
    await this.prisma.membership.upsert({
      where: { userKey_workspaceId: { userKey, workspaceId } },
      update: {},
      create: {
        userKey,
        workspaceId,
        role,
        status: MembershipStatus.ACTIVE,
        isDefault: true,
      },
    });
    this.logger.log(
      `Seeded ${role} membership for ${user.email} in workspace ${workspaceId} (allow-list)`,
    );
  }

  /**
   * Resolve the canonical suite WorkspaceRole to seed (SUITE-IDENTITY §7).
   * Customer-Ops' access list already returns canonical suite roles, so this is
   * the identity — kept as an explicit seam so the call site reads the same as
   * the rest of the suite (which map an app-local role here).
   */
  static suiteRoleForAccess(role: WorkspaceRole): WorkspaceRole {
    return role;
  }

  // ── Workspace settings: roster + owner-gated member management ──────────────
  // memberships is a CONTROL-PLANE table (not RLS-fenced — see the migration),
  // so these use the plain client and enforce RBAC + safety rails in code.

  /** Workspace mirror row, or 404. */
  async getWorkspaceOrThrow(workspaceId: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw new NotFoundException('Workspace not found');
    return ws;
  }

  /** The acting user's role in a workspace (null if not an active member). */
  async roleInWorkspace(
    user: Pick<User, 'id' | 'keycloakId'>,
    workspaceId: string,
  ): Promise<WorkspaceRole | null> {
    const m = await this.prisma.membership.findUnique({
      where: {
        userKey_workspaceId: { userKey: MembershipService.membershipKey(user), workspaceId },
      },
    });
    return m && m.status === MembershipStatus.ACTIVE ? m.role : null;
  }

  /** Guard: only an OWNER may manage members. Throws 403 otherwise. */
  async assertOwner(user: User, workspaceId: string): Promise<void> {
    if ((await this.roleInWorkspace(user, workspaceId)) !== WorkspaceRole.OWNER) {
      throw new ForbiddenException('Only the workspace owner can manage members.');
    }
  }

  // ── Kill switch: workspace-scoped, runtime-mutable agent/outbound halt ───────
  // The flag lives on the workspace mirror (a control-plane row, NOT RLS-fenced),
  // so it is read/written with the plain client. It is CHECKED at dispatch time
  // (every agent run + outbound send re-reads it) — flipping it takes effect
  // immediately, no restart. Mirrors Contact-Ops / Email-Ops (agentsPaused).

  /** True iff agent runs + outbound sends are paused for this workspace. */
  async areAgentsPaused(workspaceId: string): Promise<boolean> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { agentsPaused: true },
    });
    return !!ws?.agentsPaused;
  }

  /**
   * Dispatch guard: throw 403 when the workspace kill switch is engaged. Called
   * at the start of every agent run and before every outbound send, so a flip
   * halts activity for THAT workspace immediately (per-workspace, runtime).
   */
  async assertAgentsNotPaused(workspaceId: string): Promise<void> {
    if (await this.areAgentsPaused(workspaceId)) {
      throw new ForbiddenException(
        'Agent and outbound activity is paused for this workspace (kill switch ' +
          'engaged). A workspace owner can resume it in workspace settings.',
      );
    }
  }

  /**
   * Toggle the workspace kill switch and return the new state. 404 if the
   * workspace mirror is absent; a no-op when unchanged. The caller MUST have
   * already passed assertOwner (owner-gated at the route/tool, mirroring the
   * member-management mutations above).
   */
  async setAgentsPaused(workspaceId: string, paused: boolean): Promise<boolean> {
    await this.getWorkspaceOrThrow(workspaceId);
    const updated = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { agentsPaused: paused },
      select: { agentsPaused: true },
    });
    this.logger.log(`Workspace ${workspaceId} kill switch → agentsPaused=${updated.agentsPaused}`);
    return updated.agentsPaused;
  }

  /**
   * The member roster (everyone not REVOKED), newest-role first, with the user's
   * display fields resolved from the users mirror (a member with no local user
   * row — e.g. a federation service principal — is flagged `is_service`).
   */
  async listWorkspaceMembers(
    workspaceId: string,
    actingUser: Pick<User, 'id' | 'keycloakId'>,
  ): Promise<WorkspaceMember[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { workspaceId, status: { not: MembershipStatus.REVOKED } },
      orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
    });
    if (memberships.length === 0) return [];

    const keys = memberships.map((m) => m.userKey);
    const users = await this.prisma.user.findMany({
      where: { OR: [{ keycloakId: { in: keys } }, { id: { in: keys } }] },
    });
    const byKey = new Map<string, User>();
    for (const u of users) {
      if (u.keycloakId) byKey.set(u.keycloakId, u);
      byKey.set(u.id, u);
    }

    const me = MembershipService.membershipKey(actingUser);
    return memberships.map((m) => {
      const u = byKey.get(m.userKey);
      const name = u ? `${u.firstName} ${u.lastName}`.trim() || u.username : null;
      return {
        user_key: m.userKey,
        email: u?.email ?? null,
        display_name: name,
        username: u?.username ?? null,
        role: String(m.role).toLowerCase(),
        status: String(m.status).toLowerCase(),
        is_default: m.isDefault,
        is_service: !u,
        is_you: m.userKey === me,
        last_login_at: u?.lastLoginAt ?? null,
        joined_at: m.createdAt,
      };
    });
  }

  /** Count active OWNERs — the last-owner safety rail for demote/revoke. */
  private countActiveOwners(workspaceId: string): Promise<number> {
    return this.prisma.membership.count({
      where: { workspaceId, role: WorkspaceRole.OWNER, status: MembershipStatus.ACTIVE },
    });
  }

  /**
   * Change a member's role. 404 if the target isn't an active/suspended member;
   * a no-op when unchanged; refuses to demote the LAST owner (lockout guard).
   * Caller must have already passed assertOwner.
   */
  async setMemberRole(
    workspaceId: string,
    targetUserKey: string,
    newRole: WorkspaceRole,
  ): Promise<Membership> {
    const target = await this.prisma.membership.findUnique({
      where: { userKey_workspaceId: { userKey: targetUserKey, workspaceId } },
    });
    if (!target || target.status === MembershipStatus.REVOKED) {
      throw new NotFoundException('Member not found in this workspace');
    }
    if (target.role === newRole) return target;
    if (target.role === WorkspaceRole.OWNER && (await this.countActiveOwners(workspaceId)) <= 1) {
      throw new BadRequestException('Cannot change the role of the last owner.');
    }
    const updated = await this.prisma.membership.update({
      where: { userKey_workspaceId: { userKey: targetUserKey, workspaceId } },
      data: { role: newRole },
    });
    this.logger.log(`Member ${targetUserKey} role → ${newRole} in workspace ${workspaceId}`);
    return updated;
  }

  // ── Member removal: membership + credentials, one transaction ───────────────
  //
  // THE RULE (shared by the app's own member screen and the control plane's
  // DELETE /provisioning/workspaces/{id}/members/{subject}):
  //   - credentials bound to THIS workspace are revoked;
  //   - a credential bound to no workspace is revoked only when the person has
  //     no other active (or paused) membership here, or when this node does not
  //     enforce membership (CUSTOMER_OPS_TENANCY_ENABLED off);
  //   - tokens bound to another workspace are never touched;
  //   - a revoked token never comes back (revokedAt is permanent; re-adding the
  //     person creates a membership, not a token);
  //   - quote share links are the workspace's, not the person's: kept.

  /** Say what removing `userKey` from `workspaceId` would revoke, without changing anything. */
  async planMemberRemoval(workspaceId: string, userKey: string): Promise<MemberRemovalPlan> {
    return this.prisma.$transaction((tx) => this.buildRemovalPlan(tx, workspaceId, userKey));
  }

  /**
   * Remove a member and revoke their credentials by the rule above, atomically.
   * Idempotent: a person with no membership row changes nothing; a second call
   * finds nothing left to revoke. `protectLastOwner` keeps the app's own
   * lockout rail (the control plane, the authority for its org, may remove anyone).
   */
  async removeMember(
    workspaceId: string,
    userKey: string,
    options: { protectLastOwner: boolean },
  ): Promise<MemberRemovalOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const plan = await this.buildRemovalPlan(tx, workspaceId, userKey);
      if (!plan.is_member) return { membership: null, plan };

      const current = await tx.membership.findUniqueOrThrow({
        where: { userKey_workspaceId: { userKey, workspaceId } },
      });
      if (
        options.protectLastOwner &&
        current.status !== MembershipStatus.REVOKED &&
        current.role === WorkspaceRole.OWNER &&
        (await tx.membership.count({
          where: { workspaceId, role: WorkspaceRole.OWNER, status: MembershipStatus.ACTIVE },
        })) <= 1
      ) {
        throw new BadRequestException('Cannot remove the last owner.');
      }

      const membership =
        current.status === MembershipStatus.REVOKED && !current.isDefault
          ? current
          : await tx.membership.update({
              where: { userKey_workspaceId: { userKey, workspaceId } },
              data: { status: MembershipStatus.REVOKED, isDefault: false },
            });

      const user = await this.findUserByKey(tx, userKey);
      if (user) {
        const now = new Date();
        await tx.personalAccessToken.updateMany({
          where: { userId: user.id, revokedAt: null, workspaceId },
          data: { revokedAt: now },
        });
        if (plan.revokes.unbound_tokens > 0) {
          await tx.personalAccessToken.updateMany({
            where: {
              userId: user.id,
              revokedAt: null,
              OR: [{ workspaceId: null }, { workspaceId: '' }],
            },
            data: { revokedAt: now },
          });
        }
        await tx.m365Connection.deleteMany({ where: { userId: user.id, workspaceId } });
      }

      this.logger.log(
        `Member ${userKey} removed from workspace ${workspaceId}: ` +
          `${plan.revokes.workspace_tokens} workspace token(s), ` +
          `${plan.revokes.unbound_tokens} unbound token(s), ` +
          `${plan.revokes.m365_connections} M365 link(s) revoked`,
      );
      return { membership, plan };
    });
  }

  private async findUserByKey(tx: Prisma.TransactionClient, userKey: string) {
    return (
      (await tx.user.findUnique({ where: { keycloakId: userKey } })) ??
      (await tx.user.findFirst({ where: { id: userKey, keycloakId: null } }))
    );
  }

  private async buildRemovalPlan(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    userKey: string,
  ): Promise<MemberRemovalPlan> {
    const enforced = this.enabled;
    const plan: MemberRemovalPlan = {
      workspace_id: workspaceId,
      user_key: userKey,
      is_member: false,
      revokes: { membership: false, workspace_tokens: 0, unbound_tokens: 0, m365_connections: 0 },
      keeps: { other_workspace_tokens: 0, unbound_tokens: 0, quote_share_links: 'kept' },
      sessions: enforced ? 'refused_by_membership_check' : 'not_enforced',
    };
    const membership = await tx.membership.findUnique({
      where: { userKey_workspaceId: { userKey, workspaceId } },
    });
    if (!membership) return plan;
    plan.is_member = true;
    plan.revokes.membership = membership.status !== MembershipStatus.REVOKED;

    const user = await this.findUserByKey(tx, userKey);
    if (!user) return plan;
    const live = { userId: user.id, revokedAt: null };
    const unboundWhere = { ...live, OR: [{ workspaceId: null }, { workspaceId: '' }] };
    const [workspaceTokens, unboundTokens, otherTokens, m365, otherMemberships] = await Promise.all(
      [
        tx.personalAccessToken.count({ where: { ...live, workspaceId } }),
        tx.personalAccessToken.count({ where: unboundWhere }),
        tx.personalAccessToken.count({
          where: { ...live, workspaceId: { notIn: [workspaceId, ''] } },
        }),
        tx.m365Connection.count({ where: { userId: user.id, workspaceId } }),
        tx.membership.count({
          where: {
            userKey,
            workspaceId: { not: workspaceId },
            status: { in: [MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED] },
          },
        }),
      ],
    );
    plan.revokes.workspace_tokens = workspaceTokens;
    plan.revokes.m365_connections = m365;
    plan.keeps.other_workspace_tokens = otherTokens;
    if (!enforced || otherMemberships === 0) plan.revokes.unbound_tokens = unboundTokens;
    else plan.keeps.unbound_tokens = unboundTokens;
    return plan;
  }

  /**
   * Revoke a member (soft: status → REVOKED, clears default). 404 if not a
   * member; refuses to remove the LAST owner. Caller must have passed assertOwner.
   */
  async revokeMember(workspaceId: string, targetUserKey: string): Promise<Membership> {
    if (provisioningEnabled()) {
      // Same removal as the control plane's DELETE …/members/{subject}: the
      // membership AND the credentials the removal rule names, in one transaction.
      const outcome = await this.removeMember(workspaceId, targetUserKey, {
        protectLastOwner: true,
      });
      // Same answer as before for a person who is not (or no longer) a member.
      if (!outcome.membership || !outcome.plan.revokes.membership) {
        throw new NotFoundException('Member not found in this workspace');
      }
      return outcome.membership;
    }
    const target = await this.prisma.membership.findUnique({
      where: { userKey_workspaceId: { userKey: targetUserKey, workspaceId } },
    });
    if (!target || target.status === MembershipStatus.REVOKED) {
      throw new NotFoundException('Member not found in this workspace');
    }
    if (target.role === WorkspaceRole.OWNER && (await this.countActiveOwners(workspaceId)) <= 1) {
      throw new BadRequestException('Cannot remove the last owner.');
    }
    const updated = await this.prisma.membership.update({
      where: { userKey_workspaceId: { userKey: targetUserKey, workspaceId } },
      data: { status: MembershipStatus.REVOKED, isDefault: false },
    });
    this.logger.log(`Member ${targetUserKey} revoked from workspace ${workspaceId}`);
    return updated;
  }
}

/** What removing one member from one workspace revokes, and what it keeps. */
export interface MemberRemovalPlan {
  workspace_id: string;
  user_key: string;
  /** False when the person holds no membership row here (removal is then a no-op). */
  is_member: boolean;
  revokes: {
    /** The membership itself (status -> revoked). */
    membership: boolean;
    /** Live personal access tokens bound to this workspace. */
    workspace_tokens: number;
    /** Live personal access tokens bound to no workspace (only when no other membership remains). */
    unbound_tokens: number;
    /** Microsoft 365 links (stored refresh tokens) for this workspace; the row is deleted. */
    m365_connections: number;
  };
  keeps: {
    /** Live tokens bound to another workspace: never touched. */
    other_workspace_tokens: number;
    /** Live unbound tokens kept because another membership still uses them. */
    unbound_tokens: number;
    /** Quote share links belong to the workspace's quotes, not to the person. */
    quote_share_links: 'kept';
  };
  /** Browser sessions are stateless; the per-request membership check refuses them. */
  sessions: 'refused_by_membership_check' | 'not_enforced';
}

export interface MemberRemovalOutcome {
  /** The revoked membership, or null when the person was not a member (nothing changed). */
  membership: Membership | null;
  plan: MemberRemovalPlan;
}

/** A member-roster row for the Workspace settings surface (suite snake_case). */
export interface WorkspaceMember {
  user_key: string;
  email: string | null;
  display_name: string | null;
  username: string | null;
  role: string;
  status: string;
  is_default: boolean;
  /** No local user row (e.g. a federation/service principal). */
  is_service: boolean;
  /** This row is the calling user. */
  is_you: boolean;
  last_login_at: Date | null;
  joined_at: Date;
}

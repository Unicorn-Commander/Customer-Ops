import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuditAction, MembershipStatus, User, WorkspaceRole } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService, WorkspaceTxClient } from '../../prisma/prisma.service';
import { MembershipService } from './membership.service';
import { tenancyEnabled } from './feature-flags';
import { UcRegistryClient } from '../uc-registry/uc-registry.client';
import { uuidv7 } from '../uc-registry/uuidv7';

export type InvitationUser = User & { __verifiedEmail?: string | null };
const summary = {
  id: true,
  workspaceId: true,
  email: true,
  role: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  acceptedAt: true,
} as const;

@Injectable()
export class WorkspaceInvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: UcRegistryClient,
  ) {}

  private enabled() {
    if (!tenancyEnabled())
      throw new ForbiddenException('Workspace onboarding requires tenancy enforcement.');
  }

  private async owner(tx: WorkspaceTxClient, workspaceId: string, user: User) {
    const rows = await tx.$queryRaw<Array<{ status: string; role: string; memberStatus: string }>>`
      SELECT w.status,m.role,m.status AS "memberStatus" FROM workspaces w
      JOIN memberships m ON m."workspaceId"=w.id
      WHERE w.id=${workspaceId} AND m."userKey"=${MembershipService.membershipKey(user)}
      FOR SHARE OF w,m`;
    if (
      rows.length !== 1 ||
      rows[0].status !== 'active' ||
      rows[0].role !== 'OWNER' ||
      rows[0].memberStatus !== 'ACTIVE'
    ) {
      throw new ForbiddenException('Active workspace owner required.');
    }
  }

  private audit(
    tx: WorkspaceTxClient,
    workspaceId: string,
    user: User,
    action: AuditAction,
    resource: string,
    resourceId: string,
  ) {
    return tx.auditLog.create({
      data: {
        workspaceId,
        userId: MembershipService.membershipKey(user),
        action,
        resource,
        resourceId,
      },
    });
  }

  /** Reserve a server-generated ID before registry I/O; retries reuse the same tenant. */
  async createWorkspace(
    user: User,
    sourceWorkspaceId: string,
    displayName: string,
    requestKey: string,
  ) {
    this.enabled();
    const ownerKey = MembershipService.membershipKey(user);
    const reservation = await this.prisma.withWorkspace(sourceWorkspaceId, ownerKey, async (tx) => {
      await this.owner(tx, sourceWorkspaceId, user);
      await tx.$executeRaw`INSERT INTO workspace_provision_requests
        ("ownerKey","requestKey","sourceWorkspaceId","displayName","workspaceId")
        VALUES (${ownerKey},${requestKey},${sourceWorkspaceId},${displayName},${uuidv7()})
        ON CONFLICT ("ownerKey","requestKey") DO NOTHING`;
      const row = await tx.workspaceProvisionRequest.findUniqueOrThrow({
        where: { ownerKey_requestKey: { ownerKey, requestKey } },
      });
      if (row.sourceWorkspaceId !== sourceWorkspaceId || row.displayName !== displayName) {
        throw new ConflictException(
          'Request key was already used with different workspace parameters.',
        );
      }
      return row;
    });
    const slug = `workspace-${reservation.workspaceId.replace(/-/g, '')}`;
    // Supplying the reserved UUID makes the existing registry call idempotent,
    // even across a process crash. The caller cannot choose or claim a registry ID.
    const minted = reservation.completed
      ? { workspaceId: reservation.workspaceId, source: reservation.registrySource }
      : await this.registry.mintWorkspaceId({
          workspaceId: reservation.workspaceId,
          displayName,
          slug,
          ownerUcUid: ownerKey,
        });
    if (minted.workspaceId !== reservation.workspaceId)
      throw new ConflictException('Registry did not confirm the reserved workspace identity.');
    return this.prisma.withWorkspace(reservation.workspaceId, ownerKey, async (tx) => {
      await tx.$queryRaw`SELECT "requestKey" FROM workspace_provision_requests WHERE "ownerKey"=${ownerKey} AND "requestKey"=${requestKey} FOR UPDATE`;
      await this.owner(tx, sourceWorkspaceId, user);
      const current = await tx.workspaceProvisionRequest.findUniqueOrThrow({
        where: { ownerKey_requestKey: { ownerKey, requestKey } },
      });
      if (current.completed) {
        await this.owner(tx, current.workspaceId, user);
        return {
          workspace_id: current.workspaceId,
          display_name: current.displayName,
          your_role: 'owner',
          workspace_id_source: current.registrySource,
          replayed: true,
        };
      }
      const workspace = await tx.workspace.create({
        data: { id: current.workspaceId, slug, displayName },
      });
      await tx.membership.create({
        data: {
          workspaceId: workspace.id,
          userKey: ownerKey,
          role: WorkspaceRole.OWNER,
          status: MembershipStatus.ACTIVE,
          isDefault: false,
        },
      });
      await this.audit(tx, workspace.id, user, AuditAction.CREATE, 'workspace', workspace.id);
      await tx.workspaceProvisionRequest.update({
        where: { ownerKey_requestKey: { ownerKey, requestKey } },
        data: { completed: true, registrySource: minted.source },
      });
      return {
        workspace_id: workspace.id,
        display_name: workspace.displayName,
        your_role: 'owner',
        workspace_id_source: minted.source,
        replayed: false,
      };
    });
  }

  async create(
    user: User,
    workspaceId: string,
    email: string,
    role: WorkspaceRole,
    expiresInHours: number,
  ) {
    this.enabled();
    const token = randomBytes(32).toString('base64url');
    const invitation = await this.prisma.withWorkspace(
      workspaceId,
      MembershipService.membershipKey(user),
      async (tx) => {
        await this.owner(tx, workspaceId, user);
        const row = await tx.workspaceInvitation.create({
          data: {
            workspaceId,
            email: email.trim().toLowerCase(),
            role,
            tokenHash: this.hash(token),
            invitedBy: MembershipService.membershipKey(user),
            expiresAt: new Date(Date.now() + expiresInHours * 3600000),
          },
          select: summary,
        });
        await this.audit(tx, workspaceId, user, AuditAction.CREATE, 'workspace_invitation', row.id);
        return row;
      },
    );
    // Returned once in the response body. No SMTP, token URL or token audit fields.
    return { invitation, invitation_token: token, delivery: 'manual' };
  }

  async list(user: User, workspaceId: string) {
    this.enabled();
    return this.prisma.withWorkspace(
      workspaceId,
      MembershipService.membershipKey(user),
      async (tx) => {
        await this.owner(tx, workspaceId, user);
        return tx.workspaceInvitation.findMany({
          where: { workspaceId },
          select: summary,
          orderBy: { createdAt: 'desc' },
        });
      },
    );
  }

  async revoke(user: User, workspaceId: string, id: string) {
    this.enabled();
    return this.prisma.withWorkspace(
      workspaceId,
      MembershipService.membershipKey(user),
      async (tx) => {
        await this.owner(tx, workspaceId, user);
        const result = await tx.workspaceInvitation.updateMany({
          where: { id, workspaceId, status: 'PENDING' },
          data: { status: 'REVOKED' },
        });
        if (result.count !== 1) throw new BadRequestException('Invitation is unavailable.');
        await this.audit(tx, workspaceId, user, AuditAction.DELETE, 'workspace_invitation', id);
        return { revoked: true };
      },
    );
  }

  /** Eligibility only: login creates no membership and consumes no invitation. */
  async permitsIdentity(email: string): Promise<boolean> {
    if (!tenancyEnabled()) return false;
    return !!(await this.prisma.workspaceInvitation.findFirst({
      where: {
        email: email.trim().toLowerCase(),
        status: 'PENDING',
        expiresAt: { gt: new Date() },
        workspace: { status: 'active' },
      },
      select: { id: true },
    }));
  }

  async accept(user: InvitationUser, token: string) {
    this.enabled();
    if (!user.__verifiedEmail || user.__verifiedEmail !== user.email.trim().toLowerCase()) {
      throw new ForbiddenException('Sign in with the verified invited email.');
    }
    const hash = this.hash(token);
    const candidate = await this.prisma.workspaceInvitation.findUnique({
      where: { tokenHash: hash },
      select: { workspaceId: true },
    });
    if (!candidate) throw new BadRequestException('Invitation is unavailable.');
    return this.prisma.withWorkspace(
      candidate.workspaceId,
      MembershipService.membershipKey(user),
      async (tx) => {
        const locked = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM workspace_invitations WHERE "tokenHash"=${hash} FOR UPDATE`;
        if (locked.length !== 1) throw new BadRequestException('Invitation is unavailable.');
        const row = await tx.workspaceInvitation.findUnique({ where: { id: locked[0].id } });
        if (
          !row ||
          row.status !== 'PENDING' ||
          row.expiresAt <= new Date() ||
          row.email !== user.__verifiedEmail ||
          row.workspaceId !== candidate.workspaceId
        ) {
          throw new BadRequestException('Invitation is unavailable.');
        }
        const workspaces = await tx.$queryRaw<
          Array<{ status: string }>
        >`SELECT status FROM workspaces WHERE id=${row.workspaceId} FOR SHARE`;
        if (workspaces.length !== 1 || workspaces[0].status !== 'active')
          throw new ForbiddenException('Workspace is unavailable.');
        const userKey = MembershipService.membershipKey(user);
        await tx.$queryRaw`SELECT "userKey" FROM memberships WHERE "userKey"=${userKey} AND "workspaceId"=${row.workspaceId} FOR UPDATE`;
        // Atomic insert-on-conflict preserves existing roles/status, including
        // two different invitations accepted concurrently for the same identity.
        await tx.$executeRaw`INSERT INTO memberships
          ("userKey","workspaceId",role,status,"isDefault")
          VALUES (${userKey},${row.workspaceId},${row.role}::"WorkspaceRole",'ACTIVE',false)
          ON CONFLICT ("userKey","workspaceId") DO NOTHING`;
        await tx.$queryRaw`SELECT "userKey" FROM memberships WHERE "userKey"=${userKey} AND "workspaceId"=${row.workspaceId} FOR UPDATE`;
        const membership = await tx.membership.findUniqueOrThrow({
          where: { userKey_workspaceId: { userKey, workspaceId: row.workspaceId } },
        });
        if (membership.status !== MembershipStatus.ACTIVE)
          throw new ForbiddenException('Existing membership is not active.');
        // Recheck expiry after any workspace/membership lock wait. A failed
        // consume rolls the membership insert back in the same transaction.
        const consumed = await tx.workspaceInvitation.updateMany({
          where: {
            id: row.id,
            status: 'PENDING',
            email: user.__verifiedEmail,
            expiresAt: { gt: new Date() },
          },
          data: { status: 'ACCEPTED', acceptedBy: userKey, acceptedAt: new Date() },
        });
        if (consumed.count !== 1) throw new BadRequestException('Invitation is unavailable.');
        await this.audit(
          tx,
          row.workspaceId,
          user,
          AuditAction.CREATE,
          'invitation_acceptance',
          row.id,
        );
        return {
          workspace_id: row.workspaceId,
          role: membership.role.toLowerCase(),
          accepted: true,
        };
      },
    );
  }

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
}

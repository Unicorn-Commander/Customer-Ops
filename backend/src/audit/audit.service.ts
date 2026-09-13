import { Injectable, Logger } from '@nestjs/common';
import { AuditLog, Prisma, User } from '@prisma/client';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { WorkspaceTxClient } from '../prisma/prisma.service';
import { CreateAuditLogDto } from './dto/create-audit-log.dto';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

/**
 * The system audit trail — append-only `audit_logs`.
 *
 * WRITE (`log`): NEVER throws (audit must not break the request it records) and
 * is RLS-correct. Tenancy is LIVE (runtime = customer_ops_app, NOBYPASSRLS), so
 * the write MUST run inside the row's workspace GUC — `runInWorkspace` pins
 * `app.current_workspace` so the RLS WITH CHECK passes. A bare create under the
 * app role is rejected by WITH CHECK; the Project-Ops reference learned this the
 * hard way (bare creates silently dropped 0 rows for a day after its flip), so
 * we route through the GUC from day one and SKIP (not bare-create) a DTO with no
 * workspaceId rather than emit a row that would be rejected.
 *
 * READ: every query runs through `runForUser`, so the DB RLS GUC scopes it to the
 * caller's active workspace; all access goes through the passed `tx`.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly workspaces: WorkspaceContextService) {}

  /** Atomic audit for callers whose transaction must not commit without evidence. */
  logInTransaction(tx: WorkspaceTxClient, dto: CreateAuditLogDto) {
    if (!dto.workspaceId) throw new Error('Audit workspace required');
    return tx.auditLog.create({
      data: {
        workspaceId: dto.workspaceId,
        userId: dto.userId,
        action: dto.action,
        resource: dto.resource,
        resourceId: dto.resourceId,
        details: dto.details as Prisma.InputJsonValue,
        ipAddress: dto.ipAddress,
        userAgent: dto.userAgent,
      },
    });
  }

  /** Record one audit event. Never throws; returns null on any failure/skip. */
  async log(dto: CreateAuditLogDto): Promise<AuditLog | null> {
    try {
      if (!dto.workspaceId) {
        // No workspace to fence the row -> under live RLS a bare insert is
        // rejected by WITH CHECK. Don't pretend to write it; surface a warning.
        this.logger.warn(
          `Audit skipped (no workspaceId): ${dto.action} on ${dto.resource}` +
            (dto.resourceId ? ` ${dto.resourceId}` : ''),
        );
        return null;
      }

      const data: Prisma.AuditLogCreateInput = {
        workspaceId: dto.workspaceId,
        userId: dto.userId,
        action: dto.action,
        resource: dto.resource,
        resourceId: dto.resourceId,
        details: (dto.details ?? undefined) as Prisma.InputJsonValue | undefined,
        ipAddress: dto.ipAddress,
        userAgent: dto.userAgent,
      };

      return await this.workspaces.runInWorkspace(dto.workspaceId, dto.userId ?? '', (tx) =>
        tx.auditLog.create({ data }),
      );
    } catch (error) {
      // Audit logging must never break application flow.
      this.logger.error(
        `Failed to write audit log (${dto.action} on ${dto.resource})`,
        error as Error,
      );
      return null;
    }
  }

  /**
   * Paginated audit list for the caller's active workspace (newest first),
   * optionally filtered by action / resource.
   */
  async findForUser(
    user: AuthedUser,
    requestedWorkspaceId?: string | null,
    params?: {
      skip?: number;
      take?: number;
      action?: Prisma.AuditLogWhereInput['action'];
      resource?: string;
    },
  ): Promise<{ logs: AuditLog[]; total: number }> {
    const take = Math.min(Math.max(params?.take ?? 50, 1), 200);
    const skip = Math.max(params?.skip ?? 0, 0);
    const where: Prisma.AuditLogWhereInput = {};
    if (params?.action) where.action = params.action;
    if (params?.resource) where.resource = params.resource;

    return this.workspaces.runForUser(
      user,
      async (tx) => {
        const [logs, total] = await Promise.all([
          tx.auditLog.findMany({ where, orderBy: { timestamp: 'desc' }, skip, take }),
          tx.auditLog.count({ where }),
        ]);
        return { logs, total };
      },
      requestedWorkspaceId,
    );
  }

  /** Audit history for one target entity (e.g. a customer), newest first. */
  async findByResource(
    user: AuthedUser,
    resource: string,
    resourceId: string,
    requestedWorkspaceId?: string | null,
    limit = 50,
  ): Promise<AuditLog[]> {
    return this.workspaces.runForUser(
      user,
      (tx) =>
        tx.auditLog.findMany({
          where: { resource, resourceId },
          orderBy: { timestamp: 'desc' },
          take: Math.min(Math.max(limit, 1), 200),
        }),
      requestedWorkspaceId,
    );
  }
}

import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Param,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, User } from '@prisma/client';
import { IsString, IsUUID, Length } from 'class-validator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtOnly } from '../../auth/decorators/jwt-only.decorator';
import { CurrentUser } from '../decorators/current-user.decorator';
import { BrigadeTokenSource } from '../federation/brigade-token-source';
import { FederationWorkspaceMapService } from '../federation/federation-workspace-map.service';
import { ContactOpsOrgLookupClient } from '../../contact-ops/contact-ops-org-lookup.client';
import { canonicalTenantId, sameTenant } from '../../contact-ops/tenant-id';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipService } from './membership.service';
import { tenancyEnabled } from './feature-flags';
import { OnboardingSessionGuard } from './workspace-onboarding.controller';

export class ConnectContactDto {
  @IsUUID() target_workspace_id!: string;
  @IsString() @Length(20, 16000) contact_owner_token!: string;
}

@Controller('workspaces/:workspaceId/contact-connection')
@JwtOnly()
@UseGuards(JwtAuthGuard, OnboardingSessionGuard)
export class ContactLinkController {
  constructor(
    private readonly membership: MembershipService,
    private readonly prisma: PrismaService,
    private readonly brigade: BrigadeTokenSource,
    private readonly config: ConfigService,
    private readonly mapping: FederationWorkspaceMapService,
    private readonly lookup: ContactOpsOrgLookupClient,
  ) {}

  @Post()
  async connect(
    @CurrentUser() user: User,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ConnectContactDto,
  ) {
    const ownerBearer = dto.contact_owner_token;
    dto.contact_owner_token = '';
    if (!tenancyEnabled())
      throw new ForbiddenException('Contact connections require tenancy enforcement.');
    await this.membership.assertOwner(user, workspaceId);
    const sourceWorkspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!sourceWorkspace || sourceWorkspace.status !== 'active')
      throw new ForbiddenException('Active workspace required.');
    const target = canonicalTenantId(dto.target_workspace_id);
    const where = {
      localWorkspaceId_targetApp: { localWorkspaceId: workspaceId, targetApp: 'contact-ops' },
    };
    const existing = await this.prisma.federationWorkspaceMap.findUnique({ where });
    // A row that differs is replaced only when it is MARKED in conflict (R4-1):
    // the lookup below must then name exactly this target, and a person (this
    // owner) chose it. An unmarked row is never silently re-pointed.
    const repairFrom =
      existing && !sameTenant(existing.targetWorkspaceId, target)
        ? existing.targetWorkspaceId
        : null;
    if (repairFrom && !existing!.conflictTenantId) {
      throw new ConflictException(
        'An existing Contact connection cannot be replaced by this action.',
      );
    }
    const base = this.config.get<string>('CONTACT_OPS_BASE_URL')?.trim();
    if (!base || new URL(base).protocol !== 'https:') {
      throw new ServiceUnavailableException(
        'A trusted HTTPS Contact-Ops endpoint must be configured.',
      );
    }
    // Same-org rule (R3-2, GATE-175): a contact-ops row is written only for the
    // tenant Contact-Ops' org lookup names for THIS workspace's org id (contract
    // D: the workspace id is the org id). Checked before any remote call.
    const answer = await this.lookup.lookupTenant(workspaceId);
    if (answer.kind === 'dormant') {
      throw new ConflictException('Contact-Ops link is not available yet');
    }
    if (answer.kind !== 'tenant' || !sameTenant(answer.tenantId, target)) {
      throw new ConflictException(
        'Contact-Ops does not confirm this tenant for this workspace; no Customer connection was changed.',
      );
    }
    const proof = await this.brigade.exchangedToken({
      audience: 'contact-ops',
      scope: 'contacts:read',
      workspaceId: target,
    });
    if (!proof)
      throw new ServiceUnavailableException(
        'Could not obtain the registered Customer-Ops reader proof.',
      );
    let grant: { tenant_id?: string; role?: string; client_id?: string; service_subject?: string };
    try {
      const response = await fetch(base.replace(/\/$/, '') + '/mcp', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${ownerBearer}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'owner-contact-connection',
          method: 'tools/call',
          params: { name: 'connect_customer_ops_reader', arguments: { reader_proof: proof } },
        }),
      });
      if (!response.ok) throw new Error('Remote authorization failed');
      const envelope = await response.json();
      if (envelope.error || envelope.result?.isError)
        throw new Error('Remote authorization failed');
      grant = envelope.result?.structuredContent;
      if (
        !grant ||
        !sameTenant(grant.tenant_id, target) ||
        grant.role !== 'viewer' ||
        grant.client_id !== 'customer-ops' ||
        !grant.service_subject
      ) {
        throw new Error('Unexpected owner approval');
      }
    } catch {
      throw new ForbiddenException(
        'Contact workspace owner approval failed; no Customer connection was changed.',
      );
    } finally {
      // The target bearer is used only for this request and is never persisted or audited.
      dto.contact_owner_token = '';
    }
    const ownerKey = MembershipService.membershipKey(user);
    await this.prisma.withWorkspace(workspaceId, ownerKey, async (tx) => {
      await tx.$queryRaw`SELECT "userKey" FROM memberships WHERE "userKey"=${ownerKey} AND "workspaceId"=${workspaceId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM workspaces WHERE id=${workspaceId} FOR SHARE`;
      const currentWorkspace = await tx.workspace.findUnique({ where: { id: workspaceId } });
      if (!currentWorkspace || currentWorkspace.status !== 'active')
        throw new ForbiddenException('Active workspace required.');
      const owner = await tx.membership.findUnique({
        where: { userKey_workspaceId: { userKey: ownerKey, workspaceId } },
      });
      if (!owner || owner.role !== 'OWNER' || owner.status !== 'ACTIVE')
        throw new ForbiddenException('Active workspace owner required.');
      // Serialize competing target connections and refuse an implicit overwrite.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId + ':contact-ops'}))`;
      const current = await tx.federationWorkspaceMap.findUnique({ where });
      const currentTarget = current?.targetWorkspaceId ?? null;
      // Proceed only over the row as it was checked: absent, already this
      // target, or the same conflicted row the lookup has just overruled.
      const stillAsChecked =
        sameTenant(currentTarget, target) ||
        (currentTarget === null
          ? repairFrom === null
          : currentTarget === repairFrom && !!current!.conflictTenantId);
      if (!stillAsChecked) throw new ConflictException('Contact connection changed concurrently.');
      await tx.federationWorkspaceMap.upsert({
        where,
        create: {
          localWorkspaceId: workspaceId,
          targetApp: 'contact-ops',
          targetWorkspaceId: target,
        },
        // The lookup just confirmed this tenant for this org: the row points at
        // it (a conflicted row is re-pointed) and any conflict mark is cleared.
        update: { targetWorkspaceId: target, conflictTenantId: null },
      });
      await tx.auditLog.create({
        data: {
          workspaceId,
          userId: ownerKey,
          action: AuditAction.UPDATE,
          resource: 'contact_connection',
          resourceId: target,
          details: {
            targetApp: 'contact-ops',
            targetWorkspaceId: target,
            ...(repairFrom ? { repairedConflictFrom: repairFrom } : {}),
            serviceSubject: grant.service_subject!,
            role: 'viewer',
          },
        },
      });
    });
    await this.mapping.reload();
    return {
      workspace_id: workspaceId,
      target_workspace_id: target,
      target_app: 'contact-ops',
      role: 'viewer',
    };
  }
}

/**
 * The GDPR data-lifecycle REST surface (right-to-erasure + right-to-portability
 * + workspace offboarding + the retention setting/sweep).
 *
 * Mounted under the workspace-scoped path `…/workspaces/:workspaceId/gdpr`. Both
 * the JwtAuthGuard (authn) and the WorkspaceMembershipGuard (authz: membership-
 * gated when tenancy is live) apply, and EVERY route is:
 *   - @JwtOnly() — SESSION-ONLY. These are the most consequential actions in the
 *     app (erase a subject, export all PII, wipe a workspace). A leaked Personal
 *     Access Token must NOT be able to reach them — they require the human SSO
 *     session, exactly like the member-management + PAT-management routes. (With
 *     no @RequireScopes a PAT is already deny-by-default; @JwtOnly makes the
 *     session requirement explicit + returns a clear 403.)
 *   - OWNER-gated in the service (MembershipService.assertOwner).
 *
 * Every erasure writes an AuditAction.DELETE row and every export an
 * AuditAction.EXPORT row through the append-only trail.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtOnly } from '../auth/decorators/jwt-only.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { MembershipService } from '../common/workspace/membership.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { GdprService } from './gdpr.service';
import { RetentionSweepService } from './retention-sweep.service';
import { OffboardWorkspaceDto, SetRetentionDto } from './dto/gdpr.dto';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

@ApiTags('gdpr')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
@JwtOnly()
@Controller('workspaces/:workspaceId/gdpr')
export class GdprController {
  constructor(
    private readonly gdpr: GdprService,
    private readonly sweep: RetentionSweepService,
    private readonly membership: MembershipService,
  ) {}

  // ── right to portability ──────────────────────────────────────────────────

  @Get('export')
  @ApiOperation({
    summary: 'Export the whole workspace CRM as portable JSON (owner-only; audited EXPORT).',
  })
  async exportWorkspace(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.gdpr.exportWorkspaceForUser(user, workspaceId);
  }

  @Get('customers/:id/export')
  @ApiOperation({
    summary: 'Export one data subject (customer) as portable JSON (owner-only; audited EXPORT).',
  })
  async exportCustomer(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.gdpr.exportCustomerForUser(user, workspaceId, id);
  }

  // ── right to erasure ──────────────────────────────────────────────────────

  @Post('customers/:id/erase')
  @ApiOperation({
    summary:
      'Erase one data subject: remove the relationship + PII from Postgres, clean the ' +
      'FalkorDB subgraph, and write a DELETE audit row (owner-only).',
  })
  async eraseCustomer(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.gdpr.eraseCustomerForUser(user, workspaceId, id);
  }

  // ── workspace offboarding ─────────────────────────────────────────────────

  @Post('offboard')
  @ApiOperation({
    summary:
      'Offboard the whole workspace: delete (default) or anonymize all CRM data + drop the ' +
      'FalkorDB graph (owner-only; audited DELETE).',
  })
  async offboard(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: OffboardWorkspaceDto,
  ) {
    return this.gdpr.offboardWorkspaceForUser(user, workspaceId, dto.mode ?? 'delete');
  }

  // ── retention setting + sweep ─────────────────────────────────────────────

  @Patch('retention')
  @ApiOperation({ summary: 'Set/clear the workspace data-retention window in days (owner-only).' })
  async setRetention(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SetRetentionDto,
  ) {
    return this.gdpr.setRetentionForUser(user, workspaceId, dto.retentionDays);
  }

  @Post('retention/sweep')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Run the dormant-record retention sweep for THIS workspace now (owner-only). No-op ' +
      'unless CUSTOMER_OPS_RETENTION_SWEEP_ENABLED is on AND a retention window is set.',
  })
  async runSweep(@CurrentUser() user: AuthedUser, @Param('workspaceId') workspaceId: string) {
    // Owner-gate before triggering (the sweep itself is a system job that skips
    // authz + writes its own per-customer DELETE audit rows). No-op unless the
    // master flag is on AND this workspace has a retention window.
    await this.membership.assertOwner(user, workspaceId);
    const purged = await this.sweep.sweepWorkspace(workspaceId);
    return { workspace_id: workspaceId, customers_purged: purged };
  }
}

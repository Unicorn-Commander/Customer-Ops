/**
 * The Relations Officer chat orchestrator REST surface.
 *
 * Mounted under the workspace-scoped path (`…/workspaces/:workspaceId/relations-
 * officer/*`), guarded by exactly the same pair the agents/customers cockpit uses:
 * JwtAuthGuard (authn) + WorkspaceMembershipGuard (authz: membership-gated when
 * tenancy is live, so it runs inside the RLS transaction with the right RBAC).
 *
 * Two routes:
 *   - POST /chat            — converse, grounded in the workspace; in operator mode
 *                             it may PROPOSE one confirm-gated relationship write.
 *   - POST /confirm-action  — confirm/cancel a single-use pending write; on confirm
 *                             it executes AS the user via CustomersService (audited).
 *
 * The controller is thin: it forwards the verified `@CurrentUser()` + the
 * `:workspaceId` param (the §D4 addressing precedence) to the service, which owns
 * the persona, grounding, validation, the single-use pending store, and execution.
 */

import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User, WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireScopes } from '../auth/decorators/require-scopes.decorator';
import { RequireWorkspaceRole } from '../auth/decorators/require-workspace-role.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { WorkspaceRoleGuard } from '../common/workspace/workspace-role.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { RelationsOfficerService } from './relations-officer.service';
import { RelationsOfficerChatDto, RelationsOfficerConfirmDto } from './dto/relations-officer.dto';
import {
  RelationsOfficerChatResult,
  RelationsOfficerConfirmResult,
} from './relations-officer.types';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

@ApiTags('relations-officer')
@ApiBearerAuth()
// authn → membership authz → role RBAC. Both routes mutate/agent-run, so each
// requires MEMBER — a VIEWER member is 403'd before the orchestrator is reached.
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard, WorkspaceRoleGuard)
@Controller('workspaces/:workspaceId/relations-officer')
export class RelationsOfficerController {
  constructor(private readonly relationsOfficer: RelationsOfficerService) {}

  @Post('chat')
  @ApiOperation({
    summary:
      'Talk to the Relations Officer (the orchestrator persona), grounded in the ' +
      'workspace. advisor mode reads + recommends; operator mode may PROPOSE one ' +
      'relationship write (transition/note/mark-lost/reopen) for you to confirm. ' +
      'Never executes here; degrade-clean when inference is not connected.',
  })
  @RequireScopes('run:agents')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  async chat(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: RelationsOfficerChatDto,
  ): Promise<RelationsOfficerChatResult> {
    return this.relationsOfficer.chat(user, workspaceId, {
      messages: dto.messages,
      mode: dto.mode,
      customerId: dto.customerId ?? null,
    });
  }

  @Post('confirm-action')
  @ApiOperation({
    summary:
      'Confirm or cancel a single-use pending write the Relations Officer proposed. ' +
      'On confirm it executes AS you via the matching relationship write (audited via ' +
      'a customer activity); on cancel/expired/missing nothing is changed.',
  })
  @RequireScopes('write:customers')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  async confirmAction(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: RelationsOfficerConfirmDto,
  ): Promise<RelationsOfficerConfirmResult> {
    return this.relationsOfficer.confirmAction(user, workspaceId, {
      actionId: dto.actionId,
      decision: dto.decision,
    });
  }
}

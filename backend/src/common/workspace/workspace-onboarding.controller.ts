import {
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsEmail, IsEnum, IsInt, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtOnly } from '../../auth/decorators/jwt-only.decorator';
import { CurrentUser } from '../decorators/current-user.decorator';
import { InvitationUser, WorkspaceInvitationsService } from './workspace-invitations.service';

/** Defense after authentication, including already-resolved PAT principals. */
@Injectable()
export class OnboardingSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (
      req.pat ||
      req.user?.__humanSession !== true ||
      /^Bearer\s+co_pat_/i.test(req.headers?.authorization || '')
    ) {
      throw new ForbiddenException('Sign in with your browser session to manage onboarding.');
    }
    return true;
  }
}

export class NewWorkspaceDto {
  @IsUUID() request_id!: string;
  @IsUUID() source_workspace_id!: string;
  @IsString() @Length(1, 100) display_name!: string;
}
export class ManualInvitationDto {
  @IsEmail() @Length(3, 254) email!: string;
  @IsEnum(WorkspaceRole) role: WorkspaceRole = WorkspaceRole.MEMBER;
  @IsInt() @Min(1) @Max(168) expires_in_hours = 72;
}
export class AcceptInvitationDto {
  @IsString() @Length(43, 43) token!: string;
}

@Controller('workspace-onboarding')
@JwtOnly()
@UseGuards(JwtAuthGuard, OnboardingSessionGuard)
export class WorkspaceOnboardingController {
  constructor(private readonly invitations: WorkspaceInvitationsService) {}

  @Post('workspaces')
  createWorkspace(@CurrentUser() user: InvitationUser, @Body() dto: NewWorkspaceDto) {
    const name = dto.display_name.trim();
    if (!name) throw new ForbiddenException('Workspace name required.');
    return this.invitations.createWorkspace(user, dto.source_workspace_id, name, dto.request_id);
  }

  @Post('workspaces/:workspaceId/invitations')
  create(
    @CurrentUser() user: InvitationUser,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ManualInvitationDto,
  ) {
    return this.invitations.create(user, workspaceId, dto.email, dto.role, dto.expires_in_hours);
  }

  @Get('workspaces/:workspaceId/invitations')
  list(@CurrentUser() user: InvitationUser, @Param('workspaceId') workspaceId: string) {
    return this.invitations.list(user, workspaceId);
  }

  @Delete('workspaces/:workspaceId/invitations/:id')
  revoke(
    @CurrentUser() user: InvitationUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.invitations.revoke(user, workspaceId, id);
  }

  @Post('invitations/accept')
  accept(@CurrentUser() user: InvitationUser, @Body() dto: AcceptInvitationDto) {
    return this.invitations.accept(user, dto.token);
  }
}

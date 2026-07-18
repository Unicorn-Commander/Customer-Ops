/**
 * M365 connector management routes (the cockpit's connect card talks to these).
 *
 *   GET    /m365/status      → { configured, connected, connection? } (read:leads)
 *   POST   /m365/sync        → pull contacts → funnel through lead-intake (write:leads)
 *   DELETE /m365/connection  → disconnect (delete the stored credential) (write:leads)
 *
 * All are JwtAuthGuard'd and resolve the caller's active workspace server-side
 * (the connection is bound to (userId, workspaceId)); there is no workspace path
 * param because a connection is account-linking, not a workspace resource. The
 * status route stays HONEST when the connector is dormant: `{configured:false}`.
 */

import {
  Controller,
  Delete,
  Get,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User, WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequireScopes } from '../../auth/decorators/require-scopes.decorator';
import { RequireWorkspaceRole } from '../../auth/decorators/require-workspace-role.decorator';
import { WorkspaceRoleGuard } from '../../common/workspace/workspace-role.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WorkspaceContextService } from '../../common/workspace/workspace-context.service';
import { WithWorkspaceClaim } from '../../common/workspace/workspace.util';
import { M365Config } from '../m365.config';
import { M365ConnectionStore } from '../store/m365-connection.store';
import { M365SyncService } from './m365-sync.service';
import { M365ConnectionView, M365SyncResult } from '../m365.types';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

interface M365StatusResponse {
  configured: boolean;
  connected: boolean;
  connection: M365ConnectionView | null;
}

@ApiTags('m365')
@ApiBearerAuth()
@Controller('m365')
export class M365SyncController {
  constructor(
    private readonly config: M365Config,
    private readonly workspaces: WorkspaceContextService,
    private readonly store: M365ConnectionStore,
    private readonly sync: M365SyncService,
  ) {}

  /**
   * The connect card's status read. ALWAYS 200. When the connector is dormant
   * (no M365_CLIENT_ID) it reports `{configured:false}` so the SPA renders the
   * disabled "not configured on this deployment" state cleanly.
   */
  @Get('status')
  @UseGuards(JwtAuthGuard)
  @RequireScopes('read:leads')
  @ApiOperation({ summary: 'Microsoft 365 connector status for the current user' })
  @ApiResponse({ status: 200, description: 'Configured/connected state + connection metadata' })
  async status(@CurrentUser() user: AuthedUser): Promise<M365StatusResponse> {
    if (!this.config.isConfigured) {
      return { configured: false, connected: false, connection: null };
    }
    const workspaceId = await this.workspaces.resolveAuthorized(user);
    const conn = await this.store.findForUser(user.id, workspaceId);
    return {
      configured: true,
      connected: !!conn,
      connection: conn ? this.store.toView(conn) : null,
    };
  }

  /** Pull the user's contacts and funnel them through lead-intake. */
  @Post('sync')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireScopes('write:leads')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  @ApiOperation({ summary: 'Sync Microsoft 365 contacts into the lead pipeline' })
  @ApiResponse({ status: 200, description: 'The sync outcome (seen/ingested/failed counts)' })
  @ApiResponse({ status: 503, description: 'Microsoft 365 is not configured / not connected' })
  async runSync(@CurrentUser() user: AuthedUser): Promise<M365SyncResult> {
    this.requireConfigured();
    const workspaceId = await this.workspaces.resolveAuthorized(user);
    const conn = await this.store.findForUser(user.id, workspaceId);
    if (!conn) {
      throw new ServiceUnavailableException(
        'Microsoft 365 is not connected for this user/workspace.',
      );
    }
    return this.sync.syncContacts(user, conn);
  }

  /** Disconnect — delete the stored credential. Idempotent. */
  @Delete('connection')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireScopes('write:leads')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  @ApiOperation({ summary: 'Disconnect Microsoft 365 (delete the stored credential)' })
  @ApiResponse({ status: 200, description: 'Disconnected (or already disconnected — idempotent)' })
  async disconnect(@CurrentUser() user: AuthedUser): Promise<{ disconnected: boolean }> {
    this.requireConfigured();
    const workspaceId = await this.workspaces.resolveAuthorized(user);
    const removed = await this.store.deleteForUser(user.id, workspaceId);
    return { disconnected: removed };
  }

  private requireConfigured(): void {
    if (!this.config.isConfigured) {
      throw new ServiceUnavailableException(
        'Microsoft 365 is not configured on this deployment (M365_CLIENT_ID is unset).',
      );
    }
  }
}

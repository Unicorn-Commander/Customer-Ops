import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireScopes } from '../auth/decorators/require-scopes.decorator';
import { RequireWorkspaceRole } from '../auth/decorators/require-workspace-role.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { WorkspaceRoleGuard } from '../common/workspace/workspace-role.guard';
import { QuotesService } from './quotes.service';
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard, WorkspaceRoleGuard)
@Controller('quotes')
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}
  @Get()
  @RequireScopes('read:quotes')
  list(@Req() req: any, @Query() args: any) {
    return this.quotes.execute(req.user, req.workspaceId, 'list_quotes', args);
  }
  @Get('price-book')
  @RequireScopes('read:quotes')
  priceBook(@Req() req: any) {
    return this.quotes.execute(req.user, req.workspaceId, 'list_price_book');
  }
  @Get(':id')
  @RequireScopes('read:quotes')
  get(@Req() req: any, @Param('id') id: string) {
    return this.quotes.execute(req.user, req.workspaceId, 'get_quote', { quote_id: id });
  }
  @Post('')
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  create(
    @Req() req: any,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() data: unknown,
  ) {
    return this.quotes.execute(req.user, req.workspaceId, 'create_quote', {
      quote_id: id,
      line_id: lineId,
      data,
    });
  }
  @Patch(':id')
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  update(
    @Req() req: any,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() data: unknown,
  ) {
    return this.quotes.execute(req.user, req.workspaceId, 'update_quote', {
      quote_id: id,
      line_id: lineId,
      data,
    });
  }
  @Post(':id/sections')
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  section(
    @Req() req: any,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() data: unknown,
  ) {
    return this.quotes.execute(req.user, req.workspaceId, 'add_quote_section', {
      quote_id: id,
      line_id: lineId,
      data,
    });
  }
  @Post(':id/lines')
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  line(
    @Req() req: any,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() data: unknown,
  ) {
    return this.quotes.execute(req.user, req.workspaceId, 'add_quote_line', {
      quote_id: id,
      line_id: lineId,
      data,
    });
  }
  @Patch(':id/lines/:lineId')
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  updateLine(
    @Req() req: any,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() data: unknown,
  ) {
    return this.quotes.execute(req.user, req.workspaceId, 'update_quote_line', {
      quote_id: id,
      line_id: lineId,
      data,
    });
  }
  @Delete(':id/lines/:lineId')
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  removeLine(
    @Req() req: any,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() data: unknown,
  ) {
    return this.quotes.execute(req.user, req.workspaceId, 'remove_quote_line', {
      quote_id: id,
      line_id: lineId,
      data,
    });
  }
  @Post(':id/options')
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  options(
    @Req() req: any,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() data: unknown,
  ) {
    return this.quotes.execute(req.user, req.workspaceId, 'set_quote_options', {
      quote_id: id,
      line_id: lineId,
      data,
    });
  }
  @Post(':id/recipients')
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  recipients(
    @Req() req: any,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() data: unknown,
  ) {
    return this.quotes.execute(req.user, req.workspaceId, 'set_quote_recipients', {
      quote_id: id,
      line_id: lineId,
      data,
    });
  }
  @Post(':id/costs')
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  cost(
    @Req() req: any,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() data: unknown,
  ) {
    return this.quotes.execute(req.user, req.workspaceId, 'add_quote_cost', {
      quote_id: id,
      line_id: lineId,
      data,
    });
  }
  @Post(':id/attachments')
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  attachment(
    @Req() req: any,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() data: unknown,
  ) {
    return this.quotes.execute(req.user, req.workspaceId, 'add_quote_attachment', {
      quote_id: id,
      line_id: lineId,
      data,
    });
  }
}

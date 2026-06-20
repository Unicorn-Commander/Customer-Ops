import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { User } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { PAT_AVAILABLE_SCOPES } from './pat.constants';
import { CreatePatDto } from './dto/create-pat.dto';
import { PatService } from './pat.service';

/**
 * Personal Access Token routes (Customer-Ops, `co_pat_`).
 *
 * Every route is JWT-only — you cannot mint or revoke a PAT WITH a PAT. That's
 * deliberate: losing a PAT must not let an attacker self-rotate into a fresh one
 * without going through the browser SSO session.
 */
@ApiTags('auth')
@Controller('auth/pats')
export class PatController {
  constructor(private readonly pats: PatService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ short: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Mint a new Personal Access Token for the current user',
    description:
      'The plaintext token is returned ONCE in the response — never again. The caller MUST show it and tell the user to copy it now.',
  })
  @ApiResponse({ status: 201, description: 'Token created. Plaintext returned exactly once.' })
  @ApiResponse({ status: 400, description: 'Invalid name, scopes, or expiresAt' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  async create(@CurrentUser() user: User, @Body() dto: CreatePatDto) {
    return this.pats.create(user, {
      name: dto.name,
      scopes: dto.scopes,
      workspaceId: dto.workspaceId ?? null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the current user's Personal Access Tokens (metadata only)" })
  @ApiResponse({ status: 200, description: 'Token metadata array. No plaintext, no hash.' })
  async list(@CurrentUser() user: User) {
    return this.pats.list(user.id);
  }

  @Get('scopes')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List the scopes the user can grant to a PAT' })
  async scopes() {
    return { scopes: PAT_AVAILABLE_SCOPES };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a Personal Access Token' })
  @ApiResponse({ status: 204, description: 'Revoked (or already revoked — idempotent)' })
  @ApiResponse({ status: 404, description: 'Token not found or not owned by caller' })
  async revoke(@CurrentUser() user: User, @Param('id') id: string) {
    await this.pats.revoke(user.id, id);
  }
}

import {
  BadRequestException,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  NotFoundException,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ServiceCallerGuard } from './home-summary.caller';
import { homeSummaryEnabled } from './home-summary.config';
import { HomeSummaryService } from './home-summary.service';

/**
 * HOME_SUMMARY_ENABLED is checked BEFORE auth: off means the route 404s as if it
 * did not exist — never a 401, never the flag's state revealed to a caller.
 */
@Injectable()
export class HomeSummaryFlagGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(_context: ExecutionContext): boolean {
    if (!homeSummaryEnabled(this.config)) throw new NotFoundException();
    return true;
  }
}

export interface HomeSummaryQuery {
  email?: string;
  workspace?: string;
  org?: string;
  sub?: string;
}

/**
 * GET /api/v1/home-summary — read-only HOME-SUMMARY CONTRACT v1.
 *
 * GET only; no write, no mail, no money. The only side effect is one audit line.
 *
 * Deliberately NOT behind JwtAuthGuard: that guard's strategy resolves — or, in
 * open mode, JIT-provisions — a User row per token, and the Ops-Center Home
 * caller is a client_credentials service account with no user and no email.
 * HomeSummaryFlagGuard runs first (flag off => 404 before any auth), then
 * ServiceCallerGuard verifies the service token itself against the existing
 * realm JWKS + realm issuer and the caller fence; the PERSON comes from `email`.
 */
@ApiTags('home-summary')
@ApiBearerAuth()
@Controller('home-summary')
@UseGuards(HomeSummaryFlagGuard, ServiceCallerGuard)
export class HomeSummaryController {
  constructor(
    private readonly summary: HomeSummaryService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Read-only Ops-Center Home summary for one named person (service-account caller only).',
  })
  @ApiQuery({ name: 'email', required: true, description: 'The person email in this app.' })
  @ApiQuery({ name: 'workspace', required: true, description: "This app's workspace/org id." })
  @ApiQuery({ name: 'org', required: false, description: 'Ops-Center org id (informational).' })
  @ApiQuery({ name: 'sub', required: false, description: 'Ops-Center sub (informational only).' })
  async home(@Req() request: { homeCallerAzp?: string }, @Query() query: HomeSummaryQuery) {
    if (!homeSummaryEnabled(this.config)) {
      // As if the route did not exist (double-checked in the service too).
      throw new NotFoundException();
    }
    const email = (query.email ?? '').trim().toLowerCase();
    const workspace = (query.workspace ?? '').trim();
    if (!email || !workspace) {
      // The service token ALONE never sees data: no email/workspace -> 400.
      throw new BadRequestException({
        error: 'email_and_workspace_required',
        message: 'email and workspace are required; the answer is always for one named person.',
      });
    }
    return this.summary.forPerson({
      email,
      workspace,
      azp: request.homeCallerAzp ?? '',
    });
  }
}

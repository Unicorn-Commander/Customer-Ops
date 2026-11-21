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
  Type,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import * as jsonwebtoken from 'jsonwebtoken';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireScopes } from '../auth/decorators/require-scopes.decorator';
import { JwtOnly } from '../auth/decorators/jwt-only.decorator';
import { callerNotAllowed, isHomeCaller, VerifiedTokenClaims } from './home-summary.caller';
import { homeCallerClientId, homeSummaryEnabled } from './home-summary.config';
import { HomeSummaryService } from './home-summary.service';

/**
 * The caller fence, as a guard. Runs AFTER JwtAuthGuard (which has already
 * verified the token's signature + issuer against the app's existing JWKS — no new
 * trust root) and re-reads that verified bearer's claims to enforce
 * `azp == HOME_CALLER_CLIENT_ID` + a client_credentials shape.
 *
 * Why decode rather than inject the payload: the app's JwtStrategy intentionally
 * resolves a User row from the token (it is person-centric), so a service token
 * has no User to hand on. The signature is already verified by the time this guard
 * runs — decoding cannot invent trust it did not have. `exp` is re-checked here so
 * the fence stands on its own even if the strategy's opinion changed.
 */
@Injectable()
export class ServiceCallerGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    /** Test seam: default decodes the bearer that reached this guard. */
    private readonly decode: (request: any) => VerifiedTokenClaims | undefined = defaultDecode,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const claims = this.decode(request);
    if (!isHomeCaller(claims, homeCallerClientId(this.config))) {
      throw callerNotAllowed();
    }
    const exp = claims?.exp;
    if (typeof exp !== 'number' || exp * 1000 <= Date.now()) {
      throw callerNotAllowed();
    }
    // Stash the (already verified) caller azp for the audit line; never the token.
    request.homeCallerAzp = String((claims as VerifiedTokenClaims).azp);
    return true;
  }
}

function defaultDecode(request: any): VerifiedTokenClaims | undefined {
  const header = request?.headers?.authorization ?? request?.headers?.Authorization;
  if (typeof header !== 'string') return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) return undefined;
  const decoded = jsonwebtoken.decode(token);
  return decoded && typeof decoded === 'object' ? (decoded as VerifiedTokenClaims) : undefined;
}

/** Nest DI factory for the service caller guard (pins an optional decoder seam). */
export function serviceCallerGuard(
  config: ConfigService,
  decode?: (request: any) => VerifiedTokenClaims | undefined,
): ServiceCallerGuard {
  return new ServiceCallerGuard(config, decode);
}

/** The guard class the controller binds (DI-resolved ConfigService). */
export const CallerGuard: Type<CanActivate> = ServiceCallerGuard;

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
 * The flag is read per request so it can be flipped without a restart; off means
 * a 404, exactly as if the route were not registered.
 */
@ApiTags('home-summary')
@ApiBearerAuth()
@Controller('home-summary')
@UseGuards(JwtAuthGuard, ServiceCallerGuard)
@JwtOnly()
@RequireScopes()
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
      // As if the route did not exist.
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

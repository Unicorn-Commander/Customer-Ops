import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { randomBytes } from 'crypto';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RequireScopes } from './decorators/require-scopes.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { listMyWorkspaces } from '../common/workspace/list-my-workspaces';

/**
 * The lifetime of an SSO exchange code. Deliberately tiny: the code lives only
 * for the round-trip between the Keycloak callback redirect and the SPA's
 * immediate POST exchange. 60s comfortably covers a browser redirect + one fetch
 * while keeping the replay window negligible.
 */
const SSO_CODE_TTL_MS = 60_000;

/**
 * In-memory, single-use exchange-code store (the OAuth authorization-code
 * pattern, applied to our own SSO leg).
 *
 * WHY: the Keycloak callback used to redirect the browser with the full session
 * JWT in the URL query (`/auth/sso-callback?token=<JWT>`). A URL is the WORST
 * place for a bearer secret — it lands in the reverse-proxy / Next access logs,
 * in `Referer` headers to any resource the callback page loads, and in browser
 * history. Instead we redirect with an opaque, short-lived, single-use CODE that
 * carries no authority on its own; the SPA immediately POSTs it back and we hand
 * the real session token over the response BODY, which is never logged.
 *
 * The store is a process-local Map. Customer-Ops runs a single backend replica
 * (see deploy/docker-compose.prod.yml — no `replicas`), so the callback and the
 * exchange always hit the same process. If the backend is ever horizontally
 * scaled, this must move to a shared store (Redis) or a stateless signed code.
 */
class SsoExchangeCodeStore {
  private readonly codes = new Map<string, { token: string; expiresAt: number }>();

  /** Mint a code bound to a session token. Returns the opaque code to redirect with. */
  issue(token: string, now: number = Date.now()): string {
    this.sweep(now);
    // 32 random bytes → 256 bits of entropy, base64url (URL-safe, no padding).
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, { token, expiresAt: now + SSO_CODE_TTL_MS });
    return code;
  }

  /**
   * Redeem a code EXACTLY once. Returns the bound token, or null if the code is
   * unknown, already redeemed, or expired. Deletion-on-read guarantees single
   * use even under a race (the second reader sees the already-deleted entry).
   */
  redeem(code: string, now: number = Date.now()): string | null {
    const entry = this.codes.get(code);
    if (!entry) return null;
    // Consume regardless of expiry — a redeemed OR expired code is dead either way.
    this.codes.delete(code);
    if (entry.expiresAt <= now) return null;
    return entry.token;
  }

  /** Drop expired entries so a burst of un-redeemed codes can't grow unbounded. */
  private sweep(now: number): void {
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt <= now) this.codes.delete(code);
    }
  }
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  /**
   * Single-use exchange codes for the SSO return leg (see SsoExchangeCodeStore).
   * The controller is a singleton (default Nest scope), so this Map persists
   * across the callback→exchange request pair for the lifetime of the process.
   */
  private readonly ssoCodes = new SsoExchangeCodeStore();

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly membership: MembershipService,
  ) {}

  @Get('keycloak')
  @UseGuards(AuthGuard('keycloak'))
  @ApiOperation({ summary: 'Redirect to Keycloak SSO login (uchub realm)' })
  @ApiResponse({ status: 302, description: 'Redirects to Keycloak login page' })
  async keycloakLogin() {
    // Passport handles the redirect to Keycloak.
  }

  @Get('keycloak/callback')
  @UseGuards(AuthGuard('keycloak'))
  @ApiOperation({ summary: 'Keycloak OAuth callback (uchub realm)' })
  @ApiResponse({ status: 302, description: 'Redirects to the frontend with a single-use exchange code' })
  async keycloakCallback(@Req() req: any, @Res() res: any) {
    const tokenData = await this.authService.generateTokenForUser(req.user);
    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'https://customerops.unicorncommander.ai',
    );
    // Never redirect with the session JWT in the URL (it would leak into proxy /
    // Next access logs, Referer headers, and browser history). Instead redirect
    // with a short-lived, single-use code that the SPA immediately exchanges for
    // the real token over POST — the token rides only the response body.
    const code = this.ssoCodes.issue(tokenData.access_token);
    return res.redirect(`${frontendUrl}/auth/sso-callback?code=${encodeURIComponent(code)}`);
  }

  @Post('sso/exchange')
  @ApiOperation({
    summary: 'Exchange a single-use SSO code for the session token',
    description:
      'The SPA POSTs the `code` it received on the Keycloak callback redirect and ' +
      'receives the session JWT in the response body. The code is single-use and ' +
      'expires within seconds — a redeemed, unknown, or expired code returns 400.',
  })
  @ApiResponse({ status: 201, description: 'Returns the session access token' })
  @ApiResponse({ status: 400, description: 'The code is missing, unknown, already used, or expired' })
  async ssoExchange(@Body() body: { code?: unknown }) {
    const code = typeof body?.code === 'string' ? body.code : '';
    if (!code) {
      throw new BadRequestException('Missing SSO exchange code');
    }
    const accessToken = this.ssoCodes.redeem(code);
    if (!accessToken) {
      // Uniform error for unknown / already-redeemed / expired — never reveal which.
      throw new BadRequestException('Invalid or expired SSO exchange code');
    }
    return { access_token: accessToken };
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @RequireScopes()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Returns user profile' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@CurrentUser() user: User) {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }

  @Get('me/workspaces')
  @UseGuards(JwtAuthGuard)
  @RequireScopes()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List the workspaces the caller is an active member of' })
  @ApiResponse({ status: 200, description: 'Returns the caller’s active workspaces' })
  async myWorkspaces(@CurrentUser() user: User) {
    return { workspaces: await listMyWorkspaces(this.membership, user) };
  }
}

/**
 * M365 OAuth routes — the account-linking handshake.
 *
 *   GET /m365/oauth/start    (JwtAuthGuard) → { url } the SPA redirects to.
 *   GET /m365/oauth/callback (PUBLIC — Microsoft redirects here bearer-less)
 *        → verify+consume state, redeem code, store the encrypted token, then
 *          302 back to the SPA integrations page with ?m365=connected|error.
 *
 * The callback deliberately carries NO auth guard (exactly like the Keycloak
 * callback in auth.controller.ts): Microsoft arrives with no Authorization header,
 * and the SIGNED, SINGLE-USE `state` is what re-establishes the user — that
 * signature is the security boundary, not a bearer.
 */

import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtOnly } from '../../auth/decorators/jwt-only.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WithWorkspaceClaim } from '../../common/workspace/workspace.util';
import { M365OAuthService } from './m365-oauth.service';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

@ApiTags('m365')
@Controller('m365/oauth')
export class M365OAuthController {
  constructor(private readonly oauth: M365OAuthService) {}

  /**
   * Begin the connect flow. Session-only (a PAT can't link an account — that's a
   * human, browser-session action), returns the consent URL for the SPA to
   * navigate to. 503 (problem+json) when the connector is dormant.
   */
  @Get('start')
  @UseGuards(JwtAuthGuard)
  @JwtOnly()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Begin the Microsoft 365 connect flow (returns the consent URL)' })
  @ApiResponse({ status: 200, description: 'The Microsoft consent URL the SPA redirects to' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 503, description: 'Microsoft 365 is not configured on this deployment' })
  async start(@CurrentUser() user: AuthedUser) {
    return this.oauth.start(user);
  }

  /**
   * Microsoft's redirect target. Public (bearer-less); the signed state carries
   * the identity. Always 302s back to the SPA — `?m365=connected` on success,
   * `?m365=error` on any failure (forged/expired state, denied consent, code
   * redemption failure). Never renders a token or an error body to the browser.
   */
  @Get('callback')
  @ApiExcludeEndpoint()
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() _req: unknown,
    @Res() res: Response,
  ) {
    // The user denied consent, or Entra returned an error (e.g. admin consent
    // required) — bounce back with a generic error marker (the detail is safe:
    // it's Microsoft's error code, never a credential).
    if (error) {
      return res.redirect(this.oauth.returnUrl('error', error));
    }
    if (!code || !state) {
      return res.redirect(this.oauth.returnUrl('error', 'missing_code_or_state'));
    }
    try {
      await this.oauth.complete(code, state);
      return res.redirect(this.oauth.returnUrl('connected'));
    } catch (err) {
      // Don't leak the exception to the browser — log server-side, redirect clean.
      return res.redirect(this.oauth.returnUrl('error', 'connect_failed'));
    }
  }
}

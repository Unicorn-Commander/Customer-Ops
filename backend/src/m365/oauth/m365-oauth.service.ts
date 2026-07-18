/**
 * M365OAuthService — orchestrates the account-linking handshake.
 *
 *   start(user)  → resolve the user's workspace, sign a single-use state, build
 *                  the MSAL consent URL. (Called behind JwtAuthGuard.)
 *   complete(code, state) → verify+consume the state (re-establishing the user +
 *                  workspace, since the callback is bearer-less), redeem the code,
 *                  ENCRYPT the refresh token, upsert the connection row. Returns
 *                  the verified user/workspace so the controller can attribute it.
 *
 * The encrypted refresh token is the only durable secret; it is written via the
 * store as ciphertext and never logged.
 */

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { User } from '@prisma/client';
import { WorkspaceContextService } from '../../common/workspace/workspace-context.service';
import { WithWorkspaceClaim } from '../../common/workspace/workspace.util';
import { M365Config } from '../m365.config';
import { TokenCipher } from '../crypto/token-cipher';
import { M365ConnectionStore } from '../store/m365-connection.store';
import { MsalClientFactory } from './msal-client.factory';
import { M365StateService } from './m365-state.service';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

@Injectable()
export class M365OAuthService {
  private readonly logger = new Logger(M365OAuthService.name);

  constructor(
    private readonly config: M365Config,
    private readonly workspaces: WorkspaceContextService,
    private readonly state: M365StateService,
    private readonly msal: MsalClientFactory,
    private readonly cipher: TokenCipher,
    private readonly store: M365ConnectionStore,
  ) {}

  /** Build the consent URL for the current user. Resolves their active workspace
   *  (the sync target) and binds it into the signed state. */
  async start(user: AuthedUser): Promise<{ url: string }> {
    this.requireConfigured();
    const workspaceId = await this.workspaces.resolveAuthorized(user);
    const signedState = this.state.sign(user.id, workspaceId);
    const url = await this.msal.getAuthCodeUrl(signedState);
    this.logger.log(`M365 consent started for user ${user.id} (workspace ${workspaceId})`);
    return { url };
  }

  /**
   * Complete the callback: verify+consume the state, redeem the code, encrypt +
   * store the refresh token. Throws on a forged/expired/replayed state or a code
   * redemption failure (the controller maps either to `?m365=error`).
   */
  async complete(code: string, state: string): Promise<{ userId: string; workspaceId: string }> {
    this.requireConfigured();
    // The state IS the security boundary — verify + single-use consume FIRST.
    const claims = await this.state.verifyAndConsume(state);

    const token = await this.msal.acquireTokenByCode(code);
    if (!token.refreshToken) {
      // No offline_access granted (or admin-consent stripped it) → nothing to store.
      throw new Error('Microsoft did not return a refresh token (offline_access not granted)');
    }

    const m365UserId = token.account?.homeAccountId || token.account?.localAccountId || 'unknown';
    const m365UserPrincipal = token.account?.username ?? null;

    await this.store.upsert({
      userId: claims.uid,
      workspaceId: claims.ws,
      m365UserId,
      m365UserPrincipal,
      scopes: token.scopes.length ? token.scopes : this.config.scopes,
      refreshTokenEnc: this.cipher.encrypt(token.refreshToken),
      accessTokenEnc: token.accessToken ? this.cipher.encrypt(token.accessToken) : null,
      accessTokenExpires: token.expiresOn ?? null,
    });

    this.logger.log(`M365 connected for user ${claims.uid} (workspace ${claims.ws})`);
    return { userId: claims.uid, workspaceId: claims.ws };
  }

  /** The fixed, configured return URL for the SPA (never a request header). */
  returnUrl(outcome: 'connected' | 'error', detail?: string): string {
    const base = this.config.frontendReturnUrl;
    const params = new URLSearchParams({ m365: outcome });
    if (detail) params.set('m365_detail', detail.slice(0, 200));
    return `${base}?${params.toString()}`;
  }

  private requireConfigured(): void {
    if (!this.config.isConfigured) {
      throw new ServiceUnavailableException(
        'Microsoft 365 is not configured on this deployment (M365_CLIENT_ID is unset).',
      );
    }
  }
}

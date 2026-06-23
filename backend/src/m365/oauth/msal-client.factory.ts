/**
 * MsalClientFactory — the seam around `@azure/msal-node`'s
 * ConfidentialClientApplication.
 *
 * WHY MSAL (not passport): the suite's login is passport-oauth2 (KeycloakStrategy)
 * where "the OAuth response IS the session". M365 here is SECONDARY account-linking
 * for an already-authenticated user — the product is a stored, decryptable refresh
 * token attributed to the current JWT user, NOT a login. MSAL is purpose-built for
 * exactly that (getAuthCodeUrl / acquireTokenByCode / acquireTokenByRefreshToken)
 * and owns the refresh lifecycle the recurring sync needs.
 *
 * This factory builds the CCA lazily and ONLY when the connector is configured —
 * so when M365_CLIENT_ID is unset the connector is fully dormant and MSAL is never
 * constructed. It is also the single injection point the OAuth + Graph specs
 * override with a fake (MSAL is never exercised against the network in tests).
 */

import { Injectable, Logger } from '@nestjs/common';
import { AuthenticationResult, ConfidentialClientApplication } from '@azure/msal-node';
import { M365Config } from '../m365.config';

/** A minimal token result the rest of the connector consumes (MSAL-shaped). */
export interface MsalTokenResult {
  accessToken: string | null;
  /** The (possibly rotated) refresh token. MSAL exposes this on the raw token
   *  cache, not the public result — see `extractRefreshToken`. */
  refreshToken: string | null;
  expiresOn: Date | null;
  scopes: string[];
  account: AuthenticationResult['account'];
}

@Injectable()
export class MsalClientFactory {
  private readonly logger = new Logger(MsalClientFactory.name);
  private client: ConfidentialClientApplication | null = null;

  constructor(private readonly config: M365Config) {}

  /** Whether MSAL can be used (connector configured with id + secret). */
  get isReady(): boolean {
    return this.config.isConfigured && !!this.config.clientSecret;
  }

  /** Build the consent URL the SPA redirects the user to. `state` is the signed,
   *  single-use JWT that re-establishes the user on the callback. */
  async getAuthCodeUrl(state: string): Promise<string> {
    return this.cca().getAuthCodeUrl({
      scopes: this.config.scopes,
      redirectUri: this.config.redirectUri,
      state,
    });
  }

  /** Redeem the authorization code from the callback for tokens. */
  async acquireTokenByCode(code: string): Promise<MsalTokenResult> {
    const result = await this.cca().acquireTokenByCode({
      code,
      scopes: this.config.scopes,
      redirectUri: this.config.redirectUri,
    });
    return this.toResult(result);
  }

  /** Mint a fresh access token (and rotated refresh token) from a stored refresh
   *  token — the recurring-sync path. Throws on invalid_grant (caller revokes). */
  async acquireTokenByRefreshToken(refreshToken: string): Promise<MsalTokenResult> {
    const result = await this.cca().acquireTokenByRefreshToken({
      refreshToken,
      scopes: this.config.scopes,
    });
    if (!result) {
      throw new Error('MSAL returned no result for the refresh-token grant');
    }
    return this.toResult(result);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private cca(): ConfidentialClientApplication {
    if (!this.isReady) {
      throw new Error(
        'M365 connector is not configured (M365_CLIENT_ID / M365_CLIENT_SECRET unset)',
      );
    }
    if (!this.client) {
      this.client = new ConfidentialClientApplication({
        auth: {
          clientId: this.config.clientId!,
          clientSecret: this.config.clientSecret!,
          authority: this.config.authority,
        },
      });
    }
    return this.client;
  }

  private toResult(result: AuthenticationResult): MsalTokenResult {
    return {
      accessToken: result.accessToken || null,
      refreshToken: this.extractRefreshToken(),
      expiresOn: result.expiresOn ?? null,
      scopes: result.scopes ?? [],
      account: result.account,
    };
  }

  /**
   * MSAL-node does not surface the refresh token on the public AuthenticationResult
   * (by design — it manages the cache). We read it out of the in-memory token cache
   * so we can persist it ourselves (a server-side, per-user link needs to own the
   * refresh lifecycle across process restarts, which the default in-memory cache
   * does not survive). This reads the SERIALIZED cache, never logs it, and returns
   * null if the shape changes (the caller then keeps the previously-stored token).
   */
  private extractRefreshToken(): string | null {
    try {
      const serialized = this.cca().getTokenCache().serialize();
      const parsed = JSON.parse(serialized) as {
        RefreshToken?: Record<string, { secret?: string }>;
      };
      const entries = parsed.RefreshToken ? Object.values(parsed.RefreshToken) : [];
      const secret = entries.find((e) => e?.secret)?.secret;
      return secret ?? null;
    } catch (err) {
      this.logger.warn(`Could not read refresh token from MSAL cache: ${(err as Error).message}`);
      return null;
    }
  }
}

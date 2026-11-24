import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-oauth2';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';
import { SingleUseTokenStore } from '../../common/security/single-use-token.store';
import { KeycloakStateCookieStore } from './keycloak-state.store';

/**
 * Keycloak OIDC (Authorization Code) strategy for the browser login flow.
 * Redirects the user to the configured realm, then on callback fetches the userinfo
 * and JIT-provisions / resolves the Customer-Ops User via AuthService.
 */
@Injectable()
export class KeycloakStrategy extends PassportStrategy(Strategy, 'keycloak') {
  private readonly logger = new Logger(KeycloakStrategy.name);
  private readonly userinfoURL: string;

  constructor(
    private configService: ConfigService,
    private authService: AuthService,
    singleUse: SingleUseTokenStore,
  ) {
    const keycloakUrl = (
      configService.get<string>('KEYCLOAK_URL') || 'http://127.0.0.1:8080'
    ).replace(/\/$/, '');
    // The browser reaches the loopback port; containers use the service name.
    // Existing deployments with a single reachable issuer need no new setting.
    const publicUrl = (configService.get<string>('KEYCLOAK_PUBLIC_URL') || keycloakUrl).replace(
      /\/$/,
      '',
    );
    const realm = configService.get('KEYCLOAK_REALM', 'customer-ops');
    const callbackURL = configService.get(
      'KEYCLOAK_CALLBACK_URL',
      '/api/v1/auth/keycloak/callback',
    );

    super({
      authorizationURL: `${publicUrl}/realms/${realm}/protocol/openid-connect/auth`,
      tokenURL: `${keycloakUrl}/realms/${realm}/protocol/openid-connect/token`,
      clientID: configService.get('KEYCLOAK_CLIENT_ID', 'customer-ops'),
      clientSecret: configService.get('KEYCLOAK_CLIENT_SECRET', ''),
      callbackURL,
      scope: ['openid', 'profile', 'email'],
      // Login-CSRF defence (CUO-CB-1): a signed, single-use __Host- cookie holds
      // the state handle + PKCE verifier; a missing, foreign or replayed state is
      // refused before the token-endpoint code exchange.
      pkce: 'S256',
      state: true,
      store: new KeycloakStateCookieStore(
        () => configService.get<string>('JWT_SECRET') || '',
        singleUse,
      ),
    });

    this.userinfoURL = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/userinfo`;
  }

  async validate(accessToken: string, _refreshToken: string, _profile: any): Promise<any> {
    // passport-oauth2 does not fetch userinfo automatically, so we call the
    // Keycloak userinfo endpoint to get the full profile (sub, email, names).
    // Without a userinfo profile there is no identity to resolve: refuse the
    // sign-in with a clean 401 (CUO-CB-2) instead of resolving an empty `{}`
    // profile into an unhandled 500. Details go to the log, never the client.
    let userProfile: any;
    try {
      const response = await fetch(this.userinfoURL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        this.logger.warn(
          `Failed to fetch userinfo from Keycloak: ${response.status} ${response.statusText}`,
        );
        throw new UnauthorizedException('SSO sign-in failed');
      }
      userProfile = await response.json();
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      this.logger.error(`Error fetching Keycloak userinfo: ${(error as Error)?.message}`);
      throw new UnauthorizedException('SSO sign-in failed');
    }
    if (
      !userProfile ||
      typeof userProfile !== 'object' ||
      typeof userProfile.sub !== 'string' ||
      !userProfile.sub
    ) {
      this.logger.warn('Keycloak userinfo carried no subject; sign-in refused');
      throw new UnauthorizedException('SSO sign-in failed');
    }

    // The entitlement SKUs ride on the Keycloak ACCESS token (the `entitlements`
    // mapper emits to the access token, not userinfo), so read them there and
    // carry them on the profile. AuthService bakes them into the minted HS256
    // session token so the browser path enforces like the forwarded-token path.
    const entitlements = this.readEntitlementsFromAccessToken(accessToken);
    if (entitlements.length) {
      userProfile = { ...userProfile, entitlements };
    }

    const keycloakId: string = userProfile.sub;
    const isHumanRealmProfile =
      typeof userProfile?.email === 'string' &&
      userProfile.email.trim() !== '' &&
      userProfile?.email_verified === true &&
      !userProfile?.act &&
      !userProfile?.client_id &&
      !userProfile?.clientId &&
      !userProfile?.__federationActor;
    return isHumanRealmProfile
      ? this.authService.validateKeycloakUser(keycloakId, userProfile, accessToken)
      : this.authService.validateKeycloakUser(keycloakId, userProfile);
  }

  /**
   * Decode (without re-verifying — it came straight from the KC token endpoint
   * over TLS in the code exchange) the access token and pull the flat
   * `entitlements` claim. Tolerant of array OR space/comma-delimited string;
   * any failure yields `[]` (enforce then denies, degrade-clean).
   */
  private readEntitlementsFromAccessToken(accessToken: string): string[] {
    try {
      const part = accessToken.split('.')[1];
      if (!part) return [];
      const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
        'utf8',
      );
      const claims = JSON.parse(json);
      const raw = claims?.entitlements;
      if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
      if (typeof raw === 'string')
        return raw
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      return [];
    } catch (error) {
      this.logger.warn(`Could not read entitlements from Keycloak access token: ${error}`);
      return [];
    }
  }
}

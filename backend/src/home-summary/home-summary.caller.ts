import { createHash } from 'crypto';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jsonwebtoken from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { homeCallerClientId } from './home-summary.config';

/**
 * The caller fence for HOME-SUMMARY CONTRACT v1 — its OWN guard, never behind
 * JwtAuthGuard.
 *
 * The route must NOT run the app's person strategy: JwtStrategy resolves (or, in
 * open mode, JIT-provisions) a User row from the token, and a client_credentials
 * service token has no user and no email. So this guard verifies the token ITSELF
 * against the app's EXISTING realm JWKS + the EXACT realm issuer:
 *   - RS256 only, `kid` -> the realm JWKS (KEYCLOAK_URL + KEYCLOAK_REALM),
 *   - `iss` === the realm issuer (KEYCLOAK_PUBLIC_URL || KEYCLOAK_URL)/realms/<realm>
 *     — the Brigade federation issuers the strategy also trusts are NOT accepted,
 *   - `azp == HOME_CALLER_CLIENT_ID`,
 *   - a client_credentials (service-account) shape — not a person token,
 *   - not expired.
 * No new trust root: same JWKS URL, same issuer the strategy already pins.
 *
 * No user resolution and no provisioning happen here. The PERSON is resolved from
 * the `email` query param by the service, exactly as the contract says.
 *
 * Anything else is 401 `{ "error": "caller_not_allowed" }` (never say why).
 */
export interface VerifiedTokenClaims {
  azp?: unknown;
  iss?: unknown;
  aud?: unknown;
  client_id?: unknown;
  clientId?: unknown;
  act?: unknown;
  email?: unknown;
  email_verified?: unknown;
  exp?: unknown;
}

/**
 * The realm issuer the app already uses: the browser-facing URL when set (the
 * self-host compose arrangement), else KEYCLOAK_URL — identical to
 * JwtStrategy.buildRealmIssuer. A different `iss` (a Brigade federation broker,
 * another realm) is refused.
 */
export function realmIssuer(config: ConfigService): string | null {
  const base = (
    config.get<string>('KEYCLOAK_PUBLIC_URL') ||
    config.get<string>('KEYCLOAK_URL') ||
    ''
  ).replace(/\/$/, '');
  const realm = config.get<string>('KEYCLOAK_REALM');
  if (!base || !realm) return null;
  return `${base}/realms/${encodeURIComponent(realm)}`;
}

/** The realm JWKS URI — identical to JwtStrategy.buildJwksUri (no new source). */
export function realmJwksUri(config: ConfigService): string | null {
  const base = (config.get<string>('KEYCLOAK_URL') || '').replace(/\/$/, '');
  const realm = config.get<string>('KEYCLOAK_REALM');
  if (!base || !realm) return null;
  return `${base}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/certs`;
}

/**
 * A client_credentials (service-account) token: client identity, no delegation,
 * no verified human email. A person token (or anything not clearly a service
 * account) is refused.
 */
export function isServiceAccountToken(claims: VerifiedTokenClaims | null | undefined): boolean {
  if (!claims || typeof claims !== 'object') return false;
  const hasClientIdentity =
    typeof claims.client_id === 'string' || typeof claims.clientId === 'string';
  const hasDelegation = claims.act != null;
  const hasVerifiedEmail = claims.email_verified === true;
  const looksHuman = hasVerifiedEmail && !hasClientIdentity && !hasDelegation;
  if (looksHuman) return false;
  return hasClientIdentity && !hasDelegation;
}

export function callerAzpMatches(
  claims: VerifiedTokenClaims | null | undefined,
  expectedClientId: string,
): boolean {
  const azp = claims && typeof claims.azp === 'string' ? claims.azp : '';
  return azp.length > 0 && azp === expectedClientId;
}

/**
 * The one refusal the contract names. The message never explains why (no
 * distinction between a person token, another client, and a bad shape).
 */
export function callerNotAllowed(): UnauthorizedException {
  return new UnauthorizedException({ error: 'caller_not_allowed' });
}

export function isHomeCaller(
  claims: VerifiedTokenClaims | null | undefined,
  expectedClientId: string,
): boolean {
  return callerAzpMatches(claims, expectedClientId) && isServiceAccountToken(claims);
}

/**
 * Verify a service token: RS256 against the realm JWKS, pinned to the exact
 * realm issuer, then the caller fence. Returns the verified claims or throws the
 * one 401. `resolveKey` is injected so a test can serve a fake JWKS; in prod it
 * is the realm JWKS client.
 */
export type VerifyHomeCallerKey = (kid: string) => Promise<string | Buffer>;

export async function verifyHomeCaller(
  token: string | undefined,
  resolveKey: VerifyHomeCallerKey | null,
  expectedIssuer: string | null,
  expectedClientId: string,
): Promise<VerifiedTokenClaims> {
  if (!token || !resolveKey || !expectedIssuer) throw callerNotAllowed();

  let decoded: jsonwebtoken.Jwt & { header?: { kid?: string; alg?: string } };
  try {
    const complete = jsonwebtoken.decode(token, { complete: true });
    if (!complete || typeof complete === 'string') throw callerNotAllowed();
    decoded = complete as typeof decoded;
  } catch {
    throw callerNotAllowed();
  }

  const kid = decoded.header?.kid;
  if (decoded.header?.alg !== 'RS256' || !kid) throw callerNotAllowed();

  let key: string | Buffer;
  try {
    key = await resolveKey(kid);
  } catch {
    throw callerNotAllowed();
  }

  let claims: VerifiedTokenClaims;
  try {
    claims = jsonwebtoken.verify(token, key, {
      algorithms: ['RS256'],
      issuer: expectedIssuer,
      ignoreExpiration: false,
    }) as VerifiedTokenClaims;
  } catch {
    throw callerNotAllowed();
  }

  // Belt-and-braces: the issuer is already pinned by verify(); re-assert it so a
  // future option change cannot silently widen the trust root.
  if (claims.iss !== expectedIssuer) throw callerNotAllowed();
  if (!isHomeCaller(claims, expectedClientId)) throw callerNotAllowed();
  const exp = claims.exp;
  if (typeof exp !== 'number' || exp * 1000 <= Date.now()) throw callerNotAllowed();
  return claims;
}

/** DI token for an alternative key resolver (a test seam; unused in prod). */
export const GUARD_KEY_RESOLVER = 'HOME_SUMMARY_CALLER_JWKS';

/** The guard class the controller binds: verifies the service token itself. */
@Injectable()
export class ServiceCallerGuard implements CanActivate {
  private readonly jwks: JwksClient | null;

  constructor(
    private readonly config: ConfigService,
    @Optional()
    @Inject(GUARD_KEY_RESOLVER)
    private readonly resolveKeyOverride?: VerifyHomeCallerKey,
  ) {
    const uri = realmJwksUri(config);
    this.jwks = uri
      ? jwksClient({
          jwksUri: uri,
          cache: true,
          cacheMaxAge: 10 * 60 * 1000,
          rateLimit: true,
          jwksRequestsPerMinute: 12,
        })
      : null;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = extractBearer(request);
    const claims = await verifyHomeCaller(
      token,
      this.resolver(),
      realmIssuer(this.config),
      homeCallerClientId(this.config),
    );
    // Stash the verified caller azp for the audit line; never the token.
    request.homeCallerAzp = String(claims.azp);
    return true;
  }

  private resolver(): VerifyHomeCallerKey | null {
    if (this.resolveKeyOverride) return this.resolveKeyOverride;
    if (!this.jwks) return null;
    const jwks = this.jwks;
    return (kid: string) =>
      new Promise<string | Buffer>((resolve, reject) => {
        jwks.getSigningKey(kid, (err, key) => {
          if (err || !key) return reject(err ?? new Error('signing key not found'));
          resolve(key.getPublicKey());
        });
      });
  }
}

function extractBearer(request: any): string | undefined {
  const header = request?.headers?.authorization ?? request?.headers?.Authorization;
  if (typeof header !== 'string') return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

/** Nest DI factory for the service caller guard (pins an optional key seam). */
export function serviceCallerGuard(
  config: ConfigService,
  resolveKey?: VerifyHomeCallerKey,
): ServiceCallerGuard {
  return new ServiceCallerGuard(config, resolveKey);
}

/**
 * The AUDIT identity of an email: `sha256(lowercased, trimmed email)[:12]`. The
 * raw address is never logged; this is the only form that leaves the handler.
 */
export function emailAuditHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 12);
}

export function normalizeEmail(email: string | null | undefined): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

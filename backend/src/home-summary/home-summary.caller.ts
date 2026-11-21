import { createHash } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';

/**
 * The caller fence for HOME-SUMMARY CONTRACT v1.
 *
 * The ONLY caller this route accepts is the Ops-Center Home service account:
 *   - a JWT that verified against the app's EXISTING trusted issuers/JWKS (the
 *     JwtAuthGuard + JwtStrategy in front of the controller did that — no new
 *     trust root lives here),
 *   - `azp == HOME_CALLER_CLIENT_ID`,
 *   - a client_credentials (service-account) token — NOT a person token,
 *   - not expired (the strategy's `ignoreExpiration: false` already enforced it).
 *
 * Anything else is 401 `{ "error": "caller_not_allowed" }`. The service token
 * alone never sees data: the handler still needs a concrete person (`email`) and
 * workspace, so the answer is always for one named person.
 *
 * This is the shape Customer-Ops' own JwtStrategy already surfaces to
 * `validate()`: a real Keycloak client_credentials token carries
 * `azp` + `client_id`/`clientId`, no `act`, and no verified `email`; a person
 * (human realm) token carries a verified `email` and no client identity. The
 * pure predicate below is exported so it is pinned independently of the guard.
 */
export interface VerifiedTokenClaims {
  azp?: unknown;
  aud?: unknown;
  client_id?: unknown;
  clientId?: unknown;
  act?: unknown;
  email?: unknown;
  email_verified?: unknown;
  exp?: unknown;
}

export function isServiceAccountToken(claims: VerifiedTokenClaims | null | undefined): boolean {
  if (!claims || typeof claims !== 'object') return false;
  const hasClientIdentity =
    typeof claims.client_id === 'string' || typeof claims.clientId === 'string';
  const hasDelegation = claims.act != null;
  const hasVerifiedEmail = claims.email_verified === true;
  const looksHuman = hasVerifiedEmail && !hasClientIdentity && !hasDelegation;
  // A person token (or anything that is not clearly a service account) is refused.
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
 * distinction between a person token, another client, and a bad shape). Returns a
 * fresh UnauthorizedException for the caller to throw.
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
 * The AUDIT identity of an email: `sha256(lowercased, trimmed email)[:12]`. The
 * raw address is never logged; this is the only form that leaves the handler.
 */
export function emailAuditHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 12);
}

export function normalizeEmail(email: string | null | undefined): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

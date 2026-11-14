import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import {
  PROVISIONING_ISSUER,
  provisioningAudience,
  provisioningSecret,
} from './provisioning.config';
import { ProvisioningJtiStore } from './provisioning-jti.store';

/** Seconds a token's `iat` may sit in the future (clock skew). */
export const MAX_IAT_SKEW_SECONDS = 5;
/** Longest lifetime (`exp - iat`) the control plane may issue, in seconds. */
export const MAX_TOKEN_LIFETIME_SECONDS = 60;
const MAX_JTI_LENGTH = 255;

export interface ProvisioningClaims {
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
  jti: string;
}

/** Injection token for the jti store, so tests can bound it. */
export const PROVISIONING_JTI_STORE = Symbol('PROVISIONING_JTI_STORE');

/**
 * Verifies the per-app service token Ops-Center sends on every provisioning call:
 * HS256 only, `iss` "ops-center", `aud` PROVISIONING_JWT_AUDIENCE (default
 * customer-ops), `iat` present and at most 5 s ahead, `exp - iat` at most 60 s,
 * and a `jti` accepted once.
 *
 * Nothing about the token or the secret is ever logged: only the reason class.
 */
@Injectable()
export class ProvisioningTokenService {
  private readonly logger = new Logger(ProvisioningTokenService.name);
  private warnedShortSecret = false;

  /** Clock in ms; replaceable in tests. */
  now: () => number = Date.now;

  constructor(@Inject(PROVISIONING_JTI_STORE) private readonly jtis: ProvisioningJtiStore) {}

  /** The usable secret, or null (the routes then answer 404). Logged once, by name. */
  secret(): string | null {
    const secret = provisioningSecret();
    if (!secret && !this.warnedShortSecret) {
      this.warnedShortSecret = true;
      this.logger.error(
        'PROVISIONING_JWT_SECRET is unset or shorter than 32 bytes; provisioning routes answer 404.',
      );
    }
    return secret;
  }

  /** Verify `token` against `secret`; throws 401 (or 503 when the jti store is full). */
  verify(token: string, secret: string): ProvisioningClaims {
    let claims: jwt.JwtPayload;
    try {
      const decoded = jwt.verify(token, secret, {
        algorithms: ['HS256'],
        issuer: PROVISIONING_ISSUER,
        audience: provisioningAudience(),
        clockTimestamp: Math.floor(this.now() / 1000),
      });
      if (typeof decoded === 'string') throw new Error('not a JSON payload');
      claims = decoded;
    } catch (error) {
      this.logger.warn(`Provisioning token refused: ${(error as Error).name}`);
      throw new UnauthorizedException('Invalid provisioning token.');
    }

    const nowSeconds = this.now() / 1000;
    const { iat, exp, jti } = claims;
    const refuse = (reason: string): never => {
      this.logger.warn(`Provisioning token refused: ${reason}`);
      throw new UnauthorizedException('Invalid provisioning token.');
    };
    if (typeof iat !== 'number' || !Number.isFinite(iat)) refuse('iat missing');
    if (typeof exp !== 'number' || !Number.isFinite(exp)) refuse('exp missing');
    if (iat! > nowSeconds + MAX_IAT_SKEW_SECONDS) refuse('iat in the future');
    if (exp! - iat! > MAX_TOKEN_LIFETIME_SECONDS) refuse('lifetime over 60 seconds');
    if (exp! <= iat!) refuse('exp not after iat');
    if (typeof jti !== 'string' || !jti.trim() || jti.length > MAX_JTI_LENGTH)
      refuse('jti missing');

    // Keep the jti until the token could no longer be accepted anyway.
    if (!this.jtis.accept(jti!, exp! * 1000)) refuse('jti replayed');
    return claims as ProvisioningClaims;
  }
}

/**
 * M365StateService — the OAuth `state` is the connector's security boundary.
 *
 * The callback is a PUBLIC route (Microsoft redirects the browser there with no
 * bearer). So the `state` round-tripped through the consent flow is the ONLY
 * thing that re-establishes WHICH authenticated user + workspace this consent
 * belongs to, and the ONLY CSRF defence. It is therefore:
 *
 *   • JWT-SIGNED with JWT_SECRET (the same secret the session tokens use, via the
 *     shared JwtService) — a forged/edited state fails verification → 401.
 *   • SHORT-TTL — it only needs to live long enough to complete consent
 *     (M365_STATE_TTL_SECONDS, default 600s).
 *   • SINGLE-USE — a `nonce` is recorded as consumed on first successful callback,
 *     so a replayed state (captured redirect URL) is rejected.
 *
 * The consumed-nonce set is in-process (the dogfood is single-replica). It is
 * self-pruning by TTL so it can't grow unbounded. A multi-replica deploy would
 * swap this for a shared store (Redis) — the seam is this one class.
 */

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { M365Config } from '../m365.config';

/** The claims carried in the signed state. */
export interface M365StatePayload {
  /** The local user id the link is attributed to. */
  uid: string;
  /** The workspace the sync funnels into (resolved at start time). */
  ws: string;
  /** Single-use nonce (jti). */
  nonce: string;
}

interface DecodedState extends M365StatePayload {
  iat: number;
  exp: number;
}

@Injectable()
export class M365StateService {
  /** nonce → expiry epoch ms. Consumed nonces, pruned lazily by TTL. */
  private readonly consumed = new Map<string, number>();

  constructor(
    private readonly jwt: JwtService,
    private readonly config: M365Config,
  ) {}

  /** Sign a short-TTL state for the given user + workspace. */
  sign(uid: string, ws: string): string {
    const payload: M365StatePayload = { uid, ws, nonce: randomUUID() };
    return this.jwt.sign(payload, {
      secret: this.secret(),
      expiresIn: this.config.stateTtlSeconds,
    });
  }

  /**
   * Verify + decode + CONSUME a state. Throws if the signature is invalid, the
   * state is expired, or the nonce was already used (replay). On success the
   * nonce is recorded so it can never be used again.
   */
  verifyAndConsume(state: string): M365StatePayload {
    let decoded: DecodedState;
    try {
      decoded = this.jwt.verify<DecodedState>(state, { secret: this.secret() });
    } catch {
      // Covers a bad signature AND an expired token (jsonwebtoken throws on both).
      throw new Error('Invalid or expired OAuth state');
    }
    if (!decoded?.nonce || !decoded.uid || !decoded.ws) {
      throw new Error('Malformed OAuth state');
    }

    this.prune();
    if (this.consumed.has(decoded.nonce)) {
      throw new Error('OAuth state already used');
    }
    // Record as consumed until its own expiry (no need to retain past that).
    this.consumed.set(decoded.nonce, decoded.exp * 1000);

    return { uid: decoded.uid, ws: decoded.ws, nonce: decoded.nonce };
  }

  private secret(): string {
    // The state MUST be signed; an empty secret would let an attacker forge one.
    // JwtModule is configured with JWT_SECRET app-wide; if it's somehow unset the
    // sign/verify here throws, which fails the flow closed (never accepts a forgery).
    return process.env.JWT_SECRET ?? '';
  }

  /** Drop expired consumed-nonce entries so the set can't grow without bound. */
  private prune(): void {
    const now = Date.now();
    for (const [nonce, exp] of this.consumed) {
      if (exp <= now) this.consumed.delete(nonce);
    }
  }
}

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { SingleUseTokenStore } from '../../common/security/single-use-token.store';

/**
 * Login-CSRF defence for the Keycloak SSO leg (CUO-CB-1).
 *
 * passport-oauth2 built with no `state`/`store` option uses its NullStore, so a
 * callback carrying an attacker's own authorization code would be accepted
 * (login CSRF). Customer-Ops has no express-session, so passport's session
 * stores cannot be used. This store keeps the state handle and the PKCE
 * verifier in a short-lived, HMAC-signed cookie instead:
 *
 *   - `__Host-` prefix + Secure + Path=/ + no Domain: a sibling subdomain can
 *     neither set nor overwrite it.
 *   - HttpOnly, SameSite=Lax: page script cannot read it; it still rides the
 *     top-level GET redirect back from Keycloak.
 *   - signed (HMAC-SHA256, key derived from JWT_SECRET) and expiring after
 *     STATE_TTL_SECONDS: a forged or stale cookie is refused.
 *   - single use: the cookie is cleared on every callback and the handle is
 *     consumed in the shared SingleUseTokenStore, so a replayed callback
 *     (same cookie + same state) is refused.
 *
 * passport-oauth2 calls verify() BEFORE the token-endpoint code exchange, and a
 * `false` result fails the request with 403 without calling the token endpoint.
 */

export const KEYCLOAK_STATE_COOKIE = '__Host-co_kc_state';
export const STATE_TTL_SECONDS = 600;
const SINGLE_USE_NAMESPACE = 'keycloak:oauth-state';

interface StatePayload {
  /** The opaque `state` handle sent to Keycloak. */
  h: string;
  /** PKCE code_verifier (S256 challenge sent to Keycloak). */
  v: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

type StoreCallback = (err: Error | null, handle?: string) => void;
type VerifyCallback = (err: Error | null, ok?: string | false, info?: { message: string }) => void;

const REFUSED = { message: 'Invalid authorization request state.' };

export class KeycloakStateCookieStore {
  constructor(
    private readonly secret: () => string,
    private readonly singleUse: SingleUseTokenStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** passport-oauth2 PKCE arity-5 store: (req, verifier, state, meta, cb). */
  store(req: any, verifier: string, _state: unknown, _meta: unknown, cb: StoreCallback): void {
    const key = this.key();
    if (!key) return cb(new Error('SSO state signing key is not configured'));
    if (typeof verifier !== 'string' || !verifier) {
      return cb(new Error('PKCE verifier missing'));
    }
    const res = req?.res;
    if (!res) return cb(new Error('No response to set the SSO state cookie on'));

    const handle = randomBytes(24).toString('base64url');
    const payload: StatePayload = {
      h: handle,
      v: verifier,
      exp: Math.floor(this.now() / 1000) + STATE_TTL_SECONDS,
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const value = `${body}.${this.sign(key, body)}`;
    appendSetCookie(res, serializeCookie(value, STATE_TTL_SECONDS));
    cb(null, handle);
  }

  /** passport-oauth2 arity-3 verify: (req, providedState, cb). */
  verify(req: any, providedState: unknown, cb: VerifyCallback): void {
    // Clear the cookie on every callback, accepted or refused: single use.
    if (req?.res) appendSetCookie(req.res, serializeCookie('', 0));

    this.check(req, providedState)
      .then((verifier) => (verifier ? cb(null, verifier) : cb(null, false, REFUSED)))
      .catch((err) => cb(err as Error));
  }

  private async check(req: any, providedState: unknown): Promise<string | null> {
    const key = this.key();
    if (!key) throw new Error('SSO state signing key is not configured');
    if (typeof providedState !== 'string' || !providedState) return null;

    const raw = readCookie(req?.headers?.cookie, KEYCLOAK_STATE_COOKIE);
    if (!raw) return null;
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = raw.slice(0, dot);
    if (!safeEqual(raw.slice(dot + 1), this.sign(key, body))) return null;

    let payload: StatePayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (
      typeof payload?.h !== 'string' ||
      typeof payload?.v !== 'string' ||
      typeof payload?.exp !== 'number'
    ) {
      return null;
    }
    const nowSec = Math.floor(this.now() / 1000);
    if (payload.exp <= nowSec) return null;
    if (!safeEqual(payload.h, providedState)) return null;

    const firstUse = await this.singleUse.consume(
      SINGLE_USE_NAMESPACE,
      payload.h,
      Math.max(1, payload.exp - nowSec),
    );
    return firstUse ? payload.v : null;
  }

  private key(): Buffer | null {
    const secret = this.secret();
    if (!secret) return null;
    // Domain-separated from the session-token use of the same secret.
    return createHmac('sha256', secret).update('customer-ops:keycloak-oauth-state').digest();
  }

  private sign(key: Buffer, body: string): string {
    return createHmac('sha256', key).update(body).digest('base64url');
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function serializeCookie(value: string, maxAgeSeconds: number): string {
  return (
    `${KEYCLOAK_STATE_COOKIE}=${value}; Max-Age=${maxAgeSeconds}; Path=/; ` +
    'Secure; HttpOnly; SameSite=Lax'
  );
}

function appendSetCookie(res: any, cookie: string): void {
  const prev = res.getHeader?.('Set-Cookie');
  const list = prev === undefined ? [] : Array.isArray(prev) ? prev : [String(prev)];
  res.setHeader('Set-Cookie', [...list, cookie]);
}

/** Read one cookie from a raw Cookie header (no cookie-parser in this app). */
export function readCookie(header: unknown, name: string): string | null {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

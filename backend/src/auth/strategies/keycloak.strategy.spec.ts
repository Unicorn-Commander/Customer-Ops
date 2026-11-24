import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';
import { createHash } from 'crypto';
import { KeycloakStrategy } from './keycloak.strategy';
import { SingleUseTokenStore } from '../../common/security/single-use-token.store';
import { RedisService } from '../../common/redis/redis.service';
import { KEYCLOAK_STATE_COOKIE } from './keycloak-state.store';

const singleUse = () => new SingleUseTokenStore({ client: null } as unknown as RedisService);

describe('KeycloakStrategy self-host endpoints', () => {
  const auth = { validateKeycloakUser: jest.fn() };
  const create = (config: Record<string, string> = {}) =>
    new KeycloakStrategy(new ConfigService(config), auth as unknown as AuthService, singleUse());
  const endpoints = (strategy: KeycloakStrategy) => (strategy as any)._oauth2;

  afterEach(() => jest.restoreAllMocks());

  it('defaults to a local realm without a suite identity provider', () => {
    const oauth = endpoints(create());
    expect(oauth._authorizeUrl).toBe(
      'http://127.0.0.1:8080/realms/customer-ops/protocol/openid-connect/auth',
    );
    expect(oauth._accessTokenUrl).toBe(
      'http://127.0.0.1:8080/realms/customer-ops/protocol/openid-connect/token',
    );
  });

  it('preserves a configured single identity-provider URL', () => {
    const oauth = endpoints(
      create({ KEYCLOAK_URL: 'https://identity.example.test', KEYCLOAK_REALM: 'existing' }),
    );
    expect(oauth._authorizeUrl).toBe(
      'https://identity.example.test/realms/existing/protocol/openid-connect/auth',
    );
    expect(oauth._accessTokenUrl).toBe(
      'https://identity.example.test/realms/existing/protocol/openid-connect/token',
    );
  });

  it('uses the public URL for the browser and the internal URL for code exchange', () => {
    const oauth = endpoints(
      create({
        KEYCLOAK_URL: 'http://keycloak:8080/',
        KEYCLOAK_PUBLIC_URL: 'http://127.0.0.1:8080/',
      }),
    );
    expect(oauth._authorizeUrl).toBe(
      'http://127.0.0.1:8080/realms/customer-ops/protocol/openid-connect/auth',
    );
    expect(oauth._accessTokenUrl).toBe(
      'http://keycloak:8080/realms/customer-ops/protocol/openid-connect/token',
    );
  });

  it('fetches userinfo inside the compose network before resolving the identity', async () => {
    const profile = { sub: 'local-admin', email: 'admin@example.invalid', email_verified: true };
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => profile,
    } as Response);
    const strategy = create({ KEYCLOAK_URL: 'http://keycloak:8080' });
    await strategy.validate('test-access-token', '', {});
    expect(fetcher).toHaveBeenCalledWith(
      'http://keycloak:8080/realms/customer-ops/protocol/openid-connect/userinfo',
      { headers: { Authorization: 'Bearer test-access-token' } },
    );
    expect(auth.validateKeycloakUser).toHaveBeenCalledWith(
      'local-admin',
      profile,
      'test-access-token',
    );
  });
});

/**
 * CUO-CB-1: login CSRF. The login leg must send state + PKCE S256 and set a
 * signed __Host- cookie; the callback must refuse a missing, foreign or replayed
 * state BEFORE the token-endpoint call, and a normal login still works.
 */
describe('KeycloakStrategy state + PKCE (login CSRF)', () => {
  const USER = { id: 'user-1' };
  const auth = { validateKeycloakUser: jest.fn().mockResolvedValue(USER) };
  const config = { JWT_SECRET: 'test-secret-for-state-signing-0123456789' };

  type Outcome = { kind: 'redirect' | 'success' | 'fail' | 'error'; arg: any; status?: any };

  function fakeRes() {
    const headers: Record<string, any> = {};
    return {
      headers,
      getHeader: (k: string) => headers[k.toLowerCase()],
      setHeader: (k: string, v: any) => {
        headers[k.toLowerCase()] = v;
      },
    };
  }

  function makeReq(query: Record<string, string>, cookie?: string) {
    const res = fakeRes();
    const req: any = {
      query,
      headers: { host: 'customerops.example.com', ...(cookie ? { cookie } : {}) },
      url: '/api/v1/auth/keycloak',
      connection: { encrypted: true },
      res,
    };
    return { req, res };
  }

  /** Run one passport authenticate() pass and resolve with its outcome. */
  function run(strategy: KeycloakStrategy, req: any): Promise<Outcome> {
    return new Promise((resolve) => {
      const s = strategy as any;
      s.redirect = (arg: any) => resolve({ kind: 'redirect', arg });
      s.success = (arg: any) => resolve({ kind: 'success', arg });
      s.fail = (arg: any, status?: any) => resolve({ kind: 'fail', arg, status });
      s.error = (arg: any) => resolve({ kind: 'error', arg });
      s.authenticate(req, {});
    });
  }

  function setup() {
    const strategy = new KeycloakStrategy(
      new ConfigService(config),
      auth as unknown as AuthService,
      singleUse(),
    );
    const tokenCall = jest
      .fn()
      .mockImplementation((_code: string, _params: any, cb: any) =>
        cb(null, 'header.e30.sig', 'refresh', {}),
      );
    (strategy as any)._oauth2.getOAuthAccessToken = tokenCall;
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ sub: 'kc-1', email: 'pat@example.com', email_verified: true }),
    } as Response);
    return { strategy, tokenCall };
  }

  /** Start a login; return the state, challenge and the Cookie header to send back. */
  async function startLogin(strategy: KeycloakStrategy) {
    const { req, res } = makeReq({});
    const out = await run(strategy, req);
    expect(out.kind).toBe('redirect');
    const url = new URL(out.arg);
    const setCookie: string[] = res.headers['set-cookie'];
    expect(setCookie).toHaveLength(1);
    const cookie = setCookie[0].split(';')[0];
    return {
      url,
      setCookie: setCookie[0],
      cookie,
      state: url.searchParams.get('state')!,
      challenge: url.searchParams.get('code_challenge')!,
    };
  }

  afterEach(() => jest.restoreAllMocks());

  it('login sends state + S256 challenge and sets a signed __Host- cookie', async () => {
    const { strategy } = setup();
    const login = await startLogin(strategy);
    expect(login.state).toBeTruthy();
    expect(login.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(login.challenge).toBeTruthy();
    expect(login.setCookie.startsWith(`${KEYCLOAK_STATE_COOKIE}=`)).toBe(true);
    expect(login.setCookie).toContain('Path=/');
    expect(login.setCookie).toContain('Secure');
    expect(login.setCookie).toContain('HttpOnly');
    expect(login.setCookie).toContain('SameSite=Lax');
    expect(login.setCookie).not.toMatch(/Domain=/i);
    const maxAge = Number(/Max-Age=(\d+)/.exec(login.setCookie)![1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(600);
    // The cookie value is signed: body.signature.
    expect(login.cookie.split('=')[1]).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  it('a normal login works end to end and sends the matching code_verifier', async () => {
    const { strategy, tokenCall } = setup();
    const login = await startLogin(strategy);
    const { req, res } = makeReq({ code: 'auth-code', state: login.state }, login.cookie);
    const out = await run(strategy, req);
    expect(out.kind).toBe('success');
    expect(out.arg).toBe(USER);
    expect(tokenCall).toHaveBeenCalledTimes(1);
    const verifier = tokenCall.mock.calls[0][1].code_verifier;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(login.challenge);
    // The callback clears the cookie (single use).
    expect(res.headers['set-cookie'][0]).toContain('Max-Age=0');
  });

  it('a replayed callback (same cookie + state) is refused with no token call', async () => {
    const { strategy, tokenCall } = setup();
    const login = await startLogin(strategy);
    const first = await run(
      strategy,
      makeReq({ code: 'c1', state: login.state }, login.cookie).req,
    );
    expect(first.kind).toBe('success');
    const replay = await run(
      strategy,
      makeReq({ code: 'c2', state: login.state }, login.cookie).req,
    );
    expect(replay.kind).toBe('fail');
    expect(replay.status).toBe(403);
    expect(tokenCall).toHaveBeenCalledTimes(1);
  });

  it('a callback with no state cookie is refused with no token call', async () => {
    const { strategy, tokenCall } = setup();
    const login = await startLogin(strategy);
    const out = await run(strategy, makeReq({ code: 'c', state: login.state }).req);
    expect(out.kind).toBe('fail');
    expect(tokenCall).not.toHaveBeenCalled();
  });

  it('a callback with no state param is refused with no token call', async () => {
    const { strategy, tokenCall } = setup();
    const login = await startLogin(strategy);
    const out = await run(strategy, makeReq({ code: 'c' }, login.cookie).req);
    expect(out.kind).toBe('fail');
    expect(tokenCall).not.toHaveBeenCalled();
  });

  it('a foreign state (an attacker login replayed into a victim browser) is refused', async () => {
    const { strategy, tokenCall } = setup();
    const victim = await startLogin(strategy);
    const attacker = await startLogin(strategy);
    const out = await run(
      strategy,
      makeReq({ code: 'attacker-code', state: attacker.state }, victim.cookie).req,
    );
    expect(out.kind).toBe('fail');
    expect(tokenCall).not.toHaveBeenCalled();
  });

  it('a tampered or expired state cookie is refused', async () => {
    const { strategy, tokenCall } = setup();
    const login = await startLogin(strategy);
    const [name, value] = login.cookie.split('=');
    const [body] = value.split('.');
    const tampered = `${name}=${body}.AAAA`;
    const t = await run(strategy, makeReq({ code: 'c', state: login.state }, tampered).req);
    expect(t.kind).toBe('fail');

    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 601_000);
    const e = await run(strategy, makeReq({ code: 'c', state: login.state }, login.cookie).req);
    expect(e.kind).toBe('fail');
    expect(tokenCall).not.toHaveBeenCalled();
  });

  it('fails closed (no redirect) when JWT_SECRET is unset', async () => {
    const strategy = new KeycloakStrategy(
      new ConfigService({}),
      auth as unknown as AuthService,
      singleUse(),
    );
    const out = await run(strategy, makeReq({}).req);
    expect(out.kind).toBe('error');
  });
});

/**
 * CUO-CB-2: a userinfo failure must end in a clean 401 (no `{}` profile resolved
 * into an unhandled 500, no stack to the client).
 */
describe('KeycloakStrategy userinfo failure (clean 401)', () => {
  const auth = { validateKeycloakUser: jest.fn() };
  const strategy = () =>
    new KeycloakStrategy(
      new ConfigService({ JWT_SECRET: 'test-secret-for-state-signing-0123456789' }),
      auth as unknown as AuthService,
      singleUse(),
    );

  beforeEach(() => auth.validateKeycloakUser.mockReset());
  afterEach(() => jest.restoreAllMocks());

  async function expectClean401(p: Promise<unknown>) {
    const err: any = await p.then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.getStatus()).toBe(401);
    const body = JSON.stringify(err.getResponse());
    expect(body).toContain('SSO sign-in failed');
    expect(body).not.toMatch(/stack|at .*\.ts|ECONNREFUSED/);
    expect(auth.validateKeycloakUser).not.toHaveBeenCalled();
  }

  it('a non-2xx userinfo response is a clean 401', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    } as Response);
    await expectClean401(strategy().validate('header.e30.sig', '', {}));
  });

  it('a thrown userinfo fetch is a clean 401', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1'));
    await expectClean401(strategy().validate('header.e30.sig', '', {}));
  });

  it('a userinfo body with no subject is a clean 401', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ email: 'pat@example.com' }),
    } as Response);
    await expectClean401(strategy().validate('header.e30.sig', '', {}));
  });
});

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { AuthService } from './auth.service';
import { MembershipService } from '../common/workspace/membership.service';
import { AuthController } from './auth.controller';

/**
 * SSO return-leg SECURITY CONTRACT (task 2e07f778 — JWT out of the URL).
 *
 * The Keycloak callback MUST NOT redirect with the session JWT in the URL — a
 * URL leaks into proxy / Next access logs, Referer headers, and browser history.
 * Instead it redirects with a single-use exchange CODE that the SPA swaps for the
 * token over POST. These tests pin:
 *   • the callback redirect carries NO `?token=` query param and never the JWT,
 *   • it DOES carry a `?code=` param, and that code exchanges back to the exact
 *     session token (login → dashboard still works),
 *   • a code is single-use (a replay is rejected),
 *   • an unknown / missing code is rejected.
 */

const SESSION_JWT = 'header.payload.signature-SECRET-session-jwt';
const FRONTEND_URL = 'http://localhost:3001';
const USER = { id: 'user-aaron', email: 'aaron@magicunicorn.tech' } as User;

function build() {
  const authService = {
    generateTokenForUser: jest.fn().mockResolvedValue({
      access_token: SESSION_JWT,
      user: { id: USER.id, email: USER.email },
    }),
  } as unknown as AuthService;

  const configService = {
    get: (key: string, def?: string) => (key === 'FRONTEND_URL' ? FRONTEND_URL : def),
  } as unknown as ConfigService;

  const membership = {} as unknown as MembershipService;

  const controller = new AuthController(authService, configService, membership);
  return { controller, authService };
}

/** Drive the callback and return the URL it redirected to. */
async function runCallback(controller: AuthController): Promise<string> {
  const res = { redirect: jest.fn() };
  await controller.keycloakCallback({ user: USER } as any, res as any);
  expect(res.redirect).toHaveBeenCalledTimes(1);
  return res.redirect.mock.calls[0][0] as string;
}

describe('AuthController — SSO callback (JWT never in the URL)', () => {
  it('redirects with a single-use code, NOT the session token, in the URL', async () => {
    const { controller } = build();
    const url = await runCallback(controller);

    // The headline invariant: no `?token=` query param, and the raw JWT string
    // appears nowhere in the redirect URL.
    expect(url).not.toContain('token=');
    expect(url).not.toContain(SESSION_JWT);

    // It DOES hand off a code to the SPA callback page.
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/auth/sso-callback');
    const code = parsed.searchParams.get('code');
    expect(code).toBeTruthy();
    expect(code).not.toBe(SESSION_JWT);
  });

  it('login → dashboard still works: the code exchanges back to the session token', async () => {
    const { controller } = build();
    const url = await runCallback(controller);
    const code = new URL(url).searchParams.get('code')!;

    const result = await controller.ssoExchange({ code });
    expect(result).toEqual({ access_token: SESSION_JWT });
  });

  it('a code is single-use: replaying a redeemed code is rejected', async () => {
    const { controller } = build();
    const url = await runCallback(controller);
    const code = new URL(url).searchParams.get('code')!;

    await controller.ssoExchange({ code }); // first use succeeds
    await expect(controller.ssoExchange({ code })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown code', async () => {
    const { controller } = build();
    await expect(controller.ssoExchange({ code: 'never-issued' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a missing / non-string code', async () => {
    const { controller } = build();
    await expect(controller.ssoExchange({})).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.ssoExchange({ code: 123 as unknown as string })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('issues a distinct code per login (codes are not reused)', async () => {
    const { controller } = build();
    const code1 = new URL(await runCallback(controller)).searchParams.get('code');
    const code2 = new URL(await runCallback(controller)).searchParams.get('code');
    expect(code1).not.toBe(code2);
  });
});

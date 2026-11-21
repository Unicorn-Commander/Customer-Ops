import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'crypto';
import * as jwt from 'jsonwebtoken';
import {
  HomeSummaryController,
  HomeSummaryFlagGuard,
} from './home-summary.controller';
import { ServiceCallerGuard, VerifyHomeCallerKey, verifyHomeCaller } from './home-summary.caller';
import { HomeSummaryService } from './home-summary.service';

/**
 * The HTTP half of HOME-SUMMARY CONTRACT v1: the flag gate (off => 404 as if the
 * route did not exist, checked BEFORE auth) and the caller fence (only the
 * Ops-Center Home service account: a client_credentials RS256 token signed by the
 * realm key, iss == the realm issuer, azp == HOME_CALLER_CLIENT_ID). These are
 * never allowed to leak data: every failure is the one 401 shape.
 */
function makeConfig(values: Record<string, string> = {}) {
  return new ConfigService(values);
}

const ISSUER = 'https://auth.example.com/realms/uchub';
const KID = 'unit-key';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const resolveKey: VerifyHomeCallerKey = async () => pem;

const baseConfig = {
  KEYCLOAK_URL: 'https://auth.example.com',
  KEYCLOAK_REALM: 'uchub',
  HOME_CALLER_CLIENT_ID: 'ops-center-home',
};

function sign(claims: Record<string, unknown> = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: 'kc-home-caller',
      iss: ISSUER,
      aud: 'customer-ops',
      azp: 'ops-center-home',
      client_id: 'ops-center-home',
      iat: now - 10,
      exp: now + 300,
      ...claims,
    },
    key,
    { algorithm: 'RS256', keyid: KID },
  );
}

function makeContext(rawToken: string | null, request: any = {}) {
  if (rawToken) request.headers = { authorization: `Bearer ${rawToken}` };
  return { switchToHttp: () => ({ getRequest: () => request }) } as any;
}

const is401 = { status: 401, response: { error: 'caller_not_allowed' } } as any;

describe('ServiceCallerGuard (verifies the service token itself)', () => {
  it('lets the Ops-Center Home service account through and stashes azp', async () => {
    const guard = new ServiceCallerGuard(makeConfig(baseConfig), resolveKey);
    const request: any = {};
    await expect(guard.canActivate(makeContext(sign(), request))).resolves.toBe(true);
    expect(request.homeCallerAzp).toBe('ops-center-home');
  });

  it('refuses a person token (verified email, no client identity)', async () => {
    const guard = new ServiceCallerGuard(makeConfig(baseConfig), resolveKey);
    const token = sign({
      azp: 'ops-center-home',
      email: 'person@example.com',
      email_verified: true,
      client_id: undefined,
    });
    await expect(guard.canActivate(makeContext(token))).rejects.toMatchObject(is401);
  });

  it('refuses another client even with the right shape', async () => {
    const guard = new ServiceCallerGuard(makeConfig(baseConfig), resolveKey);
    const token = sign({ azp: 'some-other-client', client_id: 'some-other-client' });
    await expect(guard.canActivate(makeContext(token))).rejects.toMatchObject(is401);
  });

  it('refuses a delegated (act) token and a missing token', async () => {
    const guard = new ServiceCallerGuard(makeConfig(baseConfig), resolveKey);
    const delegated = sign({ act: { sub: 'someone' } });
    await expect(guard.canActivate(makeContext(delegated))).rejects.toMatchObject(is401);
    await expect(guard.canActivate(makeContext(null))).rejects.toMatchObject(is401);
  });

  it('refuses a bad signature', async () => {
    const guard = new ServiceCallerGuard(makeConfig(baseConfig), resolveKey);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await expect(guard.canActivate(makeContext(sign({}, other)))).rejects.toMatchObject(is401);
  });

  it('refuses an expired token', async () => {
    const guard = new ServiceCallerGuard(makeConfig(baseConfig), resolveKey);
    const now = Math.floor(Date.now() / 1000);
    await expect(
      guard.canActivate(makeContext(sign({ iat: now - 600, exp: now - 60 }))),
    ).rejects.toMatchObject(is401);
  });

  it('refuses a token from a Brigade federation issuer (only the realm issuer is trusted)', async () => {
    const guard = new ServiceCallerGuard(makeConfig(baseConfig), resolveKey);
    const token = sign({ iss: 'https://brigade.example.com' });
    await expect(guard.canActivate(makeContext(token))).rejects.toMatchObject(is401);
  });

  it('reads the expected client id from env (HOME_CALLER_CLIENT_ID)', async () => {
    const guard = new ServiceCallerGuard(
      makeConfig({ ...baseConfig, HOME_CALLER_CLIENT_ID: 'custom-home-caller' }),
      resolveKey,
    );
    const token = sign({ azp: 'custom-home-caller', client_id: 'custom-home-caller' });
    await expect(guard.canActivate(makeContext(token))).resolves.toBe(true);
  });

  it('fails closed when the realm is not configured (no new trust root invented)', async () => {
    const guard = new ServiceCallerGuard(makeConfig({}), resolveKey);
    await expect(guard.canActivate(makeContext(sign()))).rejects.toMatchObject(is401);
    await expect(
      verifyHomeCaller(sign(), resolveKey, null, 'ops-center-home'),
    ).rejects.toMatchObject(is401);
  });
});

describe('HomeSummaryFlagGuard', () => {
  it('404s as if the route did not exist when HOME_SUMMARY_ENABLED is off', () => {
    const guard = new HomeSummaryFlagGuard(new ConfigService({}));
    expect(() => guard.canActivate({} as any)).toThrow(NotFoundException);
    expect(
      () => new HomeSummaryFlagGuard(new ConfigService({ HOME_SUMMARY_ENABLED: 'false' })).canActivate({} as any),
    ).toThrow(NotFoundException);
  });

  it('passes when HOME_SUMMARY_ENABLED is on', () => {
    const guard = new HomeSummaryFlagGuard(new ConfigService({ HOME_SUMMARY_ENABLED: 'true' }));
    expect(guard.canActivate({} as any)).toBe(true);
  });
});

describe('HomeSummaryController', () => {
  function makeController(
    summary: any,
    configValues: Record<string, string> = { HOME_SUMMARY_ENABLED: 'true' },
  ) {
    const service = { forPerson: jest.fn().mockResolvedValue(summary) };
    const controller = new HomeSummaryController(service as any, makeConfig(configValues));
    return { controller, service };
  }

  const summary = { state: 'ok', updatedAt: '2026-11-21T00:00:00.000Z', metrics: [], items: [] };

  it('404s as if the route did not exist when HOME_SUMMARY_ENABLED is off', async () => {
    const { controller, service } = makeController(summary, {});
    await expect(controller.home({ homeCallerAzp: 'ops-center-home' }, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(service.forPerson).not.toHaveBeenCalled();
  });

  it('404s when the flag is explicitly false', async () => {
    const { controller } = makeController(summary, { HOME_SUMMARY_ENABLED: 'false' });
    await expect(controller.home({ homeCallerAzp: 'ops-center-home' }, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('400s when the caller names no email or workspace (the service token alone sees nothing)', async () => {
    const { controller, service } = makeController(summary);
    await expect(
      controller.home({ homeCallerAzp: 'ops-center-home' }, { workspace: 'ws-1' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.home({ homeCallerAzp: 'ops-center-home' }, { email: 'a@example.com' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(service.forPerson).not.toHaveBeenCalled();
  });

  it('answers the summary for the named person when the flag is on', async () => {
    const { controller, service } = makeController(summary);
    await expect(
      controller.home(
        { homeCallerAzp: 'ops-center-home' },
        { email: '  Person@Example.com ', workspace: 'ws-1', org: 'ops-org', sub: 'kc' },
      ),
    ).resolves.toEqual(summary);
    expect(service.forPerson).toHaveBeenCalledWith({
      email: 'person@example.com',
      workspace: 'ws-1',
      azp: 'ops-center-home',
    });
  });
});

describe('HomeSummaryService wiring type', () => {
  it('is injectable by the controller (constructor shape)', () => {
    expect(typeof HomeSummaryService).toBe('function');
  });
});

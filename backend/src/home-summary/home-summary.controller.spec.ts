import { HttpException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CallerGuard,
  HomeSummaryController,
  ServiceCallerGuard,
  serviceCallerGuard,
} from './home-summary.controller';
import { HomeSummaryService } from './home-summary.service';

/**
 * The HTTP half of HOME-SUMMARY CONTRACT v1: the flag gate (off => 404 as if the
 * route did not exist) and the caller fence (only the Ops-Center Home service
 * account, a client_credentials token with azp == HOME_CALLER_CLIENT_ID). These
 * are never allowed to leak data: every failure is the one 401 shape.
 */
function makeConfig(values: Record<string, string> = {}) {
  return new ConfigService(values);
}

function makeContext(options: {
  user?: any;
  rawToken?: string | null;
  payload?: any;
  query?: Record<string, string>;
}) {
  const request: any = {
    user: options.user,
    query: options.query ?? {},
    headers: options.rawToken ? { authorization: `Bearer ${options.rawToken}` } : {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as any;
}

const decodeFrom = (payload: any) => () => payload;

describe('ServiceCallerGuard', () => {
  it('lets the Ops-Center Home service account through', async () => {
    const guard = serviceCallerGuard(
      makeConfig({ HOME_CALLER_CLIENT_ID: 'ops-center-home' }),
      decodeFrom({ azp: 'ops-center-home', client_id: 'ops-center-home', exp: 9999999999 }),
    );
    const request: any = {};
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as any;

    expect(guard.canActivate(context)).toBe(true);
  });

  it('refuses a person token (verified email, no client identity) with 401 caller_not_allowed', async () => {
    const guard = serviceCallerGuard(
      makeConfig(),
      decodeFrom({
        azp: 'ops-center-home',
        email: 'person@example.com',
        email_verified: true,
        exp: 9999999999,
      }),
    );
    const context = makeContext({ rawToken: 'person-token' });

    expect(() => guard.canActivate(context)).toThrow(
      expect.objectContaining({ status: 401, response: { error: 'caller_not_allowed' } }) as any,
    );
  });

  it('refuses another client even with the right shape', async () => {
    const guard = serviceCallerGuard(
      makeConfig(),
      decodeFrom({ azp: 'some-other-client', client_id: 'some-other-client', exp: 9999999999 }),
    );
    const context = makeContext({ rawToken: 'other-client-token' });

    expect(() => guard.canActivate(context)).toThrow(HttpException);
    expect(() => guard.canActivate(context)).toThrow(
      expect.objectContaining({ response: { error: 'caller_not_allowed' } }) as any,
    );
  });

  it('refuses a delegated (act) token and a missing token', async () => {
    const delegated = serviceCallerGuard(
      makeConfig(),
      decodeFrom({
        azp: 'ops-center-home',
        client_id: 'ops-center-home',
        act: { sub: 'someone' },
        exp: 9999999999,
      }),
    );
    expect(() => delegated.canActivate(makeContext({ rawToken: 'x' }))).toThrow(
      expect.objectContaining({ response: { error: 'caller_not_allowed' } }) as any,
    );

    const noToken = serviceCallerGuard(makeConfig(), decodeFrom(undefined));
    expect(() => noToken.canActivate(makeContext({ rawToken: null }))).toThrow(
      expect.objectContaining({ status: 401, response: { error: 'caller_not_allowed' } }) as any,
    );
  });

  it('reads the expected client id from env (HOME_CALLER_CLIENT_ID)', async () => {
    const guard = serviceCallerGuard(
      makeConfig({ HOME_CALLER_CLIENT_ID: 'custom-home-caller' }),
      decodeFrom({ azp: 'custom-home-caller', client_id: 'custom-home-caller', exp: 9999999999 }),
    );
    expect(guard.canActivate(makeContext({ rawToken: 'svc' }))).toBe(true);
  });

  it('exposes the same guard through the CallerGuard mixin without touching a DB', () => {
    expect(CallerGuard).toBe(ServiceCallerGuard);
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

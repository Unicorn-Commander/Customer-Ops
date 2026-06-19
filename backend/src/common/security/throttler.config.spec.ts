import { ConfigService } from '@nestjs/config';
import { buildThrottlers, RATE_LIMIT_DEFAULTS } from './throttler.config';

/**
 * Pins the rate-limit env contract.
 *
 * The two named throttlers ('short' burst + 'long' sustained) were hard-coded;
 * making them env-tunable (RATE_LIMIT_*) must keep EXACTLY the prior values as
 * defaults so an existing deploy is unchanged, AND must be fail-SAFE: a missing,
 * zero, or garbage value falls back to the default rather than disabling the
 * limiter (fail-open would silently drop the moat).
 */
function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

describe('buildThrottlers — env-tunable rate limits', () => {
  it('defaults to the prior hard-coded windows when no env is set', () => {
    const [shortT, longT] = buildThrottlers(makeConfig({}));
    expect(shortT).toMatchObject({
      name: 'short',
      ttl: RATE_LIMIT_DEFAULTS.shortTtlMs,
      limit: RATE_LIMIT_DEFAULTS.shortLimit,
    });
    expect(longT).toMatchObject({
      name: 'long',
      ttl: RATE_LIMIT_DEFAULTS.longTtlMs,
      limit: RATE_LIMIT_DEFAULTS.longLimit,
    });
    // The defaults ARE the documented pre-hardening behavior.
    expect(RATE_LIMIT_DEFAULTS).toEqual({
      shortTtlMs: 60_000,
      shortLimit: 20,
      longTtlMs: 3_600_000,
      longLimit: 200,
    });
  });

  it('honors valid overrides', () => {
    const [shortT, longT] = buildThrottlers(
      makeConfig({
        RATE_LIMIT_SHORT_TTL_MS: '1000',
        RATE_LIMIT_SHORT_LIMIT: '5',
        RATE_LIMIT_LONG_TTL_MS: '120000',
        RATE_LIMIT_LONG_LIMIT: '50',
      }),
    );
    expect(shortT).toMatchObject({ ttl: 1000, limit: 5 });
    expect(longT).toMatchObject({ ttl: 120000, limit: 50 });
  });

  it('falls back to defaults for zero / negative / garbage (fail-safe, never fail-open)', () => {
    const [shortT, longT] = buildThrottlers(
      makeConfig({
        RATE_LIMIT_SHORT_TTL_MS: '0', // would disable the window if honored
        RATE_LIMIT_SHORT_LIMIT: '-1',
        RATE_LIMIT_LONG_TTL_MS: 'abc',
        RATE_LIMIT_LONG_LIMIT: '   ',
      }),
    );
    expect(shortT).toMatchObject({
      ttl: RATE_LIMIT_DEFAULTS.shortTtlMs,
      limit: RATE_LIMIT_DEFAULTS.shortLimit,
    });
    expect(longT).toMatchObject({
      ttl: RATE_LIMIT_DEFAULTS.longTtlMs,
      limit: RATE_LIMIT_DEFAULTS.longLimit,
    });
  });

  it('floors fractional values to an integer window', () => {
    const [shortT] = buildThrottlers(makeConfig({ RATE_LIMIT_SHORT_LIMIT: '7.9' }));
    expect(shortT.limit).toBe(7);
  });
});

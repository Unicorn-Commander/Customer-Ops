import { bodyLimit, helmetOptions, DEFAULT_BODY_LIMIT } from './security.config';

/**
 * Pins the bootstrap HTTP-hardening posture (CSP + HSTS + body cap).
 *
 * These are pure builders consumed by main.ts. The contract: a safe production
 * default with NO required env, a CSP locked to 'self' that still lets Swagger
 * UI render, HSTS asserted, and a body cap that is tunable but never
 * accidentally unbounded.
 */
describe('bodyLimit', () => {
  it('defaults to 1mb when BODY_LIMIT is unset/blank', () => {
    expect(bodyLimit({})).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimit({ BODY_LIMIT: '   ' })).toBe(DEFAULT_BODY_LIMIT);
  });

  it('accepts well-formed size tokens', () => {
    expect(bodyLimit({ BODY_LIMIT: '256kb' })).toBe('256kb');
    expect(bodyLimit({ BODY_LIMIT: '2mb' })).toBe('2mb');
    expect(bodyLimit({ BODY_LIMIT: '500000' })).toBe('500000');
  });

  it('rejects garbage and falls back to the default (never unbounded)', () => {
    expect(bodyLimit({ BODY_LIMIT: 'unlimited' })).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimit({ BODY_LIMIT: '5; rm -rf' })).toBe(DEFAULT_BODY_LIMIT);
  });
});

describe('helmetOptions', () => {
  it('locks CSP to self-only with deny-by-default object/base directives', () => {
    const opts = helmetOptions({});
    const csp = opts.contentSecurityPolicy;
    // Typed as object form here (we always pass directives).
    const directives = (csp as { directives: Record<string, string[]> }).directives;
    expect(directives.defaultSrc).toEqual(["'self'"]);
    expect(directives.objectSrc).toEqual(["'none'"]);
    expect(directives.baseUri).toEqual(["'self'"]);
    expect(directives.frameAncestors).toEqual(["'self'"]);
  });

  it('grants Swagger UI its inline script/style by default', () => {
    const directives = (
      helmetOptions({}).contentSecurityPolicy as { directives: Record<string, string[]> }
    ).directives;
    expect(directives.scriptSrc).toContain("'unsafe-inline'");
    expect(directives.styleSrc).toContain("'unsafe-inline'");
  });

  it('removes the Swagger inline grants under SWAGGER_CSP_RELAXED=false (strictest)', () => {
    const directives = (
      helmetOptions({ SWAGGER_CSP_RELAXED: 'false' }).contentSecurityPolicy as {
        directives: Record<string, string[]>;
      }
    ).directives;
    expect(directives.scriptSrc).toEqual(["'self'"]);
    expect(directives.styleSrc).toEqual(["'self'"]);
  });

  it('enables HSTS with subdomains and a multi-month max-age', () => {
    const hsts = helmetOptions({}).strictTransportSecurity as {
      maxAge: number;
      includeSubDomains: boolean;
    };
    expect(hsts.includeSubDomains).toBe(true);
    expect(hsts.maxAge).toBeGreaterThanOrEqual(60 * 60 * 24 * 90); // >= 90 days
  });
});

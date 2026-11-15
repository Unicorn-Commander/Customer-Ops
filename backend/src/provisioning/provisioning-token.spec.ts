/**
 * The control-plane service token check (contract D) and the provisioning flag.
 * Pure unit: no database, no network.
 */
import {
  ExecutionContext,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { ProvisioningJtiStore } from './provisioning-jti.store';
import { ProvisioningTokenService } from './provisioning-token.service';
import { ProvisioningGuard } from './provisioning.guard';
import { ProvisioningModule } from './provisioning.module';
import { ProvisioningController } from './provisioning.controller';
import { MemberPauseController } from './member-pause.controller';
import { provisioningEnabled } from './provisioning.config';

const SECRET = 'unit-test-provisioning-secret-0123456789abcdef'; // fictional, > 32 bytes
const NOW_S = 1_900_000_000;

function sign(
  overrides: Record<string, unknown> = {},
  opts: jwt.SignOptions = {},
  secret = SECRET,
) {
  const claims: Record<string, unknown> = {
    iss: 'ops-center',
    aud: 'customer-ops',
    iat: NOW_S,
    exp: NOW_S + 60,
    jti: randomUUID(),
    ...overrides,
  };
  for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
  // jsonwebtoken adds `iat` unless told not to; only suppress it to test its absence.
  const noTimestamp = claims.iat === undefined;
  return jwt.sign(claims, secret, { algorithm: 'HS256', noTimestamp, ...opts });
}

function service(capacity = 100) {
  const store = new ProvisioningJtiStore(capacity, () => NOW_S * 1000);
  const svc = new ProvisioningTokenService(store);
  svc.now = () => NOW_S * 1000;
  return svc;
}

describe('ProvisioningTokenService', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('accepts a well-formed control-plane token once', () => {
    const svc = service();
    const token = sign();
    expect(svc.verify(token, SECRET).iss).toBe('ops-center');
    expect(() => svc.verify(token, SECRET)).toThrow(UnauthorizedException); // replayed jti
  });

  it.each([
    ['wrong issuer', () => sign({ iss: 'someone-else' })],
    ['wrong audience', () => sign({ aud: 'project-ops' })],
    ['expired', () => sign({ iat: NOW_S - 120, exp: NOW_S - 60 })],
    ['lifetime over 60 seconds', () => sign({ exp: NOW_S + 61 })],
    ['iat in the future', () => sign({ iat: NOW_S + 6, exp: NOW_S + 30 })],
    ['missing iat', () => sign({ iat: undefined })],
    ['missing exp', () => sign({ exp: undefined })],
    ['missing jti', () => sign({ jti: undefined })],
    ['blank jti', () => sign({ jti: '  ' })],
    ['another secret', () => sign({}, {}, 'a-different-secret-that-is-long-enough-000')],
    ['HS512 instead of HS256', () => sign({}, { algorithm: 'HS512' })],
    ['unsigned (alg none)', () => sign({}, { algorithm: 'none' })],
  ])('refuses %s with 401', (_label, make) => {
    expect(() => service().verify(make(), SECRET)).toThrow(UnauthorizedException);
  });

  it('allows iat up to five seconds ahead (clock skew)', () => {
    expect(() => service().verify(sign({ iat: NOW_S + 5, exp: NOW_S + 30 }), SECRET)).not.toThrow();
  });

  it('honours PROVISIONING_JWT_AUDIENCE', () => {
    process.env.PROVISIONING_JWT_AUDIENCE = 'customer-ops-staging';
    expect(() => service().verify(sign(), SECRET)).toThrow(UnauthorizedException);
    expect(() => service().verify(sign({ aud: 'customer-ops-staging' }), SECRET)).not.toThrow();
  });

  it('fails closed with 503 when the jti store is full of live entries', () => {
    const svc = service(2);
    svc.verify(sign(), SECRET);
    svc.verify(sign(), SECRET);
    expect(() => svc.verify(sign(), SECRET)).toThrow(ServiceUnavailableException);
  });

  it('frees a jti slot once that token has expired', () => {
    let nowMs = NOW_S * 1000;
    const store = new ProvisioningJtiStore(1, () => nowMs);
    expect(store.accept('a', nowMs + 60_000)).toBe(true);
    expect(() => store.accept('b', nowMs + 60_000)).toThrow(ServiceUnavailableException);
    nowMs += 61_000;
    expect(store.accept('b', nowMs + 60_000)).toBe(true);
    expect(store.size).toBe(1);
  });

  it('never logs the secret or the token', () => {
    const svc = service();
    const logs: string[] = [];
    const logger = (svc as unknown as { logger: Record<string, (m: string) => void> }).logger;
    logger.warn = (m: string) => logs.push(m);
    logger.error = (m: string) => logs.push(m);
    const token = sign({ iss: 'nope' });
    expect(() => svc.verify(token, SECRET)).toThrow();
    process.env.PROVISIONING_JWT_SECRET = 'short-secret';
    expect(svc.secret()).toBeNull();
    expect(svc.secret()).toBeNull();
    expect(logs.filter((l) => l.includes('PROVISIONING_JWT_SECRET'))).toHaveLength(1); // once, by name
    for (const line of logs) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain('short-secret');
      expect(line).not.toContain(token);
    }
  });
});

describe('ProvisioningGuard', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });
  const ctx = (authorization?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          originalUrl: '/api/v1/provisioning/workspaces/w1',
          headers: authorization ? { authorization } : {},
        }),
      }),
    }) as unknown as ExecutionContext;

  it('answers 404, as if disabled, when the secret is shorter than 32 bytes', () => {
    process.env.PROVISIONING_JWT_SECRET = 'x'.repeat(31);
    const guard = new ProvisioningGuard(service());
    expect(() => guard.canActivate(ctx(`Bearer ${sign()}`))).toThrow(NotFoundException);
    delete process.env.PROVISIONING_JWT_SECRET;
    expect(() => guard.canActivate(ctx(`Bearer ${sign()}`))).toThrow(NotFoundException);
  });

  it('requires a bearer and accepts a valid one', () => {
    process.env.PROVISIONING_JWT_SECRET = SECRET;
    const guard = new ProvisioningGuard(service());
    expect(() => guard.canActivate(ctx())).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx('Basic abc'))).toThrow(UnauthorizedException);
    expect(guard.canActivate(ctx(`Bearer ${sign()}`))).toBe(true);
  });
});

describe('PROVISIONING_ENABLED', () => {
  it('is off by default and registers no route when off', () => {
    expect(provisioningEnabled(() => undefined)).toBe(false);
    expect(provisioningEnabled(() => 'false')).toBe(false);
    expect(provisioningEnabled(() => 'true')).toBe(true);
    expect(ProvisioningModule.register(false).controllers ?? []).toHaveLength(0);
    expect(ProvisioningModule.register(true).controllers).toEqual([
      ProvisioningController,
      MemberPauseController,
    ]);
  });
});

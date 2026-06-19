import { ConfigService } from '@nestjs/config';
import { ErrorTrackingService } from './error-tracking.service';

/**
 * Pins the degrade-clean contract of the error-tracking seam.
 *
 * Suite rule: a new external dependency must NO-OP cleanly when unconfigured and
 * never throw. With SENTRY_DSN unset, capture() must do nothing observable (no
 * emission) and isEnabled must be false. With it set, capture() emits exactly
 * one structured fault line — and even then a sink error must be swallowed so a
 * tracker outage can never turn a 500 into a crash loop.
 */
function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

describe('ErrorTrackingService — degrade-clean', () => {
  it('is disabled and a no-op when SENTRY_DSN is unset', () => {
    const svc = new ErrorTrackingService(makeConfig({}));
    expect(svc.isEnabled).toBe(false);
    // The disabled path must not even reach the logger.
    const spy = jest.spyOn((svc as any).logger, 'error');
    svc.capture(new Error('boom'), { requestId: 'r1' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('captures exactly one structured fault line when a DSN is configured', () => {
    const svc = new ErrorTrackingService(makeConfig({ SENTRY_DSN: 'https://k@sentry.test/1' }));
    expect(svc.isEnabled).toBe(true);
    const spy = jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);

    svc.capture(new Error('kaboom'), {
      requestId: 'req-9',
      method: 'POST',
      path: '/api/v1/leads',
      status: 500,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(line).toContain('tracked-fault');
    expect(line).toContain('req-9');
    expect(line).toContain('kaboom');
    // The DSN value itself must never be logged.
    expect(line).not.toContain('sentry.test');
  });

  it('never throws if the sink itself errors (tracker outage is non-fatal)', () => {
    const svc = new ErrorTrackingService(makeConfig({ SENTRY_DSN: 'https://k@sentry.test/1' }));
    jest.spyOn((svc as any).logger, 'error').mockImplementation(() => {
      throw new Error('sink down');
    });
    const debug = jest.spyOn((svc as any).logger, 'debug').mockImplementation(() => undefined);

    expect(() => svc.capture(new Error('x'))).not.toThrow();
    expect(debug).toHaveBeenCalled();
  });
});

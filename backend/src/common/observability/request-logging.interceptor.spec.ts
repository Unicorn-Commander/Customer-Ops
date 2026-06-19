import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, throwError, lastValueFrom } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { RequestLoggingInterceptor } from './request-logging.interceptor';

/**
 * Pins the PII-safe access log.
 *
 * The interceptor emits ONE line per request: `method path -> status (ms) [id]`.
 * It must NEVER serialize a body, header, or query string (those carry tokens /
 * contacts / secrets), it must strip the query from the path, and it must skip
 * the health probes (constant polling = log noise). It logs 5xx at error, all
 * else at log, on BOTH the success and the error paths (so a thrown handler is
 * still recorded exactly once — the filter owns the response).
 */
function makeContext(req: any, statusCode: number): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

function spies(interceptor: RequestLoggingInterceptor) {
  const log = jest
    .spyOn((interceptor as any).logger, 'log')
    .mockImplementation(() => undefined);
  const error = jest
    .spyOn((interceptor as any).logger, 'error')
    .mockImplementation(() => undefined);
  return { log, error };
}

describe('RequestLoggingInterceptor — one PII-safe line per request', () => {
  it('logs method, query-stripped path, status, and request-id on success', async () => {
    const interceptor = new RequestLoggingInterceptor();
    const { log } = spies(interceptor);
    const ctx = makeContext(
      { method: 'GET', originalUrl: '/api/v1/customers?secret=tok', id: 'req-7' },
      200,
    );
    const next: CallHandler = { handle: () => of({ ok: true }) };

    await lastValueFrom(interceptor.intercept(ctx, next));

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(line).toMatch(/^GET \/api\/v1\/customers -> 200 \(\d+ms\) \[req-7\]$/);
    // The query (token) must NOT appear anywhere in the line.
    expect(line).not.toContain('secret');
    expect(line).not.toContain('tok');
  });

  it('logs at error level for a 5xx', async () => {
    const interceptor = new RequestLoggingInterceptor();
    const { log, error } = spies(interceptor);
    const ctx = makeContext({ method: 'POST', originalUrl: '/api/v1/leads', id: 'r' }, 500);
    const next: CallHandler = { handle: () => of(null) };

    await lastValueFrom(interceptor.intercept(ctx, next));

    expect(error).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('still emits exactly one line when the handler throws', async () => {
    const interceptor = new RequestLoggingInterceptor();
    const { log } = spies(interceptor);
    const ctx = makeContext({ method: 'GET', originalUrl: '/api/v1/x', id: 'r' }, 200);
    const next: CallHandler = { handle: () => throwError(() => new Error('boom')) };

    await lastValueFrom(
      interceptor.intercept(ctx, next).pipe(catchError(() => of('swallowed'))),
    );

    expect(log).toHaveBeenCalledTimes(1);
  });

  it('skips the health probes entirely — bare AND under the global api/v1 prefix', async () => {
    const interceptor = new RequestLoggingInterceptor();
    const { log, error } = spies(interceptor);
    // The running app mounts under API_PREFIX (api/v1), so probes actually arrive
    // as `/api/v1/health…`. Both the bare and prefixed forms must be silenced.
    for (const path of [
      '/health',
      '/health/live',
      '/health/ready',
      '/api/v1/health',
      '/api/v1/health/live',
      '/api/v1/health/ready',
    ]) {
      const ctx = makeContext({ method: 'GET', originalUrl: path, id: 'r' }, 200);
      await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(1) }));
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('still logs a non-probe path that merely contains "health" as a substring', async () => {
    const interceptor = new RequestLoggingInterceptor();
    const { log } = spies(interceptor);
    // `/api/v1/healthz` and `/api/v1/customers/health-score` must NOT be silenced
    // (the leading-slash suffix guards against substring false-positives).
    for (const path of ['/api/v1/healthz', '/api/v1/customers/health-score']) {
      const ctx = makeContext({ method: 'GET', originalUrl: path, id: 'r' }, 200);
      await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(1) }));
    }
    expect(log).toHaveBeenCalledTimes(2);
  });
});

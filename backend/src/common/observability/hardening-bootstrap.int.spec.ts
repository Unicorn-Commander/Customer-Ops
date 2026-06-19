/**
 * Bootstrap wiring proof — the whole hardening graph runs end-to-end.
 *
 * `tsc` proves types; it does NOT prove Nest's DI container can construct the
 * globally-bound filter (it injects HttpAdapterHost + ErrorTrackingService), the
 * friendly throttler guard (it injects the throttler options/storage/reflector),
 * the request-logging interceptor, AND register the request-id middleware — all
 * from the real AppModule. Those only surface at init/request time.
 *
 * So we boot the real module on an ephemeral port (PrismaService stubbed — no
 * DB) and fire ONE real request at an unknown route. That exercises the live
 * stack: request-id middleware → guard → interceptor → router (404) → the global
 * RFC-7807 filter. We assert the runtime contract:
 *   - the response carries an `X-Request-Id` header (middleware ran),
 *   - the body is `application/problem+json` with the canonical members + the
 *     SAME request id (the filter ran and correlated).
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest } from 'http';
import { AddressInfo } from 'net';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../prisma/prisma.service';
import { ErrorTrackingService } from './error-tracking.service';
import { PROBLEM_JSON_CONTENT_TYPE } from './problem-details';

// A Prisma stand-in: the lifecycle hooks the graph calls on init/destroy, no DB.
class PrismaStub {
  async onModuleInit() {
    /* no DB connect in the wiring test */
  }
  async onModuleDestroy() {
    /* nothing to disconnect */
  }
  async $queryRaw() {
    return [{ ok: 1 }];
  }
}

/** Minimal GET against the booted app; resolves the status, headers, raw body. */
function get(
  port: number,
  path: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('hardening bootstrap wiring (live request)', () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useClass(PrismaStub)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0); // ephemeral port — no contention with parallel agents
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('resolves the degrade-clean error-tracking provider from the real graph', () => {
    expect(app.get(ErrorTrackingService)).toBeInstanceOf(ErrorTrackingService);
  });

  it('stamps X-Request-Id and returns an RFC-7807 body for an unknown route', async () => {
    const res = await get(port, '/api/v1/__definitely_not_a_route__');

    expect(res.status).toBe(404);
    const requestId = res.headers['x-request-id'];
    expect(typeof requestId).toBe('string');
    expect((requestId as string).length).toBeGreaterThan(0);

    expect(res.headers['content-type']).toContain(PROBLEM_JSON_CONTENT_TYPE);
    const problem = JSON.parse(res.body);
    expect(problem).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
    });
    // The body's correlation id matches the response header (filter saw req.id).
    expect(problem.requestId).toBe(requestId);
    // The query-stripped path is the instance.
    expect(problem.instance).toContain('/api/v1/__definitely_not_a_route__');
  });
});

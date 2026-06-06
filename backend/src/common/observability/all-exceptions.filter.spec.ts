import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ErrorTrackingService } from './error-tracking.service';
import { PROBLEM_JSON_CONTENT_TYPE } from './problem-details';

/**
 * Pins the single RFC-7807 error envelope.
 *
 * Two invariants protect the API:
 *   1. 5xx NEVER leak internals — the client gets a generic detail while the
 *      real error is logged + handed to the tracker (with the request-id).
 *   2. 4xx pass their (validator/guard-authored, already safe) message through,
 *      and carry the request-id so a reported error greps to its log line.
 * The body is always `application/problem+json` with the canonical members.
 */
function makeHost(req: any): {
  host: ArgumentsHost;
  reply: jest.Mock;
  res: { setHeader: jest.Mock };
} {
  const reply = jest.fn();
  const res = { setHeader: jest.fn() };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;
  return { host, reply, res };
}

function makeFilter(reply: jest.Mock): {
  filter: AllExceptionsFilter;
  capture: jest.Mock;
} {
  const adapterHost = { httpAdapter: { reply } } as unknown as HttpAdapterHost;
  const capture = jest.fn();
  const tracking = { capture } as unknown as ErrorTrackingService;
  const filter = new AllExceptionsFilter(adapterHost, tracking);
  // Silence the filter's own logger so a 5xx test doesn't spam jest output.
  jest.spyOn((filter as any).logger, 'error').mockImplementation(() => undefined);
  return { filter, capture };
}

const REQ = (over: Record<string, any> = {}) => ({
  id: 'req-123',
  method: 'GET',
  originalUrl: '/api/v1/customers?secret=tok',
  url: '/api/v1/customers?secret=tok',
  ...over,
});

describe('AllExceptionsFilter — RFC-7807 envelope', () => {
  it('shapes a 4xx HttpException, forwarding its safe message + the request-id', () => {
    const { host, reply, res } = makeHost(REQ());
    const { filter, capture } = makeFilter(reply);

    filter.catch(new ForbiddenException('Authentication required.'), host);

    const [, body, status] = reply.mock.calls[0];
    expect(status).toBe(HttpStatus.FORBIDDEN);
    expect(body).toMatchObject({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Authentication required.',
      requestId: 'req-123',
    });
    // instance is the path with the query STRIPPED (no token leakage).
    expect(body.instance).toBe('/api/v1/customers');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', PROBLEM_JSON_CONTENT_TYPE);
    // 4xx is expected traffic — NOT sent to the error tracker.
    expect(capture).not.toHaveBeenCalled();
  });

  it('joins class-validator constraint arrays into the detail', () => {
    const { host, reply } = makeHost(REQ());
    const { filter } = makeFilter(reply);

    filter.catch(
      new BadRequestException({ message: ['name should not be empty', 'email must be an email'] }),
      host,
    );

    const [, body, status] = reply.mock.calls[0];
    expect(status).toBe(400);
    expect(body.detail).toBe('name should not be empty; email must be an email');
  });

  it('renders the friendly 429 from the throttler as problem+json', () => {
    const { host, reply } = makeHost(REQ());
    const { filter } = makeFilter(reply);

    filter.catch(new ThrottlerException('Rate limit exceeded — too many requests. Retry in 5s.'), host);

    const [, body, status] = reply.mock.calls[0];
    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(body.title).toBe('Too Many Requests');
    expect(body.detail).toContain('Rate limit exceeded');
  });

  it('redacts a 5xx: generic detail to client, real error to logger + tracker', () => {
    const { host, reply } = makeHost(REQ({ method: 'POST' }));
    const { filter, capture } = makeFilter(reply);

    filter.catch(new Error('Postgres: password authentication failed for user "x"'), host);

    const [, body, status] = reply.mock.calls[0];
    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.title).toBe('Internal Server Error');
    // The leaky internal must NOT appear in the client body.
    expect(JSON.stringify(body)).not.toContain('password authentication failed');
    expect(body.detail).toContain('request id');
    // The real fault IS routed to the tracker with correlation context.
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][1]).toMatchObject({
      requestId: 'req-123',
      method: 'POST',
      path: '/api/v1/customers',
      status: 500,
    });
  });

  it('maps a raw 503 HttpException through without tracker noise when it is a 5xx', () => {
    // A deliberately-thrown 503 (e.g. readiness failure surfaced as HttpException)
    // is still a server-class status: generic detail + tracked.
    const { host, reply } = makeHost(REQ());
    const { filter, capture } = makeFilter(reply);

    filter.catch(new HttpException('db down', HttpStatus.SERVICE_UNAVAILABLE), host);

    const [, body, status] = reply.mock.calls[0];
    expect(status).toBe(503);
    expect(body.title).toBe('Service Unavailable');
    expect(body.detail).not.toContain('db down'); // 5xx detail is generic
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

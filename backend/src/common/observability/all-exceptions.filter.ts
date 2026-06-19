/**
 * Global exception filter — every error leaves the API as one RFC-7807 body.
 *
 * Catches both `HttpException` (validation 400, auth 401/403, throttle 429, …)
 * and anything else (a thrown `Error`, a rejected promise) and renders the
 * canonical `application/problem+json` envelope (see ./problem-details). One
 * shape means the cockpit + agents branch on `status`/`title` instead of
 * scraping framework-specific bodies, and a 500 a user reports carries the
 * `requestId` to grep straight to its log line.
 *
 * Two safety invariants:
 *   - 5xx NEVER leak internals. We log the real error server-side (with the
 *     request-id) + hand it to the error tracker, but the client gets a generic
 *     "Internal Server Error" detail. 4xx pass their (already safe, validator-
 *     authored) message through.
 *   - It is framework-agnostic via HttpAdapterHost — no direct `res.json`, so it
 *     keeps working if the platform adapter ever changes.
 *
 * Registered as an APP_FILTER in AppModule so it wraps every route globally.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { RequestWithId } from './request-context.middleware';
import { ErrorTrackingService } from './error-tracking.service';
import { PROBLEM_JSON_CONTENT_TYPE, ProblemDetails } from './problem-details';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly errorTracking: ErrorTrackingService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // In the (unlikely) non-HTTP context, there's nothing to respond to.
    if (host.getType() !== 'http') {
      this.logger.error(`non-http exception: ${stringifyError(exception)}`);
      return;
    }

    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<RequestWithId>();
    const res = ctx.getResponse();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const requestId = req?.id;
    // Path only — the query string can carry tokens/PII, so never echo it.
    const path = req?.originalUrl?.split('?')[0] ?? req?.url?.split('?')[0];

    const problem: ProblemDetails = {
      type: 'about:blank',
      title: titleFor(status),
      status,
      detail: detailFor(exception, status),
      instance: path,
      requestId,
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Server fault: log the REAL error (with the id) + hand to the tracker.
      // The client still only ever sees the generic detail set above.
      this.logger.error(
        `${problem.title} [${requestId ?? 'no-id'}] ${req?.method ?? ''} ${path ?? ''} :: ${stringifyError(
          exception,
        )}`,
        exception instanceof Error ? exception.stack : undefined,
      );
      this.errorTracking.capture(exception, {
        requestId,
        method: req?.method,
        path,
        status,
      });
    }

    res.setHeader?.('Content-Type', PROBLEM_JSON_CONTENT_TYPE);
    httpAdapter.reply(res, problem, status);
  }
}

/** Stable per-status human title (RFC-7807 `title`). */
function titleFor(status: number): string {
  return HTTP_STATUS_TITLES[status] ?? defaultTitle(status);
}

function defaultTitle(status: number): string {
  if (status >= 500) return 'Internal Server Error';
  if (status >= 400) return 'Request Error';
  return 'Error';
}

/**
 * The occurrence-specific `detail`. For HttpException we forward the framework
 * message (validator/guard-authored — safe). For a 5xx we deliberately collapse
 * to a generic string so no stack/SQL/secret can leak to the client.
 */
function detailFor(exception: unknown, status: number): string {
  if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
    return 'An unexpected error occurred. Reference the request id when reporting this.';
  }
  if (exception instanceof HttpException) {
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    if (response && typeof response === 'object') {
      const message = (response as { message?: unknown }).message;
      if (typeof message === 'string') return message;
      // class-validator returns an array of constraint strings.
      if (Array.isArray(message)) return message.join('; ');
    }
    return exception.message;
  }
  return defaultTitle(status);
}

/** Best-effort stringify for server-side logging only (never the client). */
function stringifyError(exception: unknown): string {
  if (exception instanceof Error) return `${exception.name}: ${exception.message}`;
  try {
    return JSON.stringify(exception);
  } catch {
    return String(exception);
  }
}

/** Canonical titles for the statuses this API actually emits. */
const HTTP_STATUS_TITLES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'Method Not Allowed',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload Too Large',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
  [HttpStatus.GATEWAY_TIMEOUT]: 'Gateway Timeout',
};

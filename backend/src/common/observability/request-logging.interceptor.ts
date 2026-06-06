/**
 * Structured request logging — one line per request, PII-safe by construction.
 *
 * Emits `method path -> status (Nms) [requestId]` after each request completes.
 * What it deliberately NEVER touches: request/response BODIES, the query string,
 * `Authorization` / `Cookie` / `X-Workspace-Id` headers, or any user field. The
 * safest redactor is the one with nothing to redact — we log only the verb, the
 * route (query stripped), the status, the latency, and the correlation id. That
 * is enough to trace + alert without ever serializing a contact, a token, or a
 * secret.
 *
 * It logs success at `log` and 5xx at `error` (4xx stay at `log` — they are
 * expected client traffic, and the exception filter already owns their detail).
 * Health/readiness probes are skipped so liveness polling doesn't drown the log.
 *
 * Registered as an APP_INTERCEPTOR in AppModule. Adds no required env.
 */

import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RequestWithId } from './request-context.middleware';

/** Route suffixes whose access logs are pure noise (probes hit them constantly). */
const SILENT_PATH_SUFFIXES = ['/health', '/health/live', '/health/ready'];

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const ctx = context.switchToHttp();
    const req = ctx.getRequest<RequestWithId>();
    const res = ctx.getResponse();

    // Strip the query string up front — it can carry tokens/PII and must never
    // reach a log line.
    const path = (req?.originalUrl ?? req?.url ?? '').split('?')[0];
    if (SILENT_PATH_SUFFIXES.includes(path)) return next.handle();

    const method = req?.method ?? '-';
    const requestId = req?.id ?? '-';
    const startedAt = Date.now();

    const finish = () => {
      const ms = Date.now() - startedAt;
      const status = res?.statusCode ?? 0;
      const line = `${method} ${path} -> ${status} (${ms}ms) [${requestId}]`;
      if (status >= 500) this.logger.error(line);
      else this.logger.log(line);
    };

    return next.handle().pipe(
      // `tap` fires on the success path; the error path is handled below so a
      // thrown handler still produces exactly one access line (the filter owns
      // the response shape, we just record that it happened).
      tap({
        next: () => finish(),
        error: () => finish(),
      }),
    );
  }
}

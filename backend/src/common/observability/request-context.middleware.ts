/**
 * Request-id correlation (the first thing every request touches).
 *
 * Assigns a stable id to each request so a log line, an RFC-7807 error body
 * (`requestId`/`instance`), and an error-tracker event all share one key. If an
 * upstream proxy (Traefik) already stamped a trusted correlation header we honor
 * it; otherwise we mint a uuid. The id is exposed three ways:
 *   - `req.id`                  → for downstream interceptors/filters
 *   - `X-Request-Id` response   → so a caller can quote it in a bug report
 *
 * This is a plain Nest middleware (not an interceptor) so it runs BEFORE guards,
 * pipes, and the throttler — meaning even a 401/403/429 carries a request-id.
 * It adds no required env and changes no existing response semantics.
 */

import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { runInEntitlementRequestScope } from '../workspace/entitlement-request-scope';

/** Response + request header carrying the correlation id. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** A request decorated with its resolved correlation id. */
export interface RequestWithId extends Request {
  id?: string;
}

/**
 * Read an inbound id if present + sane, else null. We bound the length and the
 * charset so a hostile client can't smuggle a log-injection / header-splitting
 * payload through the correlation field (it lands in logs + a response header).
 */
function inboundRequestId(req: Request): string | null {
  const raw = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  // Conservative correlation-id alphabet (uuid, ULID, hex, request slugs).
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: RequestWithId, res: Response, next: NextFunction): void {
    const id = inboundRequestId(req) ?? randomUUID();
    req.id = id;
    res.setHeader('X-Request-Id', id);
    // Open the per-request entitlement memo scope here — this middleware already
    // runs before guards, interceptors and handlers, so EVERY server-side
    // entitlement resolve in this request (including the PAT auth chokepoint)
    // shares one answer per workspace instead of re-fetching per call site.
    // See common/workspace/entitlement-request-scope.ts. The store dies with the
    // request, so it adds no cross-request staleness.
    runInEntitlementRequestScope(() => next());
  }
}

/**
 * Error-tracking seam — degrade-clean.
 *
 * The single place the API hands an unexpected exception to an external tracker
 * (Sentry/GlitchTip). It follows the suite degrade-clean rule: with no config
 * (`SENTRY_DSN` unset) it is a NO-OP for the external sink and never throws — the
 * global filter still logs the error locally, so observability never depends on
 * a tracker being wired.
 *
 * Why a seam and not a direct `@sentry/node` call: the SDK is intentionally NOT
 * a dependency yet (keeps the image lean + avoids a network egress surface in
 * the default deploy). When Aaron provisions a DSN, dropping `@sentry/node` in
 * and forwarding `capture()` to `Sentry.captureException` is a one-method change
 * — the call sites (the exception filter) never move.
 *
 * It deliberately captures only server faults (5xx / non-HttpException). Client
 * errors (4xx — validation, auth, throttle) are expected traffic, not incidents,
 * and would bury real signal.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Minimal, PII-light context attached to a captured fault. */
export interface ErrorContext {
  /** Correlation id (mirrors `X-Request-Id`) — the join key to the request log. */
  requestId?: string;
  /** HTTP method, e.g. 'POST'. */
  method?: string;
  /** Route path only — never the query string (it can carry tokens/PII). */
  path?: string;
  /** Resolved HTTP status we are responding with. */
  status?: number;
}

@Injectable()
export class ErrorTrackingService {
  private readonly logger = new Logger(ErrorTrackingService.name);
  /** True once a DSN is configured. Resolved once at construction. */
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.enabled = Boolean(this.config.get<string>('SENTRY_DSN')?.trim());
    if (this.enabled) {
      // We log the FACT that tracking is on, never the DSN value itself.
      this.logger.log('error tracking enabled (SENTRY_DSN set)');
    }
  }

  /** Whether an external tracker is wired. Lets callers branch without leaking
   *  the DSN. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Hand a server fault to the external tracker. NO-OP when unconfigured. Never
   * throws — a tracker outage must never turn a 500 into a crash loop, so any
   * failure here is swallowed (and logged at debug).
   */
  capture(error: unknown, context: ErrorContext = {}): void {
    if (!this.enabled) return;
    try {
      // Forward-compat seam: once `@sentry/node` is a dependency this becomes
      //   Sentry.captureException(error, { tags: { requestId, ... } });
      // Until then we emit a single structured line the host log shipper can
      // forward — observability degrades to logs, never to nothing.
      this.logger.error(
        `tracked-fault ${JSON.stringify({
          requestId: context.requestId,
          method: context.method,
          path: context.path,
          status: context.status,
          error: error instanceof Error ? error.message : String(error),
        })}`,
      );
    } catch (err) {
      this.logger.debug(`error-tracker capture failed: ${(err as Error).message}`);
    }
  }
}

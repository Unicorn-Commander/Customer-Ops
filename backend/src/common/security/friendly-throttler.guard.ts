/**
 * FriendlyThrottlerGuard — the rate limiter with a humane 429.
 *
 * Identical limiting behavior to the stock `@nestjs/throttler` ThrottlerGuard
 * (same storage, same per-route `@Throttle`/`@SkipThrottle` semantics, same
 * `Retry-After` + `X-RateLimit-*` headers the base guard already emits). The
 * only change is the message: the default is the terse, internals-leaking
 * `"ThrottlerException: Too Many Requests"`; we return an actionable sentence
 * that tells the caller WHICH window tripped and to back off + retry.
 *
 * The 429 still flows through the global RFC-7807 filter, so the wire body is a
 * proper `application/problem+json` whose `detail` is this message — consistent
 * with every other error the API returns.
 *
 * Swapped in for ThrottlerGuard at the APP_GUARD binding in app.module. Purely
 * additive: no env, no behavior change beyond the response text.
 */

import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/** The single field of the limit detail we read. Typed structurally so we don't
 *  deep-import `@nestjs/throttler`'s un-re-exported guard.interface; the base
 *  method's `ThrottlerLimitDetail` is assignable to this. */
interface LimitTiming {
  /** Seconds until the tripped window resets (mirrors the `Retry-After` header). */
  timeToExpire?: number;
}

@Injectable()
export class FriendlyThrottlerGuard extends ThrottlerGuard {
  /**
   * The human-readable reason returned in the 429. `timeToExpire` (seconds
   * until the window resets) is surfaced so the caller knows how long to wait;
   * the `Retry-After` header (set by the base guard) carries the same value
   * machine-readably.
   */
  protected async getErrorMessage(
    _context: ExecutionContext,
    throttlerLimitDetail: LimitTiming,
  ): Promise<string> {
    const seconds = throttlerLimitDetail?.timeToExpire;
    const retryHint =
      typeof seconds === 'number' && seconds > 0
        ? ` Retry in ${seconds}s.`
        : ' Please retry shortly.';
    return `Rate limit exceeded — too many requests.${retryHint}`;
  }
}

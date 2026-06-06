/**
 * Rate-limit configuration — env-tunable, defaults == today's behavior.
 *
 * Customer-Ops uses two named throttlers (SUITE convention): a `short` burst
 * window and a `long` sustained window. The limits were hard-coded
 * (short 20/60s, long 200/3600s); this factory keeps EXACTLY those defaults so
 * an existing deploy is unchanged, while letting an operator tune each via env:
 *
 *   RATE_LIMIT_SHORT_TTL_MS   (default 60000)    burst window length
 *   RATE_LIMIT_SHORT_LIMIT    (default 20)       requests / burst window
 *   RATE_LIMIT_LONG_TTL_MS    (default 3600000)  sustained window length
 *   RATE_LIMIT_LONG_LIMIT     (default 200)      requests / sustained window
 *
 * Setting any var to `0` (or a non-positive / unparseable value) falls back to
 * the default rather than disabling the limiter — fail-safe, not fail-open. A
 * deliberate disable is a deploy concern (drop the guard), never a stray env.
 *
 * The friendly 429 body is owned by FriendlyThrottlerGuard + the RFC-7807
 * filter; this file owns only the windows.
 */

import { ConfigService } from '@nestjs/config';
import { ThrottlerOptions } from '@nestjs/throttler';

/** Hard-coded baseline (the pre-hardening values) — the source of truth for
 *  "today's behavior" so the defaults can never silently drift. */
export const RATE_LIMIT_DEFAULTS = {
  shortTtlMs: 60_000,
  shortLimit: 20,
  longTtlMs: 3_600_000,
  longLimit: 200,
} as const;

/** Parse a positive-integer env var, else fall back (fail-safe). */
function positiveInt(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string>(key);
  if (raw === undefined || raw === null || `${raw}`.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Build the named throttler array from env (or defaults). Shape matches what
 * `ThrottlerModule.forRoot(...)` already consumed, so it is a drop-in for the
 * async factory.
 */
export function buildThrottlers(config: ConfigService): ThrottlerOptions[] {
  return [
    {
      name: 'short',
      ttl: positiveInt(config, 'RATE_LIMIT_SHORT_TTL_MS', RATE_LIMIT_DEFAULTS.shortTtlMs),
      limit: positiveInt(config, 'RATE_LIMIT_SHORT_LIMIT', RATE_LIMIT_DEFAULTS.shortLimit),
    },
    {
      name: 'long',
      ttl: positiveInt(config, 'RATE_LIMIT_LONG_TTL_MS', RATE_LIMIT_DEFAULTS.longTtlMs),
      limit: positiveInt(config, 'RATE_LIMIT_LONG_LIMIT', RATE_LIMIT_DEFAULTS.longLimit),
    },
  ];
}

/**
 * HTTP hardening configuration for the bootstrap (main.ts).
 *
 * Pure builders — no Nest DI — so they stay unit-testable and keep main.ts a
 * thin wiring file. Two concerns live here:
 *
 *   1. helmetOptions()  — a CSP + HSTS posture appropriate for a JSON API that
 *                          also serves Swagger UI. The stock `helmet()` ships a
 *                          default CSP that blocks Swagger's inline bootstrap;
 *                          we lock everything to `'self'` and open ONLY what the
 *                          Swagger bundle needs (its own inline script/style +
 *                          data: images), nothing more.
 *   2. bodyLimit()      — the max request body size (default 1mb), tunable via
 *                          BODY_LIMIT (e.g. '256kb', '2mb'). A small cap is a
 *                          cheap DoS guard for a metadata API that never
 *                          receives large uploads (those federate to the file
 *                          engines, never to Customer-Ops).
 *
 * No new REQUIRED env: every value has a safe default == sensible production
 * behavior.
 */

import type { HelmetOptions } from 'helmet';

/** Default request body cap. Customer-Ops trades in small JSON, never blobs. */
export const DEFAULT_BODY_LIMIT = '1mb';

/**
 * Build the body-size limit string for the express json/urlencoded parsers.
 * Trimmed + validated against the `bytes`-style grammar; anything malformed
 * falls back to the default rather than throwing at boot.
 */
export function bodyLimit(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BODY_LIMIT?.trim();
  if (!raw) return DEFAULT_BODY_LIMIT;
  // Accept a bare byte count or a `<number><unit>` token (b/kb/mb/gb).
  if (/^\d+(\.\d+)?\s*(b|kb|mb|gb)?$/i.test(raw)) return raw;
  return DEFAULT_BODY_LIMIT;
}

/**
 * The helmet options. CSP is locked to `'self'` with a narrow allowance for the
 * Swagger UI bundle; HSTS is enabled with a 180-day max-age + subdomains
 * (TLS is terminated at the edge proxy, so this is the app asserting its own
 * https posture for any direct hit).
 *
 * `SWAGGER_CSP_RELAXED=false` removes even the Swagger allowances (use when
 * Swagger is disabled in prod) for the strictest possible policy.
 */
export function helmetOptions(env: NodeJS.ProcessEnv = process.env): HelmetOptions {
  const allowSwagger = env.SWAGGER_CSP_RELAXED !== 'false';

  // Base: deny-by-default, self-only. `directives` REPLACES helmet's defaults,
  // so we enumerate the full set we want rather than relying on the library's.
  const directives: Record<string, string[]> = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'self'"],
    formAction: ["'self'"],
    // A JSON API never executes third-party script; Swagger UI bundles its own.
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
  };

  if (allowSwagger) {
    // Swagger UI (@nestjs/swagger) injects an inline init script + inline
    // styles and renders its logo as a data: URI. These are the minimum
    // unsafe-inline grants the bundle needs to render; everything else stays
    // self-only.
    directives.scriptSrc.push("'unsafe-inline'");
    directives.styleSrc.push("'unsafe-inline'");
  }

  return {
    contentSecurityPolicy: { directives },
    // HSTS: assert https for 180 days incl. subdomains. `preload` left off — a
    // preload-list submission is an explicit, irreversible ops decision.
    strictTransportSecurity: {
      maxAge: 60 * 60 * 24 * 180,
      includeSubDomains: true,
    },
    // Cross-origin isolation headers default ON in helmet; a JSON API behind a
    // proxy benefits from the conservative defaults, so we leave them.
  };
}

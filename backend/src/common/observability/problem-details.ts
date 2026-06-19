/**
 * RFC-7807 "Problem Details for HTTP APIs" — the single error envelope the
 * Customer-Ops API returns for every failure (validation, auth, throttle, 5xx).
 *
 * A stable machine-readable shape lets the cockpit + agents branch on `status`
 * and surface `detail` without scraping ad-hoc `{ message }` bodies. The
 * `instance` carries the request-id so a 500 a user reports can be grepped
 * straight to its structured log line.
 *
 * We keep the media type as the canonical `application/problem+json` and never
 * leak internal exception internals (stack, SQL, secrets) into `detail`.
 */

/** The canonical RFC-7807 media type. */
export const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json';

/**
 * The wire shape. `type` is a URI reference (we use a relative `about:blank`
 * style slug since we don't host a problem-type registry yet); the remaining
 * members follow RFC-7807 §3.1. Extension members (here `requestId`) are
 * permitted and ignored by conformant clients.
 */
export interface ProblemDetails {
  /** URI reference identifying the problem type. `about:blank` => "no type". */
  type: string;
  /** Short, human-readable summary (stable per status — safe to localize on). */
  title: string;
  /** The HTTP status code, duplicated into the body per §3.1 for convenience. */
  status: number;
  /** Human-readable explanation specific to THIS occurrence (no internals). */
  detail?: string;
  /** URI reference for this specific occurrence — we put the request path. */
  instance?: string;
  /** Extension: correlation id, mirrors the `X-Request-Id` response header. */
  requestId?: string;
}

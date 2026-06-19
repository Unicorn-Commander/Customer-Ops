/**
 * The shared per-seam health shape returned by every federation port's `ping()`
 * and aggregated by `GET /api/v1/health/integrations`.
 *
 * The point of this surface is to make a SILENT federation auth failure visible:
 * a 401/403 against a sibling app otherwise hides behind a degrade-clean empty
 * panel (the cockpit just shows "connect <app>" and the operator never learns the
 * token is wrong). `ping()` does a lightweight, side-effect-free MCP `tools/list`
 * over the SAME transport/auth a real read uses, so `ok:false, detail:'auth-error'`
 * pinpoints exactly which seam is mis-credentialed.
 */
export interface SeamHealth {
  /** The seam identity: 'contact-ops' | 'accounting-ops' | 'email-ops' | ... */
  seam: string;
  /** Whether a target is configured at all (the seam's BASE_URL is set). */
  configured: boolean;
  /** True iff a live probe authenticated (HTTP 200 to `tools/list`). */
  ok: boolean;
  /** HTTP status of the probe; null when no probe was attempted (not configured). */
  status: number | null;
  /** 'ok' | 'not-configured' | 'auth-error: <msg>' | 'unreachable: <msg>'. */
  detail: string;
  /** Probe round-trip in ms; null when no probe was attempted. */
  latencyMs: number | null;
}

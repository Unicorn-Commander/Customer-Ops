/**
 * Feature flags for Customer-Ops.
 *
 * Every flag defaults to CURRENT behavior (SUITE-IDENTITY quality bar). The
 * helpers default-read process.env (which @nestjs/config populates from .env),
 * so the same helpers work in DI services and in the non-DI MCP tool layer.
 */

type EnvGetter = (key: string) => string | undefined;

const defaultGetter: EnvGetter = (k) => process.env[k];

function truthy(value: string | undefined | null, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  const s = value.toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

/**
 * Suite tenancy master switch (SUITE-IDENTITY).
 *
 * Default OFF == today's behavior: workspace routes do NOT require a
 * Membership row, the membership gate is a no-op, and rows resolve to
 * DEFAULT_WORKSPACE_ID. RLS exists in the DB but is inert because the runtime
 * still connects as the table owner.
 *
 * When ON (a later rollout phase, alongside flipping the runtime DATABASE_URL
 * to the NOBYPASSRLS customer_ops_app role): workspace routes 403 without an
 * active Membership, and the membership-derived workspace drives the RLS GUC.
 */
export function tenancyEnabled(getEnv: EnvGetter = defaultGetter): boolean {
  return truthy(getEnv('CUSTOMER_OPS_TENANCY_ENABLED'), false);
}

/**
 * Self-serve signup mode (CUSTOMER_OPS_SIGNUP_MODE) — the JIT-provisioning
 * policy for a verified SSO user who is NOT matched by the access list.
 *
 *   'invite' (DEFAULT) == today's behavior exactly: a uchub account does NOT by
 *     itself grant a Customer-Ops account. A stranger (no User row, no allow-list
 *     match) is rejected — invite-only (SUITE-IDENTITY §D5). Allow-list users
 *     still JIT into the bootstrap/default workspace as before.
 *
 *   'open' == self-serve: the same stranger instead auto-provisions THEIR OWN
 *     workspace (a new uc-registry workspace id + an OWNER membership). Allow-list
 *     users are UNCHANGED (the allow-list match still wins, in both modes) — open
 *     mode only adds a fallback for users the allow-list does not cover.
 *
 * Anything other than a case-insensitive 'open' resolves to 'invite', so a typo
 * or an empty value fails safe to today's invite-only posture.
 */
export type SignupMode = 'invite' | 'open';

export function signupMode(getEnv: EnvGetter = defaultGetter): SignupMode {
  const raw = getEnv('CUSTOMER_OPS_SIGNUP_MODE');
  return (raw ?? '').trim().toLowerCase() === 'open' ? 'open' : 'invite';
}

/** Convenience: true iff self-serve open signup is enabled. */
export function selfServeSignupEnabled(getEnv: EnvGetter = defaultGetter): boolean {
  return signupMode(getEnv) === 'open';
}

/**
 * GDPR data-retention sweep master switch (CUSTOMER_OPS_RETENTION_SWEEP_ENABLED).
 *
 * Default OFF == today's behavior: the DORMANT-record retention sweep NEVER runs
 * and purges NOTHING, even for a workspace that has a `retentionDays` set. This
 * mirrors the Contact-Ops `retention_sweep` posture — a destructive background
 * job stays inert until an operator explicitly opts a node in, so a mis-set
 * retention window can never quietly erase customer data.
 *
 * When ON (and a workspace has `retentionDays > 0`): the sweep purges customers
 * whose last activity (`updatedAt`) predates the window, through the SAME
 * erasure path as an on-request GDPR erasure (Postgres PII + the FalkorDB graph
 * + a DELETE audit row). Reads the flag defensively even with the sweep timer
 * disabled, so a manual trigger is likewise gated.
 */
export function retentionSweepEnabled(getEnv: EnvGetter = defaultGetter): boolean {
  return truthy(getEnv('CUSTOMER_OPS_RETENTION_SWEEP_ENABLED'), false);
}

/**
 * How often (ms) the retention-sweep timer fires when the sweep is enabled.
 * Defaults to 24h. Only consulted when `retentionSweepEnabled` is true; an
 * unparseable / non-positive value falls back to the 24h default so the timer is
 * never wedged at 0 (a hot loop) or NaN.
 */
export function retentionSweepIntervalMs(getEnv: EnvGetter = defaultGetter): number {
  const DEFAULT = 24 * 60 * 60 * 1000;
  const raw = getEnv('CUSTOMER_OPS_RETENTION_SWEEP_INTERVAL_MS');
  if (raw == null || raw === '') return DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT;
}

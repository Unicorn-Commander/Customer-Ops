/**
 * Federation workspace-override startup guard (the cross-tenant-leak blocker).
 *
 * Each sibling *-ops federation client resolves the workspace it addresses as
 * `this.workspaceOverride ?? ctx.workspaceId`. The override is a *_WORKSPACE_OVERRIDE
 * env (EMAIL_OPS_WORKSPACE_OVERRIDE, AO_WORKSPACE_OVERRIDE, …) that PINS every
 * federated call to ONE canonical workspace id, collapsing every request's real
 * tenant onto that single workspace. That is correct ONLY on the single-workspace
 * dogfood stack, where there is exactly one tenant to collapse onto. The moment a
 * second workspace exists (or suite tenancy is switched to multi), the override
 * silently routes tenant B's federated reads/writes at tenant A's canonical
 * workspace — a cross-tenant leak.
 *
 * This module is the HARD STARTUP GUARD: on boot, if ANY *_WORKSPACE_OVERRIDE env
 * is set AND (tenancy is multi OR the workspaces table has more than one row), the
 * app REFUSES to start with a fatal error naming the offending override envs. A
 * single-workspace dogfood stack (one workspace row, tenancy off) still boots.
 *
 * The guard is a pure policy function (no DB / no Nest DI) so it is fully unit
 * testable; main.ts supplies the two facts it needs — the active override env keys
 * and (workspace count, tenancy-multi flag) — at bootstrap, before app.listen().
 */

/** Env-var suffix that marks a per-seam federation workspace override. */
export const OVERRIDE_ENV_SUFFIX = '_WORKSPACE_OVERRIDE';

/**
 * The six federation seams that carry a workspace override today, listed for
 * documentation / test enumeration. The runtime collector does NOT rely on this
 * list — it scans for the suffix so a future seam is covered automatically — but
 * keeping the canonical set here makes the per-seam coverage explicit.
 */
export const KNOWN_OVERRIDE_ENV_KEYS = [
  'EMAIL_OPS_WORKSPACE_OVERRIDE',
  'MEETING_OPS_WORKSPACE_OVERRIDE',
  'CONTACT_OPS_WORKSPACE_OVERRIDE',
  'AO_WORKSPACE_OVERRIDE',
  'PROJECT_OPS_WORKSPACE_OVERRIDE',
  'OUTREACH_WORKSPACE_OVERRIDE',
] as const;

/** Thrown when boot config would let a workspace override leak across tenants. */
export class FederationOverrideGuardError extends Error {
  constructor(
    message: string,
    readonly offendingEnvs: string[],
  ) {
    super(message);
    this.name = 'FederationOverrideGuardError';
  }
}

/**
 * Collect the *_WORKSPACE_OVERRIDE env keys that are actually SET (non-empty after
 * trim). Scans by suffix so any seam — present or future — is caught, not just the
 * six known today. Returned sorted for a stable, deterministic error message.
 */
export function collectActiveOverrideEnvs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return Object.keys(env)
    .filter((k) => k.endsWith(OVERRIDE_ENV_SUFFIX))
    .filter((k) => (env[k] ?? '').trim() !== '')
    .sort();
}

export interface FederationOverrideGuardInput {
  /** Override env keys currently set (from collectActiveOverrideEnvs). */
  activeOverrides: string[];
  /** Number of rows in the workspaces table. */
  workspaceCount: number;
  /** True when suite tenancy is in multi-tenant mode (CUSTOMER_OPS_TENANCY_ENABLED). */
  tenancyMulti: boolean;
}

export interface FederationOverrideGuardVerdict {
  safe: boolean;
  offendingEnvs: string[];
  /** Human-readable reason when unsafe; undefined when safe. */
  reason?: string;
}

/**
 * Pure policy: is it safe to serve federated calls with the given boot facts?
 *
 * UNSAFE iff at least one override env is set AND the deployment is (or has become)
 * multi-workspace — either tenancy is switched to multi, or more than one workspace
 * row exists. In every other case (no override at all, or a genuinely
 * single-workspace dogfood stack) it is safe.
 */
export function evaluateFederationOverrideGuard(
  input: FederationOverrideGuardInput,
): FederationOverrideGuardVerdict {
  const offendingEnvs = [...input.activeOverrides];

  if (offendingEnvs.length === 0) {
    // No override set: every seam passes ctx.workspaceId straight through — the
    // per-request tenant is honored, nothing to collapse. Always safe.
    return { safe: true, offendingEnvs: [] };
  }

  const multiWorkspace = input.workspaceCount > 1;
  if (!input.tenancyMulti && !multiWorkspace) {
    // Single-workspace dogfood with tenancy off: the override collapses onto the
    // ONLY tenant, which is a no-op, not a leak. Safe to boot.
    return { safe: true, offendingEnvs };
  }

  const trigger = input.tenancyMulti
    ? 'suite tenancy is in multi-tenant mode (CUSTOMER_OPS_TENANCY_ENABLED)'
    : `the workspaces table has ${input.workspaceCount} rows (> 1)`;

  return {
    safe: false,
    offendingEnvs,
    reason:
      `Federation workspace override is set (${offendingEnvs.join(', ')}) while ` +
      `${trigger}. A *_WORKSPACE_OVERRIDE pins EVERY federated call to one canonical ` +
      `workspace, which collapses every tenant's federated reads/writes onto that ` +
      `single workspace — a cross-tenant data leak. Overrides are only safe on a ` +
      `single-workspace dogfood stack. Unset the offending override env(s) (and wire ` +
      `real per-workspace mapping) before serving multiple workspaces.`,
  };
}

/**
 * Assert the boot config is safe, or throw a fatal FederationOverrideGuardError.
 * Call this at bootstrap BEFORE the app begins listening.
 */
export function assertFederationOverrideSafe(
  input: FederationOverrideGuardInput,
): void {
  const verdict = evaluateFederationOverrideGuard(input);
  if (!verdict.safe) {
    throw new FederationOverrideGuardError(
      verdict.reason ?? 'Federation override guard failed.',
      verdict.offendingEnvs,
    );
  }
}

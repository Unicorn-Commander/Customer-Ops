/**
 * Control-plane provisioning flags (Apps in onboarding, contract D).
 *
 * PROVISIONING_ENABLED is OFF by default. With it off the provisioning module
 * is not registered at all (its routes answer the framework's own 404, exactly
 * as today), the workspace write lock is inert, and the pause/resume routes do
 * not exist. One change is NOT behind the flag: the app's own member removal
 * (DELETE workspaces/:id/members/:userKey) always revokes the removed person's
 * credentials by the removal rule (MembershipService.removeMember), and its
 * preview route is served with the flag off too.
 */

type EnvGetter = (key: string) => string | undefined;
const fromProcess: EnvGetter = (k) => process.env[k];

/** Minimum HS256 secret length, in bytes. A shorter secret disables the routes. */
export const PROVISIONING_MIN_SECRET_BYTES = 32;
export const PROVISIONING_ISSUER = 'ops-center';
export const PROVISIONING_DEFAULT_AUDIENCE = 'customer-ops';
/** The app key in the control plane's `Idempotency-Key: <org_id>:<app>` header. */
export const PROVISIONING_APP_KEY = 'customer-ops';

export function provisioningEnabled(getEnv: EnvGetter = fromProcess): boolean {
  const raw = (getEnv('PROVISIONING_ENABLED') ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

/** The shared HS256 secret, or null when unset or shorter than 32 bytes. */
export function provisioningSecret(getEnv: EnvGetter = fromProcess): string | null {
  const raw = getEnv('PROVISIONING_JWT_SECRET') ?? '';
  return Buffer.byteLength(raw, 'utf8') >= PROVISIONING_MIN_SECRET_BYTES ? raw : null;
}

export function provisioningAudience(getEnv: EnvGetter = fromProcess): string {
  return (getEnv('PROVISIONING_JWT_AUDIENCE') ?? '').trim() || PROVISIONING_DEFAULT_AUDIENCE;
}

/** Workspace states the control plane may set. Anything but `active` refuses writes. */
export const WORKSPACE_STATES = ['active', 'suspended', 'archived'] as const;
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

/** Stored workspace statuses under which tenant writes are refused (reads keep working). */
export const WRITE_LOCKED_STATUSES: ReadonlySet<string> = new Set(['suspended', 'archived']);

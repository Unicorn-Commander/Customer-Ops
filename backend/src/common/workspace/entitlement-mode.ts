import { Logger } from '@nestjs/common';

export type EntitlementMode = 'open' | 'enforce';

/**
 * Suite entitlement posture. Empty, whitespace, and anything other than
 * `open` (any case) is enforce. Kept in one place so PatService and
 * WorkspaceContextService cannot drift.
 */
export function entitlementModeFrom(raw: string | null | undefined): EntitlementMode {
  return (raw ?? '').trim().toLowerCase() === 'open' ? 'open' : 'enforce';
}

let logged = false;

/**
 * Log the mode that is actually in force, once per process. An empty
 * UC_ENTITLEMENT_MODE is enforce and the line says so. Call from service
 * construction: Nest builds those providers at boot, not per request.
 */
export function logEntitlementModeOnce(
  logger: Pick<Logger, 'log'>,
  raw: string | null | undefined,
): EntitlementMode {
  const mode = entitlementModeFrom(raw);
  if (!logged) {
    logged = true;
    const shown = (raw ?? '').trim();
    logger.log(
      `UC_ENTITLEMENT_MODE=${shown === '' ? '(empty)' : shown} — entitlement mode in force: ${mode}.`,
    );
  }
  return mode;
}

/** Test-only. Production logs once for the life of the process. */
export function resetEntitlementModeLogForTests(): void {
  logged = false;
}

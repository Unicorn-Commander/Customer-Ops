/**
 * The owner's latest verified entitlement claim seen by this process.
 *
 * A PAT has no live JWT. After the mint snapshot ages out and there is no
 * server-side workspace source, PatService re-reads this claim (recorded when
 * a session or realm token for the same user is validated) instead of the
 * frozen snapshot. Names and ids only — never a token or a secret.
 */
export interface OwnerEntitlementClaim {
  at: number;
  entitlements: string[];
  workspaceId: string | null;
}

const claims = new Map<string, OwnerEntitlementClaim>();

export function rememberOwnerEntitlementClaim(
  userId: string,
  entitlements: string[],
  workspaceId?: string | null,
): void {
  const id = (userId ?? '').trim();
  if (!id) return;
  claims.set(id, {
    at: Date.now(),
    entitlements: [...entitlements],
    workspaceId: workspaceId?.trim() ? workspaceId.trim() : null,
  });
}

export function readOwnerEntitlementClaim(userId: string): OwnerEntitlementClaim | null {
  const id = (userId ?? '').trim();
  if (!id) return null;
  return claims.get(id) ?? null;
}

/** Test-only. Production never clears this; it lives for the process. */
export function clearOwnerEntitlementClaims(): void {
  claims.clear();
}

/**
 * Contact-Ops tenant ids are UUIDs, compared in one canonical form: lowercase
 * (R4-2). A stored row, the org lookup's answer, an owner's request and the
 * remote grant may each spell the same tenant in another case.
 */
export function canonicalTenantId(id: string): string {
  return id.trim().toLowerCase();
}

/** True when both name the same tenant (either may be absent). */
export function sameTenant(a: string | null | undefined, b: string | null | undefined): boolean {
  return (
    typeof a === 'string' && typeof b === 'string' && canonicalTenantId(a) === canonicalTenantId(b)
  );
}

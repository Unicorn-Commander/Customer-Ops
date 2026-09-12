/** Tiny HTML helpers for the string template. Everything user-facing goes through `esc`. */

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape for an attribute that holds JSON (single quotes are fine inside double-quoted attrs). */
export function escAttrJson(value: unknown): string {
  return esc(JSON.stringify(value));
}

/** Join non-empty parts. */
export function join(parts: Array<string | null | undefined | false>, sep = ''): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(sep);
}

/** A stable, URL-safe id fragment. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

/** Long-form date for the document ("12 September 2026"). Deterministic (UTC). */
export function longDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Date + time, UTC, for receipts ("12 September 2026, 19:41 UTC"). */
export function longDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mm = d.getUTCMinutes().toString().padStart(2, '0');
  return `${longDate(iso)}, ${hh}:${mm} UTC`;
}

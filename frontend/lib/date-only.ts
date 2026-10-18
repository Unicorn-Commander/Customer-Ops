/**
 * Date-only values from Project-Ops and Accounting-Ops are YYYY-MM-DD calendar
 * dates, not instants. Never pass those strings directly to `new Date()`.
 */

export interface DateOnlyParts {
  y: number;
  m: number;
  d: number;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(s: unknown): s is string {
  return typeof s === 'string' && DATE_ONLY_RE.test(s);
}

/** Return calendar parts for a valid YYYY-MM-DD value, or null for bad input. */
export function parseDateOnly(s: string): DateOnlyParts | null {
  if (!isDateOnly(s)) return null;

  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return { y, m, d };
}

/**
 * Format a date-only value without allowing the viewer's time zone to change
 * its calendar day. Non-date-only input keeps the previous instant formatting
 * behavior so this helper is safe at mixed federation boundaries.
 */
export function formatDateOnly(
  s: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' },
): string | null {
  if (!s) return null;

  const parts = parseDateOnly(s);
  if (parts) {
    const date = new Date(0);
    date.setUTCFullYear(parts.y, parts.m - 1, parts.d);
    date.setUTCHours(0, 0, 0, 0);
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(date);
  }

  const date = new Date(s);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, opts);
}

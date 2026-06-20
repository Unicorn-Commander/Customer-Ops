/**
 * Date / time formatting helpers — the single source of truth for how
 * Customer-Ops renders timestamps, replacing the per-component copies that had
 * drifted (some pinned `'en-US'`, some not; some with a year, some without).
 *
 * All three use the *user's* locale (we pass `undefined`, never a hard-coded
 * `'en-US'`) and degrade gracefully on a null / unparseable input rather than
 * rendering "Invalid Date".
 */

type DateInput = string | number | Date | null | undefined;

/** Parse to epoch ms, or NaN for null / empty / unparseable input. */
function toTime(d: DateInput): number {
  if (d === null || d === undefined || d === '') return NaN;
  return d instanceof Date ? d.getTime() : new Date(d).getTime();
}

/** Calendar date, no time — e.g. "Jun 20, 2026". Empty string on bad input. */
export function formatDate(d: DateInput): string {
  const t = toTime(d);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** Date + time — e.g. "Jun 20, 2026, 3:14 PM". Empty string on bad input.
 *  The verbose, unambiguous form used for tooltips + "last used" cells. */
export function formatDateTime(d: DateInput): string {
  const t = toTime(d);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Compact relative time, past + future ("3d ago" / "in 5d"). Returns "—" for a
 * null / unparseable input (the dash the tables already used for empty cells).
 */
export function relativeTime(d: DateInput): string {
  const t = toTime(d);
  if (!Number.isFinite(t)) return '—';
  const diff = t - Date.now();
  const past = diff < 0;
  const s = Math.abs(diff) / 1000;
  const fmt = (n: number, unit: string) => (past ? `${n}${unit} ago` : `in ${n}${unit}`);
  if (s < 45) return past ? 'just now' : 'soon';
  if (s < 3600) return fmt(Math.round(s / 60), 'm');
  if (s < 86400) return fmt(Math.round(s / 3600), 'h');
  const days = Math.round(s / 86400);
  if (days === 1) return past ? 'yesterday' : 'tomorrow';
  if (days < 30) return fmt(days, 'd');
  if (days < 365) return fmt(Math.round(days / 30), 'mo');
  return fmt(Math.round(days / 365), 'y');
}

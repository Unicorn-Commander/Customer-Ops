/** Shared process flag: loading a renderer must not bypass the CRUD kill switch. */
export function quotesEnabled(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

/**
 * Pure logic behind the "New relationship" contact picker. No imports from the
 * API layer, so it runs under `node --test` as-is; the fetcher is injected.
 */

export interface ContactOption {
  contactId: string;
  displayName: string;
  primaryEmail: string | null;
}

export type ContactSearchFn = (workspaceId: string, query: string) => Promise<ContactOption[]>;

/** Shortest query worth sending to Contact-Ops. */
export const MIN_QUERY_LENGTH = 2;

export function contactOptionLabel(c: ContactOption): { title: string; subtitle: string } {
  return { title: c.displayName, subtitle: c.primaryEmail ?? '' };
}

export async function searchContactOptions(
  workspaceId: string,
  query: string,
  fetcher: ContactSearchFn,
): Promise<ContactOption[]> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) return [];
  return fetcher(workspaceId, q);
}

/** The create body for a picked contact; null (nothing to submit) for free text. */
export function createPayloadFor(picked: ContactOption | null): { contactId: string } | null {
  return picked ? { contactId: picked.contactId } : null;
}

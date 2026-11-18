/**
 * Pure logic behind the "New relationship" contact picker. No imports from the
 * API layer, so it runs under `node --test` as-is; the fetcher is injected.
 */

export interface ContactOption {
  contactId: string;
  displayName: string;
  primaryEmail: string | null;
}

export interface ContactSearchResult {
  items: ContactOption[];
  /** The workspace has no Contact-Ops link: show the message, not the picker. */
  notConnected: boolean;
}

export type ContactSearchFn = (workspaceId: string, query: string) => Promise<ContactSearchResult>;

/** Shown instead of the picker when the workspace is not linked to Contact-Ops. */
export const NOT_CONNECTED_MESSAGE = "Contacts aren't set up for this workspace yet, so a relationship can't be linked to a contact. Ask your workspace owner, or write to support@unicorncommander.ai and we will set it up.";

/** Shortest query worth sending to Contact-Ops. */
export const MIN_QUERY_LENGTH = 2;

export function contactOptionLabel(c: ContactOption): { title: string; subtitle: string } {
  return { title: c.displayName, subtitle: c.primaryEmail ?? '' };
}

export async function searchContactOptions(
  workspaceId: string,
  query: string,
  fetcher: ContactSearchFn,
): Promise<ContactSearchResult> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) return { items: [], notConnected: false };
  return fetcher(workspaceId, q);
}

/** The create body for a picked contact; null (nothing to submit) for free text. */
export function createPayloadFor(picked: ContactOption | null): { contactId: string } | null {
  return picked ? { contactId: picked.contactId } : null;
}

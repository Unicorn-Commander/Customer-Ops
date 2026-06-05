/**
 * The provisional-label seam.
 *
 * While Contact-Ops is dormant (CONTACT_OPS_BASE_URL unset / P-00059 not live),
 * an ingested lead is projected onto a PROVISIONAL contactId ('prov:<hash>')
 * minted from its identity. The canonical phonebook can't resolve that id (it
 * isn't a real person_id yet), so the cockpit's federated contact join returns
 * nothing for it. This port lets the relationship layer fall back to the staged
 * identity in the LeadIntake buffer — so a provisional lead still renders with a
 * real name/email/org instead of a bare id. It is a clearly-labeled fallback
 * (`source: 'intake-fallback'`), NOT a second contact store, and it disappears
 * the moment reconciliation swaps the provisional id for the canonical one.
 *
 * CustomersService consumes this OPTIONALLY (@Optional): if the lead-intake
 * module isn't present, the cockpit simply shows the contactId — no hard dep.
 */

export interface LeadLabel {
  displayName: string;
  primaryEmail: string | null;
  currentOrgName: string | null;
  tags: string[];
}

export abstract class LeadLabelResolver {
  /**
   * Resolve display labels for a batch of PROVISIONAL contactIds ('prov:…') from
   * the LeadIntake buffer, workspace-scoped to the acting user. Ids that aren't
   * provisional or have no staged intake are simply absent from the map. Never
   * throws (best-effort enrichment).
   */
  abstract labels(
    user: { id: string } & Record<string, unknown>,
    requestedWorkspaceId: string | null,
    provisionalContactIds: string[],
  ): Promise<Map<string, LeadLabel>>;
}

/** The prefix that marks a contactId as a local provisional placeholder. */
export const PROVISIONAL_PREFIX = 'prov:';

/** True when a contactId is a local provisional placeholder (not a CO person_id). */
export function isProvisionalContactId(contactId: string): boolean {
  return contactId.startsWith(PROVISIONAL_PREFIX);
}

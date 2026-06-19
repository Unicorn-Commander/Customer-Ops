/**
 * The Contact-Ops federation PORT.
 *
 * An abstract class used as a DI token + interface. The relationship layer
 * (CustomersService, the customer-360 aggregation) depends ONLY on this port,
 * never on the concrete client. That gives two properties the brief requires:
 *
 *   1. Federation is built against the Contact-Ops contract but MOCKED in tests
 *      (Contact-Ops is not running during verification) — tests provide a fake
 *      ContactOpsPort.
 *   2. The data-plane seam is swappable (JSON-RPC MCP today; a future REST or
 *      Brigade-brokered transport later) without touching relationship logic.
 *
 * Every method is workspace-addressed: the caller passes the resolved
 * workspaceId (uc-registry uuidv7) and the acting user's uchub sub, which the
 * client forwards to Contact-Ops as the wire `workspace_id` claim + actor. The
 * port NEVER returns contact records to be persisted — only read-time
 * projections (federate, don't fork).
 */

import {
  ContactIdentityInput,
  ContactUpsertResult,
  FederatedContact,
  FederatedContactPage,
  FederatedContactSummary,
  FederatedWorkspaceProjection,
  ListContactsFilter,
} from './contact-ops.types';
import { SeamHealth } from '../health/seam-health';

/** The per-call federation identity: which workspace + who is acting. */
export interface FederationContext {
  /** Resolved canonical workspace id (uc-registry uuidv7); the CO wire claim. */
  workspaceId: string;
  /** Acting user's uchub sub (attribution; the CO actor). */
  ucUid: string | null;
}

export abstract class ContactOpsPort {
  /**
   * Probe this seam's transport + auth with a lightweight, side-effect-free MCP
   * `tools/list` and report a SeamHealth (so a silent 401/403 becomes visible via
   * `GET /health/integrations` rather than hiding behind a degrade-clean panel).
   * Never throws — every failure is folded into the returned SeamHealth.
   */
  abstract ping(): Promise<SeamHealth>;

  /**
   * Resolve ONE contact's full detail by id (CO `get_person`). Returns null
   * when the contact is not visible in the workspace (CO `PERSON_NOT_FOUND` /
   * merged / archived-away). Used by the customer-360.
   */
  abstract getContact(ctx: FederationContext, contactId: string): Promise<FederatedContact | null>;

  /**
   * Resolve MANY contacts' summaries by id, for list/board rendering. Order is
   * not guaranteed; the caller joins by `contactId`. Missing ids are simply
   * absent from the result (the relationship row still renders with a
   * "contact unavailable" placeholder upstream). Implementations SHOULD batch.
   */
  abstract getContactSummaries(
    ctx: FederationContext,
    contactIds: string[],
  ): Promise<Map<string, FederatedContactSummary>>;

  /**
   * Read contacts for the workspace (CO `list_people` / `search_people`). Drives
   * lead-sourcing: surfacing phonebook contacts that don't yet have a
   * Customer-Ops relationship. Honors CO's "no unfiltered tenant dump" rule via
   * the filter.
   */
  abstract listContacts(
    ctx: FederationContext,
    filter: ListContactsFilter,
  ): Promise<FederatedContactPage>;

  /**
   * Fetch the signed thin workspace projection (CO `GET /api/v1/workspaces/{id}`)
   * — the workspace MIRROR (isolation posture), never contact data. Returns null
   * when CO does not know the workspace. Used to confirm a federated
   * workspace's compliance posture before reading its contacts.
   */
  abstract getWorkspaceProjection(
    ctx: FederationContext,
  ): Promise<FederatedWorkspaceProjection | null>;

  /**
   * The ONE write the port exposes: centralize a graduated lead's IDENTITY in
   * Contact-Ops (the person SoR) and return the canonical person_id. This is the
   * `ingest_lead` keystone's identity step — Customer-Ops never forks the
   * phonebook; it asks Contact-Ops to upsert the person, then keys its LEAD
   * projection on the returned contactId. Contact-Ops owns the
   * dedupe/merge/consent rules; Customer-Ops sends only identity + a rollup tag.
   *
   * DEGRADE-CLEAN: returns null when Contact-Ops is unreachable (CONTACT_OPS_BASE_URL
   * unset) OR the ingest seam (P-00059) is not yet live. A null is NOT an error —
   * the caller stages the lead PENDING and a reconciler retries the upsert once
   * Contact-Ops is reachable. Implementations MUST NOT throw.
   */
  abstract upsertContact(
    ctx: FederationContext,
    identity: ContactIdentityInput,
  ): Promise<ContactUpsertResult | null>;
}

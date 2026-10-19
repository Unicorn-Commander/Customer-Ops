/**
 * The Contact-Ops federation contract — the shapes Customer-Ops consumes from
 * the canonical phonebook.
 *
 * BINDING PRINCIPLE (README golden rule): Customer-Ops FEDERATES contacts; it
 * never copies them. The only contact field Customer-Ops persists is the
 * `contactId` (on the Customer relationship row). Everything in this file is a
 * READ-TIME projection resolved over the federation seam (the ContactOps port)
 * and held only for the duration of a request — never written to the
 * Customer-Ops database.
 *
 * These types mirror Contact-Ops's own MCP tool outputs verbatim so the wire
 * contract is explicit and the client's mapping is auditable:
 *   - `FederatedContactSummary` == Contact-Ops `PersonSummary`
 *     (common.py: person_id, display_name, primary_email, current_org_id,
 *      current_org_name, last_interaction_at, communication_strength, tags, etag)
 *   - `FederatedContact` == Contact-Ops `get_person` output (GetPersonOutput:
 *      person_id, etag, vcard_uid, display_name, kind, status, emails[],
 *      phones[], recent_events[]).
 */

/**
 * A contact email as Contact-Ops shapes it inside `get_person.emails[]`. The
 * shape is `dict[str, Any]` on the CO side; these are the load-bearing keys.
 */
export interface FederatedContactEmail {
  address: string;
  type?: string;
  is_primary?: boolean;
}

/** A contact phone as Contact-Ops shapes it inside `get_person.phones[]`. */
export interface FederatedContactPhone {
  e164: string;
  type?: string;
  is_primary?: boolean;
}

/**
 * A contact IM handle as Contact-Ops shapes it inside `get_person.im_handles[]`.
 * Read-only here — writing handles is Contact-Ops' surface, not Customer-Ops'.
 */
export interface FederatedContactIMHandle {
  id: string;
  protocol: string;
  handle: string;
  label: string | null;
  is_primary: boolean;
}

/** A contact identifier as Contact-Ops shapes it inside `get_person.identifiers[]`. */
export interface FederatedContactIdentifier {
  id: string;
  namespace: string;
  value: string;
  url: string | null;
  verified: boolean;
}

/** A contact URL as Contact-Ops shapes it inside `get_person.urls[]`. */
export interface FederatedContactUrl {
  id: string;
  url: string;
  type: string | null;
  label: string | null;
  is_primary: boolean;
}

/**
 * The thin contact summary Contact-Ops returns from `list_people` /
 * `search_people` (its `PersonSummary`). Used for the customers/leads list and
 * the pipeline board cards — enough to render a row without a full fetch.
 */
export interface FederatedContactSummary {
  contactId: string; // == CO person_id
  displayName: string;
  primaryEmail: string | null;
  currentOrgId: string | null;
  currentOrgName: string | null;
  lastInteractionAt: string | null; // ISO-8601
  communicationStrength: number | null;
  tags: string[];
  etag: string | null;
}

/**
 * The full federated contact Contact-Ops returns from `get_person`. Powers the
 * contact half of the customer-360. NEVER persisted — resolved per request.
 */
export interface FederatedContact extends FederatedContactSummary {
  vcardUid: string | null;
  kind: string; // individual|group|org|location
  status: string; // active|archived|...
  mergedIntoId: string | null;
  relationshipCategory: string | null;
  givenName: string | null;
  familyName: string | null;
  additionalNames: string[];
  honorificPrefix: string | null;
  honorificSuffix: string | null;
  phoneticGivenName: string | null;
  phoneticFamilyName: string | null;
  nicknames: string[];
  fileAs: string | null;
  pronouns: string | null;
  emails: FederatedContactEmail[];
  phones: FederatedContactPhone[];
  imHandles: FederatedContactIMHandle[];
  identifiers: FederatedContactIdentifier[];
  urls: FederatedContactUrl[];
  recentEvents: Array<Record<string, unknown>>;
}

/**
 * The signed, read-only workspace thin-projection Contact-Ops exposes at
 * `GET /api/v1/workspaces/{id}` (handoff-contact-ops §2.2). It is the workspace
 * MIRROR, NOT contact data — the 9 suite-shared fields, never infra columns
 * (qdrant_namespace, garage_bucket_prefix, graph_mode, …). Customer-Ops uses it
 * to confirm a federated workspace's isolation posture before reading contacts.
 */
export interface FederatedWorkspaceProjection {
  workspaceId: string;
  slug: string;
  displayName: string;
  isolationMode: string; // strict|standard|open
  isolationTier: string; // shared|premium|enterprise|dedicated
  hipaaMode: boolean;
  gdprMode: boolean;
  dataResidency: string | null;
  status: string;
}

/** Filters Customer-Ops passes through to Contact-Ops `list_people`. */
export interface ListContactsFilter {
  query?: string;
  tagsAny?: string[];
  hasEmail?: boolean;
  limit?: number;
  cursor?: string | null;
}

/** A page of federated contact summaries (mirrors CO list/search output). */
export interface FederatedContactPage {
  items: FederatedContactSummary[];
  count: number;
  nextCursor: string | null;
}

/** Organization details Customer-Ops may pass to Contact-Ops on an upsert. */
export interface ContactOrganizationInput {
  name: string;
  role?: string;
  title?: string;
  domain?: string;
}

/**
 * The identity Customer-Ops pushes to Contact-Ops when a lead graduates (the
 * `ingest_lead` keystone → the CONTACT-OPS-INGEST-CONTRACT.md "/ingest" /
 * RBAC-MCP `ingest_person` front door). This is the IDENTITY half only — the
 * person + the rollup tag — never Customer-Ops' vertical funnel data. Contact-Ops
 * dedupes/merges on the strongest available key (email > phone) and returns the
 * canonical person_id; Customer-Ops then keys its LEAD projection on it.
 *
 * `sourceDedupKey` + `source` ride along so Contact-Ops can make the upsert
 * idempotent on its side too (and so a future provenance/audit trail can tie the
 * person back to the originating leadgen record).
 */
export interface ContactIdentityInput {
  /** The leadgen source slug (northwind|magic-unicorn-outreach|loopnet|…|manual|agent). */
  source: string;
  /** The source app's stable id for this lead (Contact-Ops idempotency hint). */
  sourceDedupKey: string;
  displayName?: string | null;
  /** Structured name parts (CO-expose-fields) — passed through to Contact-Ops. */
  givenName?: string | null;
  familyName?: string | null;
  nicknames?: string[];
  email?: string | null;
  phone?: string | null;
  /** Legacy intake company field, retained for the staged lead projection. */
  orgName?: string | null;
  /** The Contact-Ops organization object, omitted when the lead has no company. */
  organization?: ContactOrganizationInput;
  /** The rollup tag(s) to attach to the person (e.g. ['lead', 'northwind']). */
  tags?: string[];
}

/** Contact-Ops' answer to an identity upsert: the canonical person_id + whether
 *  it was newly created (vs matched to an existing person) + the new etag. */
export interface ContactUpsertResult {
  contactId: string; // == CO person_id
  created: boolean;
  etag: string | null;
}

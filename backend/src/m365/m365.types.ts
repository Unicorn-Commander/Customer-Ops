/**
 * M365 connector contract types.
 *
 * The Graph shapes here mirror Microsoft Graph's `/me/contacts` resource (only
 * the fields the contacts-import maps), so the M365GraphClient's mapping is
 * auditable. The connection metadata view is the SAFE projection of an
 * M365Connection — it deliberately OMITS the encrypted token columns so a status
 * response can never leak a credential.
 */

/** One email entry inside a Graph contact's `emailAddresses[]`. */
export interface GraphContactEmail {
  name?: string;
  address?: string;
}

/**
 * A Microsoft Graph contact (`/me/contacts` item). Graph returns far more; these
 * are the load-bearing fields for the lead-intake mapping. `id` is the stable
 * Graph id (contains `=` / `/`, so it must be HASHED into the slug dedup key).
 */
export interface GraphContact {
  id: string;
  displayName?: string | null;
  givenName?: string | null;
  surname?: string | null;
  companyName?: string | null;
  emailAddresses?: GraphContactEmail[];
  mobilePhone?: string | null;
  businessPhones?: string[];
  personalNotes?: string | null;
  // Present on a delta response when a contact was removed; v1 ignores deletes.
  '@removed'?: { reason?: string };
}

/** One page of Graph contacts + the paging/delta continuation links. */
export interface GraphContactPage {
  contacts: GraphContact[];
  /** `@odata.nextLink` — another page of the SAME enumeration to follow now. */
  nextLink: string | null;
  /** `@odata.deltaLink` — the cursor to persist + replay on the NEXT sync. */
  deltaLink: string | null;
}

/** The result of the OAuth code redemption (what the controller persists). */
export interface M365TokenResult {
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpires: Date | null;
  scopes: string[];
  m365UserId: string;
  m365UserPrincipal: string | null;
}

/**
 * The SAFE metadata view of a connection — what `GET /m365/status` returns.
 * NEVER includes refreshTokenEnc / accessTokenEnc (the encrypted credentials).
 */
export interface M365ConnectionView {
  id: string;
  m365UserId: string;
  m365UserPrincipal: string | null;
  scopes: string[];
  status: string;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  hasDeltaLink: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The outcome of one contact sync run (returned by `POST /m365/sync`). */
export interface M365SyncResult {
  ok: boolean;
  status: string;
  contactsSeen: number;
  ingested: number;
  failed: number;
  detail: string;
  lastSyncAt: string | null;
}

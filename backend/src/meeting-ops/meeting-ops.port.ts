/**
 * The Meeting-Ops federation PORT.
 *
 * An abstract class used as a DI token + interface. The relationship layer
 * (CustomersService / the customer-360 meeting slot) and the relationship agents
 * depend ONLY on this port, never on the concrete client. This is the same
 * federate-don't-fork seam as ContactOpsPort / AccountingOpsPort / OutreachPort /
 * EmailOpsPort, and gives the brief's required properties:
 *
 *   1. Federation is built against the Meeting-Ops APP contract but MOCKED in
 *      tests (Meeting-Ops is not running during verification) — tests provide a
 *      fake MeetingOpsPort. The contract here is a clean `/mcp`-style read surface
 *      for the Meeting-Ops app, informed by its known data model (meetings →
 *      transcripts → summaries → action items + its action-item → Project-Ops
 *      bridge).
 *   2. The transport (JSON-RPC MCP today; a Brigade-brokered transport later) is
 *      swappable without touching relationship logic.
 *   3. Customer-Ops never becomes a second meeting/transcript store: the port is
 *      READ-ONLY. It lists meetings/summaries/action-items for a customer's
 *      contact and computes a compact MeetingSignal. There is NO write path and
 *      NO local Meeting-Ops table — the customer-360 meeting slot is filled purely
 *      at read time (federated, never copied). Meeting-Ops owns the meetings and
 *      runs its own action-item → Project-Ops task bridge.
 *
 * ENTITLEMENT: Meeting-Ops READS are viewer-level conversation signal — exactly
 * like Contact-Ops contact reads and the AO/Outreach/Email read paths, they do
 * NOT require a dual SKU. (The metered/entitlement-gated lane in this phase is the
 * AGENT INFERENCE lane — see AgentInferencePort — per the 4-lane model, not the
 * Meeting-Ops read.) So this port has no checkEntitlement; reads always work when
 * Meeting-Ops is configured + the workspace is a member.
 *
 * DEGRADE-CLEAN (binding): when MEETING_OPS_BASE_URL is unset, `isConfigured()` is
 * false; the service then renders the meeting slot as "connect Meeting-Ops" and
 * makes no call. Every method is also individually safe to call when unconfigured
 * (returns empty / null), so a missing config can never throw.
 */

import {
  FederatedActionItem,
  FederatedMeetingPage,
  FederatedMeetingSummary,
  ListMeetingsFilter,
  MeetingSignal,
} from './meeting-ops.types';

/** The per-call federation identity: which workspace + who is acting. Meeting
 *  reads are viewer-level, so there is no entitlement list here (unlike the
 *  AO/Outreach/Email triggers) — mirroring the Contact-Ops read context. */
export interface FederationContext {
  /** Resolved canonical workspace id (uc-registry uuidv7); the Meeting-Ops claim. */
  workspaceId: string;
  /** Acting user's uchub sub (attribution; the Meeting-Ops actor). */
  ucUid: string | null;
}

export abstract class MeetingOpsPort {
  /**
   * Is a Meeting-Ops target configured at all (MEETING_OPS_BASE_URL set)? When
   * false the cockpit shows "connect Meeting-Ops" and NO federation call is made
   * (degrade-clean). Pure/synchronous so the service can branch before any I/O.
   */
  abstract isConfigured(): boolean;

  /**
   * List the MEETINGS a customer's contact participated in (Meeting-Ops
   * `list_meetings_for_contact`). The customer-360 meeting history. Read-only /
   * viewer-level. Returns an empty page when not configured / unknown / the call
   * fails (degrade-clean). Federated, never copied.
   */
  abstract listMeetingsForContact(
    ctx: FederationContext,
    contactId: string,
    filter?: ListMeetingsFilter,
  ): Promise<FederatedMeetingPage>;

  /**
   * List the SUMMARIES of a customer's contact's meetings (Meeting-Ops
   * `list_summaries_for_contact`). The conversational recaps surfaced on the 360
   * + read by the relationship agents. Read-only. Returns [] when not configured /
   * unknown / the call fails.
   */
  abstract listSummariesForContact(
    ctx: FederationContext,
    contactId: string,
    filter?: ListMeetingsFilter,
  ): Promise<FederatedMeetingSummary[]>;

  /**
   * List the ACTION ITEMS extracted from a customer's contact's meetings
   * (Meeting-Ops `list_action_items_for_contact`). Each carries whether
   * Meeting-Ops' bridge already turned it into a Project-Ops task
   * (`projectOpsTaskId`). Read-only — Customer-Ops surfaces these but NEVER
   * creates the task. Returns [] when not configured / unknown / the call fails.
   */
  abstract listActionItemsForContact(
    ctx: FederationContext,
    contactId: string,
    filter?: ListMeetingsFilter,
  ): Promise<FederatedActionItem[]>;

  /**
   * Compute the compact conversation-SIGNAL digest for a customer's contact
   * (most-recent meeting, fresh-summary headline, open-action-item count). This
   * is what the relationship agents consume — a derived signal, never persisted.
   * Returns an all-zero/null signal when not configured / unknown / the call
   * fails (degrade-clean), so an agent can always run (it just sees no signal).
   */
  abstract getMeetingSignal(ctx: FederationContext, contactId: string): Promise<MeetingSignal>;
}

/**
 * The Meeting-Ops federation contract — the shapes Customer-Ops consumes from the
 * conversation-intelligence app (the relationship-signal source).
 *
 * BINDING PRINCIPLE (README "What it owns vs federates" + golden rule +
 * SUITE-ARCHITECTURE-MAP §2/§7): Customer-Ops FEDERATES conversation signal.
 * **Meeting-Ops** is the system-of-record for every meeting, transcript, summary,
 * and action item (SUITE-ARCHITECTURE-MAP §2 — "Meetings, transcripts, summaries,
 * action items"). Customer-Ops never records a meeting, never stores a transcript,
 * and never copies a summary or action item. It holds NOTHING locally for
 * Meeting-Ops — there is no link table; the meeting slot on the customer-360 is
 * resolved PURELY at read time over the federation seam (the MeetingOps port) and
 * held only for the duration of a request. This is the cleanest "federate, don't
 * fork" surface in the suite: read-only signal, zero local persistence.
 *
 * Customer-Ops federates the **Meeting-Ops APP** (by workspace_id), keyed to a
 * customer's federated Contact-Ops contact id (Meeting-Ops resolves which
 * meetings a contact participated in). This file is the APP's `/mcp`-style read
 * contract, informed by Meeting-Ops's known data model (meetings → transcripts →
 * summaries → action items, plus its existing action-item → Project-Ops bridge),
 * exactly as the Accounting-Ops / Outreach / Email-Ops seams mirror those apps'
 * tool surfaces. Meeting-Ops emits the action-item → Project-Ops task bridge
 * itself; Customer-Ops only SURFACES the action items (and whether each already
 * became a task) — it never creates the task.
 */

/** One participant on a meeting, as Meeting-Ops resolves them. When Meeting-Ops
 *  has matched the participant to a Contact-Ops contact it carries `contactId`
 *  (the same federated id Customer-Ops keys on); otherwise just a display label. */
export interface MeetingParticipant {
  /** The federated Contact-Ops contact id, if Meeting-Ops matched one (else null). */
  contactId: string | null;
  /** Display name (header/diarization label). */
  displayName: string;
  /** The participant's email, if Meeting-Ops resolved one (never stored here). */
  email: string | null;
}

/**
 * A MEETING as Meeting-Ops exposes it — the read-time projection the
 * customer-360 renders. Meeting-Ops owns the meeting + the transcript; this
 * carries only the load-bearing header fields (no transcript body). Surfaced on
 * the customer when one of its participants matches the customer's contact.
 */
export interface FederatedMeeting {
  /** Meeting-Ops meeting/session id (the app's; opaque to Customer-Ops). */
  id: string;
  /** Meeting title/subject. */
  title: string | null;
  /** ISO-8601 start/end of the meeting (either may be null for an in-progress one). */
  startedAt: string | null;
  endedAt: string | null;
  /** Duration in seconds, if Meeting-Ops computed it. */
  durationSeconds: number | null;
  /** recording|processing|transcribed|summarized|failed (Meeting-Ops status). */
  status: string;
  /** Whether a summary exists yet (drives the "summary ready" affordance). */
  hasSummary: boolean;
  /** Count of action items extracted from this meeting. */
  actionItemCount: number;
  /** The distinct participants Meeting-Ops resolved on the meeting. */
  participants: MeetingParticipant[];
}

/**
 * A meeting SUMMARY as Meeting-Ops exposes it (its `get_meeting_summary` /
 * `list_summaries_for_contact` output). The read-time projection the
 * customer-360 renders when the operator/agent wants the gist of a conversation.
 * Meeting-Ops owns the summary; Customer-Ops never stores it.
 */
export interface FederatedMeetingSummary {
  /** Meeting-Ops summary id (the app's). */
  id: string;
  /** The meeting this summary belongs to. */
  meetingId: string;
  /** A short headline (one-liner) for the meeting. */
  headline: string | null;
  /** The summary body (the abstract / recap). The whole transcript stays in
   *  Meeting-Ops — this is the model-produced recap, not the raw transcript. */
  body: string | null;
  /** Optional key points / highlights Meeting-Ops extracted. */
  keyPoints: string[];
  /** ISO-8601 when the summary was produced. */
  createdAt: string | null;
}

/**
 * An ACTION ITEM as Meeting-Ops exposes it (its `list_action_items_for_contact`
 * output). Meeting-Ops extracts these from a meeting and runs its OWN
 * action-item → Project-Ops task bridge; Customer-Ops only SURFACES them (and
 * whether each already became a Project-Ops task via `projectOpsTaskId`). The
 * relationship agents (lead-triage / follow-up) read these as conversation
 * signal; the cockpit never creates the task (that is Meeting-Ops' bridge).
 */
export interface FederatedActionItem {
  /** Meeting-Ops action-item id (the app's). */
  id: string;
  /** The meeting this action item came from. */
  meetingId: string;
  /** The action-item text (what someone committed to). */
  text: string;
  /** open|in_progress|done|cancelled (Meeting-Ops action-item status). */
  status: string;
  /** The assignee Meeting-Ops resolved (a contactId if matched, else a label). */
  assigneeContactId: string | null;
  assigneeLabel: string | null;
  /** ISO-8601 due date, if Meeting-Ops parsed one. */
  dueAt: string | null;
  /** The Project-Ops task id IF Meeting-Ops' bridge already created one (else
   *  null). Customer-Ops surfaces this as a "→ task" indicator; it NEVER writes
   *  it (the bridge is Meeting-Ops' job). */
  projectOpsTaskId: string | null;
  /** ISO-8601 when the action item was extracted. */
  createdAt: string | null;
}

/**
 * The compact conversation-signal projection the relationship AGENTS consume
 * (lead-triage / follow-up drafter). It is the read-time digest of a customer's
 * meeting history — the most-recent meeting, whether a fresh summary exists, the
 * count of open action items — assembled by the MeetingOpsPort. It holds NO
 * transcript and is never persisted; it is a derived signal, not a record.
 */
export interface MeetingSignal {
  /** How many meetings Meeting-Ops has for this contact (cap-bounded read). */
  meetingCount: number;
  /** ISO-8601 of the most recent meeting (null when there are none / dormant). */
  lastMeetingAt: string | null;
  /** The most recent meeting's title, for a human one-liner. */
  lastMeetingTitle: string | null;
  /** Count of OPEN action items across the contact's meetings (drives follow-up). */
  openActionItemCount: number;
  /** The most recent summary headline, if any (the freshest conversational gist). */
  latestSummaryHeadline: string | null;
}

/** Filters Customer-Ops passes through to Meeting-Ops list reads. */
export interface ListMeetingsFilter {
  /** Max meetings/summaries/action-items to read (the app caps too). */
  limit?: number;
  /** Opaque pagination cursor (the app's). */
  cursor?: string | null;
}

/** A page of federated meetings (mirrors Meeting-Ops list output). */
export interface FederatedMeetingPage {
  items: FederatedMeeting[];
  count: number;
  nextCursor: string | null;
}

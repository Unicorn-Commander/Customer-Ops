/**
 * The Outreach federation contract — the shapes Customer-Ops exchanges with the
 * (future) Outreach APP (the campaign / social-touch surface over Listmonk email
 * + Postiz social).
 *
 * BINDING PRINCIPLE (README "What it owns vs federates" + golden rule +
 * SUITE-ARCHITECTURE-MAP §3/§7): Customer-Ops FEDERATES outreach. **Outreach** is
 * the campaign engine-surface (it fronts Listmonk lists/campaigns/sends + Postiz
 * scheduled social posts); it is the system-of-record for every campaign, list,
 * send, and social touch. Customer-Ops never runs a campaign engine, never
 * stores a recipient list, and never copies a send/touch record. The only
 * outreach data it persists is the thin CustomerOutreachLink (one row per
 * (contact, campaign/sequence) enrollment Customer-Ops kicked off, + a cached
 * last-known state); everything in this file is the WIRE shape resolved over the
 * federation seam at read/write time.
 *
 * Customer-Ops federates the future **Outreach APP** (by workspace_id), NEVER
 * Listmonk/Postiz directly. The deliverability lanes stay the Outreach app's
 * concern (campaigns → Listmonk own domain; cold → another domain; never the
 * transactional/invoice lane). This file is informed by those engines' real
 * shapes but is the APP's `/mcp`-style contract, exactly like the Accounting-Ops
 * seam mirrors AO's tools.
 *
 * THE CONTRACT (what the Outreach app must implement — see the port doc for the
 * tool surface). Channels:
 *   - 'email'  — a Listmonk campaign/sequence enrollment (audience = a CO contact).
 *   - 'social' — a Postiz scheduled social post ("touch") attributed to a contact.
 */

/** Which Outreach channel a campaign/touch runs over. */
export type OutreachChannel = 'email' | 'social';

/**
 * A campaign/sequence as the Outreach app exposes it (Listmonk campaign or a
 * multi-step sequence). The system-of-record is Outreach; this is the read-time
 * projection the cockpit renders when offering "start a campaign".
 */
export interface OutreachCampaign {
  /** Outreach campaign/sequence id (the app's; opaque to Customer-Ops). */
  id: string;
  name: string;
  channel: OutreachChannel;
  /** draft|scheduled|running|paused|finished (Outreach campaign.status). */
  status: string;
  /** A sequence enrolls a contact into N steps; a one-shot campaign is 1. */
  isSequence: boolean;
  /** Listmonk list id / Postiz channel id the campaign targets (opaque). */
  listId: string | null;
  /** ISO-8601; when the campaign was created in Outreach. */
  createdAt: string | null;
}

/**
 * One outreach TOUCH against a customer's contact — a unit of contact history
 * the Outreach app owns: a campaign send (email) or a scheduled/published social
 * post. Customer-Ops surfaces these on the customer-360 but never authors the
 * underlying send; it only requests enrollment / scheduling via the app.
 *
 * Engagement signal (opened/clicked/replied/bounced) is what drives the
 * funnel-stage hook — it rides on the touch from the Outreach app (which gets it
 * from Listmonk bounce/click webhooks / Postiz status), never computed locally.
 */
export interface OutreachTouch {
  /** Outreach touch id (send id / scheduled-post id; the app's). */
  id: string;
  channel: OutreachChannel;
  /** The campaign/sequence this touch belongs to (null for an ad-hoc touch). */
  campaignId: string | null;
  campaignName: string | null;
  /** queued|scheduled|sent|delivered|opened|clicked|replied|bounced|failed. */
  status: string;
  /** A short human subject/summary (email subject, or the social post text). */
  subject: string | null;
  /** ISO-8601 timestamps for the lifecycle (any may be null). */
  scheduledAt: string | null;
  sentAt: string | null;
  /** The last engagement event seen on this touch, if any (drives the hook). */
  lastEngagementKind: OutreachEngagementKind | null;
  lastEngagementAt: string | null;
}

/**
 * The normalized engagement signal Customer-Ops reacts to. Maps Listmonk/Postiz
 * raw events to a small, stable vocabulary so the stage-change hook is engine-
 * agnostic. POSITIVE engagement (replied/clicked/opened) can ADVANCE the funnel;
 * a hard bounce is a data-quality signal (never an advance).
 */
export type OutreachEngagementKind = 'opened' | 'clicked' | 'replied' | 'bounced' | 'unsubscribed';

/**
 * The enrollment request Customer-Ops sends to the Outreach app to start a
 * campaign/sequence for a customer's contact. `externalRef` is the DETERMINISTIC
 * idempotency key Customer-Ops mints (the Outreach app is idempotent on
 * (workspace_id, external_source='customer-ops', external_ref)) so a retry never
 * double-enrolls the contact.
 */
export interface CampaignEnrollment {
  /** Outreach campaign/sequence id to enroll into (the app's). */
  campaignId: string;
  /** The federated Contact-Ops contact id — a thin reference the app stores in
   *  its own external_refs; the contact record itself is NEVER copied. */
  contactId: string;
  /** The contact's email (email channel) — the app resolves the address; passed
   *  for the app's audience binding, not stored by Customer-Ops. */
  contactEmail?: string | null;
  /** Always 'customer-ops' for enrollments this app creates. */
  externalSource: string;
  /** Deterministic idempotency key minted by Customer-Ops. */
  externalRef: string;
  /** Optional per-enrollment merge fields the app templates into the campaign. */
  mergeFields?: Record<string, string> | null;
}

/**
 * The request to schedule a single SOCIAL touch (Postiz) attributed to a
 * customer's contact — e.g. a personalized post/DM. Same idempotency tuple.
 */
export interface SocialTouchRequest {
  /** The Postiz channel/account id (the app's; which social account posts). */
  channelId: string;
  /** The federated Contact-Ops contact id (thin reference; never copied). */
  contactId: string;
  /** The post body / caption. The app owns rendering + posting. */
  body: string;
  /** ISO-8601 when to publish; null/omitted = the app's default (e.g. now). */
  scheduledAt?: string | null;
  externalSource: string;
  externalRef: string;
}

/**
 * The result of an enrollment / social-touch request from the Outreach app: the
 * touch/enrollment the app created (its id + initial status), echoed back so
 * Customer-Ops can cache a thin projection on its link row. Idempotent: a repeat
 * with the same tuple returns the EXISTING enrollment (no second send queued).
 */
export interface OutreachEnrollmentResult {
  /** The Outreach enrollment/touch id (the app's). */
  id: string;
  channel: OutreachChannel;
  campaignId: string | null;
  campaignName: string | null;
  /** Initial/last status the app reports (queued|scheduled|...). */
  status: string;
  externalSource: string | null;
  externalRef: string | null;
  /** ISO-8601; when the enrollment/touch was created in Outreach. */
  createdAt: string | null;
}

/**
 * The result of the entitlement decision for an Outreach federation call.
 * `allowed` gates whether the federation call is made at all; `reason` is logged
 * + (on deny) surfaced. `mode` records which posture decided it (enforce vs the
 * open bootstrap) for auditability. Identical shape to the AO decision.
 */
export interface EntitlementDecision {
  allowed: boolean;
  mode: 'enforce' | 'open';
  reason: string;
}

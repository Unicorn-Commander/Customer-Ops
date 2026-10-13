/**
 * The Email-Ops federation contract — the shapes Customer-Ops exchanges with the
 * (future) Email-Ops APP (the mailbox / thread surface over the Stalwart mail
 * server, plus the agent-inbox approval surface for outbound agent mail).
 *
 * BINDING PRINCIPLE (README "What it owns vs federates" + golden rule +
 * SUITE-ARCHITECTURE-MAP §3/§7): Customer-Ops FEDERATES mailboxes. **Email-Ops**
 * is the mailbox surface (it fronts Stalwart IMAP/JMAP for mailbox state +
 * threads); it is the system-of-record for every mailbox, thread, and message.
 * Customer-Ops never runs a mail server, never stores a message body, and never
 * copies a thread. The only mail data it persists is the thin CustomerEmailLink
 * (one row per outbound draft/send Customer-Ops initiated + a cached last-known
 * state); everything in this file is the WIRE shape resolved over the federation
 * seam at read/write time.
 *
 * Customer-Ops federates the future **Email-Ops APP** (by workspace_id), NEVER
 * Stalwart directly. The deliverability lane is the Email-Ops/transactional
 * concern (transactional outbound → Postmark, per the suite map). This file is
 * informed by Stalwart's IMAP/JMAP thread shape but is the APP's `/mcp`-style
 * contract, exactly like the Accounting-Ops seam mirrors AO's tools.
 *
 * THE CONTRACT (what the Email-Ops app must implement — see the port doc for the
 * tool surface). The 360 surfaces THREADS with a customer's contact; the actions
 * SEND an email (queued via Email-Ops → Stalwart/Postmark) or stage a DRAFT into
 * the agent-inbox approval surface.
 */

/**
 * One participant on a mail thread/message (a from/to/cc address). Email-Ops
 * resolves the display name from the header; Customer-Ops never stores it.
 */
export interface EmailParticipant {
  address: string;
  name: string | null;
}

/**
 * A mailbox THREAD with a customer's contact, as Email-Ops exposes it (a JMAP
 * Thread / IMAP conversation). The read-time projection the customer-360 renders.
 * Email-Ops owns the thread; Customer-Ops holds nothing.
 */
export interface EmailThread {
  /** Email-Ops thread id (JMAP threadId / the app's; opaque to Customer-Ops). */
  id: string;
  /** The thread subject (last/representative subject line). */
  subject: string | null;
  /** Number of messages in the thread. */
  messageCount: number;
  /** Whether the thread has any unread message in the workspace's mailbox. */
  unread: boolean;
  /** ISO-8601 of the most recent message in the thread. */
  lastMessageAt: string | null;
  /** A short snippet/preview of the latest message (no full body). */
  lastSnippet: string | null;
  /** The distinct participants across the thread (deduped by Email-Ops). */
  participants: EmailParticipant[];
}

/**
 * One MESSAGE within a thread (a JMAP Email / IMAP message), surfaced when the
 * cockpit expands a thread. Bodies are a PREVIEW only — the full message lives in
 * Email-Ops/Stalwart; Customer-Ops never persists message content.
 */
export interface EmailMessage {
  /** Email-Ops message id (JMAP emailId / the app's). */
  id: string;
  threadId: string;
  from: EmailParticipant | null;
  to: EmailParticipant[];
  subject: string | null;
  /** ISO-8601 sent/received time. */
  sentAt: string | null;
  /** A preview/snippet of the body (NOT the full message). */
  preview: string | null;
  /** received | sent | draft (the message's direction/state in the mailbox). */
  direction: string;
}

/**
 * The request Customer-Ops sends to Email-Ops to compose an outbound email to a
 * customer's contact. `mode` selects the lane:
 *   - 'send'  — queue it for delivery now (Email-Ops → Stalwart/Postmark).
 *   - 'draft' — stage it into the agent-inbox approval surface (human approves
 *               before it leaves). The brief's "send/draft an email".
 * `externalRef` is the DETERMINISTIC idempotency key Customer-Ops mints (the
 * Email-Ops app is idempotent on (workspace_id, external_source='customer-ops',
 * external_ref)) so a retry never double-sends.
 */
export interface EmailComposeRequest {
  /** The federated Contact-Ops contact id this email is to (thin reference,
   *  never copied). Email-Ops resolves the deliverable address. */
  contactId: string;
  /** The recipient email address (passed for Email-Ops' addressing; Customer-Ops
   *  does NOT store it). */
  toAddress: string;
  /** Mailbox to send as. Omitted means the workspace default mailbox. */
  fromAddress?: string | null;
  subject: string;
  /** The plain-text body Customer-Ops composed (or an agent drafted). */
  body: string;
  /** Optional thread to reply within (Email-Ops threads the reply correctly). */
  inReplyToThreadId?: string | null;
  /** 'send' = deliver now; 'draft' = stage for agent-inbox approval. */
  mode: 'send' | 'draft';
  /** Always 'customer-ops' for messages this app initiates. */
  externalSource: string;
  /** Deterministic idempotency key minted by Customer-Ops. */
  externalRef: string;
}

/**
 * The result of a compose (send/draft) from Email-Ops: the message it created +
 * its initial state, echoed back so Customer-Ops can cache a thin projection on
 * its link row. Idempotent: a repeat with the same tuple returns the EXISTING
 * message (no second send queued).
 */
export interface EmailComposeResult {
  /** The Email-Ops message id (the app's). */
  id: string;
  /** The thread the message landed in (new or the replied-to thread). */
  threadId: string | null;
  /** queued | sent | delivered | draft | pending_approval | failed. */
  status: string;
  /** 'send' | 'draft' — which lane was used (echoed). */
  mode: string;
  externalSource: string | null;
  externalRef: string | null;
  /** ISO-8601; when the message was created in Email-Ops. */
  createdAt: string | null;
}

/**
 * The result of the entitlement decision for an Email-Ops federation call.
 * Identical shape to the AO / Outreach decision. `allowed` gates whether the
 * federation call is made at all; `reason` is logged + (on deny) surfaced;
 * `mode` records which posture decided it (enforce vs the open bootstrap).
 */
export interface EntitlementDecision {
  allowed: boolean;
  mode: 'enforce' | 'open';
  reason: string;
}

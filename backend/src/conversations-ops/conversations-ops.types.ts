/**
 * The Conversations federation contract — the shapes Customer-Ops exchanges with
 * a device-resident messaging bridge (the UUDA/UUDC `messages.*` MCP tools) that
 * fronts the worker's own Messages app (iMessage + SMS-via-Continuity).
 *
 * BINDING PRINCIPLE (golden rule): Customer-Ops FEDERATES conversations. The
 * DEVICE (via UUDC) is the system-of-record for the worker's iMessage/SMS; the
 * enterprise/shared-line channel is owned by the Comms engine (Email-Ops, a later
 * track). Customer-Ops never stores a message body and never copies a thread —
 * everything here is the WIRE shape resolved over the seam at read/write time.
 *
 * The wire is the UUDC agent's MCP surface (Streamable HTTP at `/mcp/v1`), tools:
 *   - messages.list  -> { conversations: Conversation[] }  (read; viewer-level)
 *   - messages.thread(chat_identifier) -> { messages: ChatMessage[] }
 *   - messages.send(to, body, service, dry_run) -> { changeSet, serviceUsed }
 * The transport is swappable (direct mTLS to the device today; a control-plane
 * MCP gateway later) without touching relationship logic — exactly like the
 * Email-Ops seam.
 */

/** A single message within a device conversation (a projection of the UUDC
 *  `ChatMessage`). Bodies are surfaced as previews; the device owns the store. */
export interface ConversationMessage {
  /** The device message id (chat.db ROWID, stringified) — opaque to Customer-Ops. */
  id: string;
  /** ISO-8601 send/receive time. */
  at: string | null;
  /** True when the worker sent it; false when the contact did. */
  fromMe: boolean;
  /** The other party's handle (phone/email); empty when fromMe. */
  sender: string;
  /** A preview of the message text (NOT a stored copy). */
  text: string;
  /** 'iMessage' | 'SMS'. */
  channel: string;
  hasAttachments: boolean;
}

/**
 * A device CONVERSATION with one of a contact's handles (phone/email), summarised
 * by its most-recent message. The read-time projection the customer-360 renders.
 * The device owns the conversation; Customer-Ops holds nothing.
 */
export interface ConversationThread {
  /** The conversation identifier (the device chat identifier = the handle). */
  id: string;
  /** The matched contact handle (phone e164 or email) this conversation is with. */
  handle: string;
  /** 'iMessage' | 'SMS'. */
  channel: string;
  /** A display name for the conversation, when the device knows one. */
  displayName: string | null;
  /** ISO-8601 of the most recent message. */
  lastMessageAt: string | null;
  /** A short snippet/preview of the latest message (no full body). */
  lastSnippet: string | null;
  /** Whether the latest message was sent by the worker (vs received). */
  lastFromMe: boolean;
}

/**
 * The request Customer-Ops sends to the device bridge to send a message to a
 * contact's handle. `channel` selects iMessage vs SMS (empty = auto/iMessage).
 * `externalRef` is the deterministic idempotency key Customer-Ops mints.
 */
export interface ConversationSendRequest {
  /** The recipient handle (phone/email) to send to. */
  to: string;
  /** The plain-text body to send. */
  body: string;
  /** 'iMessage' | 'SMS' | '' (auto). */
  channel?: string;
  /** Deterministic idempotency key minted by Customer-Ops. */
  externalRef: string;
}

/** The result of a send via the device bridge (echoed from UUDC messages.send). */
export interface ConversationSendResult {
  /** True when the message was actually sent (false on a dry run). */
  applied: boolean;
  /** The channel the device used ('iMessage' | 'SMS'). */
  channel: string;
}

/**
 * The entitlement decision for a Conversations federation write. Same shape as
 * the AO / Email decision. Sending from the device cockpit requires `customer-ops`
 * (the worker's own cockpit + device); reads are viewer-level (no SKU).
 */
export interface EntitlementDecision {
  allowed: boolean;
  mode: 'enforce' | 'open';
  reason: string;
}

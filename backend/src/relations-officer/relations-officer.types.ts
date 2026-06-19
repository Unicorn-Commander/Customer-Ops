/**
 * The Relations Officer contract — the shapes the conversational orchestrator
 * exchanges over its two routes.
 *
 * The Relations Officer is the cockpit's CONVERSATIONAL surface (the orchestrator
 * persona). It is grounded in the caller's workspace (a condensed customer-360 or
 * a pipeline summary), and runs in one of two modes:
 *
 *   - ADVISOR  — it reads + recommends only. It NEVER proposes a write; any
 *     `action` the model emits is forbidden and dropped.
 *   - OPERATOR — it MAY propose exactly ONE relationship write when the user
 *     clearly asks for one. The proposal is validated into a single-use pending
 *     action the user must CONFIRM; nothing executes until then.
 *
 * Writes always need confirmation; reads + recommendations never do. This mirrors
 * the proven suite "Guide" safety pattern (model PROPOSES → validate → single-use
 * pending → user confirms → execute AS the user, audited).
 *
 * The Relations Officer is a SURFACE, not an engine: it never claims to be the
 * phonebook (Contact-Ops), the biller (Accounting-Ops), or a mail server. The
 * only writes it can ever propose are the 4 relationship-lifecycle writes the
 * CustomersService already owns + audits (transition_stage / add_note / mark_lost
 * / reopen). Invoice / email / send / charge are OUT of scope by construction.
 */

/** The conversation mode. advisor = read+recommend only; operator = may propose
 *  exactly one confirm-gated write. */
export type RelationsOfficerMode = 'advisor' | 'operator';

/** The 4 relationship writes the operator may propose — and ONLY these. Each maps
 *  1:1 to a CustomersService `*ForUser` write method that already audits via a
 *  customer activity. NO invoice/email/send/charge action is representable here. */
export type RelationsOfficerActionKind =
  | 'transition_stage'
  | 'add_note'
  | 'mark_lost'
  | 'reopen';

/** One chat turn in the conversation (the model's wire history). The system turn
 *  is assembled server-side (persona + grounding) and is NOT accepted from the
 *  client — only 'user' / 'assistant' turns are. */
export interface RelationsOfficerMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A validated, single-use pending write the user must confirm. Stored server-side
 * (never returned in full); only the safe projection (`ProposedAction`) crosses
 * the wire. `userKey` + `workspaceId` bind it to the proposing user + workspace so
 * a confirm from anyone else (or another workspace) is rejected.
 */
export interface PendingAction {
  id: string;
  /** The acting user's uchub sub (ucUidOf) — the confirm must come from the same. */
  userKey: string;
  /** The workspace the proposal was made in — the confirm must address the same. */
  workspaceId: string;
  /** The relationship the write targets (required for every kind). */
  customerId: string;
  kind: RelationsOfficerActionKind;
  /** The validated args for the kind (shape depends on `kind`). */
  args: RelationsOfficerActionArgs;
  /** Epoch ms after which the action is expired + unusable (5-min TTL). */
  expiresAt: number;
}

/** The per-kind validated args. A discriminated set kept loose at the type edge
 *  (validated at runtime in the service): transition_stage → { toStage },
 *  add_note → { body }, mark_lost → { reason }, reopen → {}. */
export interface RelationsOfficerActionArgs {
  /** transition_stage: the target funnel stage (LEAD | PROSPECT | CUSTOMER). */
  toStage?: string;
  /** add_note: the freeform note body. */
  body?: string;
  /** mark_lost: the closed-lost reason. */
  reason?: string;
}

/** The safe projection of a pending action returned to the client to render a
 *  Confirm/Cancel card. Carries NO user/workspace binding + NO TTL internals. */
export interface ProposedAction {
  id: string;
  kind: RelationsOfficerActionKind;
  /** A short human label, e.g. "Move to PROSPECT" / "Add a note". */
  label: string;
  /** A one-line human detail of exactly what will happen on confirm. */
  detail: string;
  customerId: string | null;
}

/** The POST /chat response. `proposedAction` is present ONLY in operator mode when
 *  the model proposed a valid write (advisor mode is always null). */
export interface RelationsOfficerChatResult {
  reply: string;
  mode: RelationsOfficerMode;
  customerId: string | null;
  proposedAction?: ProposedAction | null;
  /** False when no inference gateway is configured — the reply says so cleanly. */
  inferenceConfigured: boolean;
}

/** The POST /confirm-action response. */
export interface RelationsOfficerConfirmResult {
  executed: boolean;
  kind?: RelationsOfficerActionKind;
  /** The CustomersService write result on a confirmed execution. */
  result?: unknown;
  message: string;
}

/** The structured object the model is asked to return: a reply + an optional write
 *  proposal. The service parses this with the shared agents JSON parser and treats
 *  `action` as null in advisor mode. */
export interface RelationsOfficerModelOutput {
  reply: string;
  action: {
    kind: RelationsOfficerActionKind;
    args: RelationsOfficerActionArgs;
  } | null;
}

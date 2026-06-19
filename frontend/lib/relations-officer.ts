/**
 * Typed client for the Relations Officer chat — the workspace-level relationship
 * agent. It mirrors the same workspace-scoped REST surface as the rest of the
 * cockpit (`/workspaces/:workspaceId/customers/...`) and uses the same
 * `apiPost` transport, so auth + error handling stay identical to lib/customers.
 *
 * The Officer ADVISES by default and only ACTS on a confirmed proposal: a turn
 * may return a single `proposedAction`, which the UI surfaces as a Confirm/Cancel
 * card and resolves through `confirmRelationsOfficerAction`. The agent proposes,
 * the human decides — nothing executes without that confirm.
 */

import { apiPost } from './api';

/** Chat posture. `advisor` is read/think-only; `operator` may propose actions. */
export type RelationsOfficerMode = 'advisor' | 'operator';

/** Chat role on the wire (assistant left, user right). */
export type RelationsOfficerRole = 'user' | 'assistant';

/** One message in the rolling transcript sent to the Officer. */
export interface RelationsOfficerMessage {
  role: RelationsOfficerRole;
  content: string;
}

/**
 * A single proposed write the Officer wants to make on the user's behalf. It is
 * NEVER executed inline — the UI renders it as a Confirm/Cancel card and only a
 * `confirm` decision runs it (via confirmRelationsOfficerAction).
 */
export interface RelationsOfficerProposedAction {
  id: string;
  kind: string;
  label: string;
  detail: string;
  customerId: string | null;
}

/** A Relations Officer chat reply. `proposedAction` is the optional confirm-gate. */
export interface RelationsOfficerChatResponse {
  reply: string;
  mode: string;
  customerId: string | null;
  proposedAction?: RelationsOfficerProposedAction | null;
  /** When false the backend has no inference wired — the reply is the affordance. */
  inferenceConfigured: boolean;
}

/** The result of confirming / cancelling a proposed action. */
export interface RelationsOfficerConfirmResponse {
  executed: boolean;
  kind?: string;
  result?: unknown;
  message: string;
}

/** The chat request body (mirrors the backend ChatDto). */
export interface RelationsOfficerChatRequest {
  messages: RelationsOfficerMessage[];
  mode: RelationsOfficerMode;
  /** Ground the turn on one relationship; null = workspace-level chat. */
  customerId: string | null;
}

function base(ws: string): string {
  return `/workspaces/${encodeURIComponent(ws)}/relations-officer`;
}

/** Send a turn to the Relations Officer (advisor or operator). */
export async function chatRelationsOfficer(
  ws: string,
  body: RelationsOfficerChatRequest,
): Promise<RelationsOfficerChatResponse> {
  return apiPost<RelationsOfficerChatResponse>(`${base(ws)}/chat`, body);
}

/** Confirm or cancel a proposed action. Only `confirm` executes it. */
export async function confirmRelationsOfficerAction(
  ws: string,
  body: { actionId: string; decision: 'confirm' | 'cancel' },
): Promise<RelationsOfficerConfirmResponse> {
  return apiPost<RelationsOfficerConfirmResponse>(`${base(ws)}/confirm-action`, body);
}

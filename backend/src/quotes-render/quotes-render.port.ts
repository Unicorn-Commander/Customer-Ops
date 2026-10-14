/**
 * The public-quote SOURCE port. The renderer needs three things from the data
 * layer: resolve a share token to a client-safe view (recording the view),
 * begin an acceptance (pending + emailed code), and confirm it. L1 binds this
 * port to the real repository; this lane ships `FixtureQuoteSource`.
 */

import type { QuoteView } from './quote-view';

export interface RequestMeta {
  ip: string | null;
  ua: string | null;
  idempotency_key?: string | null;
}

export type PublicLookup =
  | { found: true; view: QuoteView; token_prefix: string }
  | { found: false };

export interface AcceptPayload {
  name: string;
  email: string;
  title: string | null;
  accepted: boolean;
  selected_line_ids: string[];
}

export type AcceptOutcome =
  | { ok: true; status: 202; pending_id: string; expires_at: string; email_hint: string }
  | { ok: false; status: number; code: string; detail: string };

export interface ConfirmPayload {
  pending_id: string | null;
  code: string;
}

export type ConfirmOutcome =
  | { ok: true; status: 200; accepted_at: string }
  | { ok: false; status: number; code: string; detail: string; attempts_left?: number };

export abstract class QuotePublicSource {
  /** Resolve a token → view. Records the view (first open flips `viewed`). */
  abstract lookup(token: string, meta: RequestMeta): Promise<PublicLookup>;
  /** Step one: store a pending acceptance and send the code (A1). */
  abstract beginAcceptance(
    token: string,
    payload: AcceptPayload,
    meta: RequestMeta,
  ): Promise<AcceptOutcome>;
  /** Step two: the code commits the acceptance (A1). */
  abstract confirmAcceptance(
    token: string,
    payload: ConfirmPayload,
    meta: RequestMeta,
  ): Promise<ConfirmOutcome>;
}

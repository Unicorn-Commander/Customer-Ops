/**
 * FixtureQuoteSource — the in-memory implementation of QuotePublicSource the
 * lane builds against. It holds the Order Pad record under several tokens so
 * every public state renders, and implements the two-step acceptance exactly
 * as A1/A2/A10 describe (pending + code, five wrong codes void, superseded →
 * 409, expired/revoked → 410, recipients gate, Idempotency-Key replay).
 *
 * The one-time code is fixed (see FIXTURE_CODE) because nothing is emailed in
 * the mock; L1 replaces this class with the repository + Email-Ops send.
 */

import { Injectable } from '@nestjs/common';
import type { QuoteRecord } from '../quote-model';
import { toQuoteView, type AcceptanceState, type QuoteView } from '../quote-view';
import { FIXTURE_TOKEN_CURRENT, FIXTURE_TOKEN_SUPERSEDED, orderPadRecord } from './orderpad.fixture';
import { AcceptOutcome, AcceptPayload, ConfirmOutcome, ConfirmPayload, PublicLookup, QuotePublicSource, RequestMeta } from '../quotes-render.port';

export const FIXTURE_CODE = '424242';
export const PENDING_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;

export const FIXTURE_TOKENS = {
  current: FIXTURE_TOKEN_CURRENT,
  superseded: FIXTURE_TOKEN_SUPERSEDED,
  expired: 'fx-orderpad-expired',
  accepted: 'fx-orderpad-accepted',
  recorded: 'fx-orderpad-recorded',
  revoked: 'fx-orderpad-revoked',
  declined: 'fx-orderpad-declined',
} as const;

interface Entry {
  record: QuoteRecord;
  version_no: number;
}

interface Pending {
  token: string;
  payload: AcceptPayload;
  code: string;
  expires_at: number;
  attempts: number;
  voided: boolean;
  ip: string | null;
  ua: string | null;
}

let seq = 0;
const nextId = (p: string) => `${p}-${(++seq).toString(36)}`;

@Injectable()
export class FixtureQuoteSource extends QuotePublicSource {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Pending>();
  private readonly replays = new Map<string, AcceptOutcome | ConfirmOutcome>();
  private now: () => Date = () => new Date();

  constructor() {
    super();
    this.reset();
  }

  /** Tests pin the clock. */
  setClock(fn: () => Date): void {
    this.now = fn;
  }

  /** Reseed every token from the fixture (idempotent; tests call it). */
  reset(): void {
    this.entries.clear();
    this.pending.clear();
    this.replays.clear();
    const base = orderPadRecord();
    // The live record serves BOTH its tokens (v1 superseded, v2 current).
    this.entries.set(FIXTURE_TOKENS.current, { record: base, version_no: 2 });
    this.entries.set(FIXTURE_TOKENS.superseded, { record: base, version_no: 1 });

    const expired = orderPadRecord();
    expired.quote.status = 'expired';
    expired.quote.valid_until = '2026-08-01';
    for (const t of expired.share_tokens) t.expires_at = '2026-08-01T23:59:59Z';
    expired.events.push({ id: 'e-exp', quote_id: expired.quote.id, at: '2026-08-02T00:00:00Z', actor: 'system', kind: 'expired', data: null, ip: null, ua: null });
    this.entries.set(FIXTURE_TOKENS.expired, { record: expired, version_no: 2 });

    const accepted = orderPadRecord();
    this.markAccepted(accepted, { name: 'Jordan Mercer', email: 'jordan.mercer@example.com', title: 'Operations lead', ip: '203.0.113.7', ua: 'Chrome on macOS' }, '2026-09-12T19:41:00Z', ['l-pkg-improve'], null);
    this.entries.set(FIXTURE_TOKENS.accepted, { record: accepted, version_no: 2 });

    const recorded = orderPadRecord();
    this.markAccepted(recorded, { name: 'Jordan Mercer', email: 'jordan.mercer@example.com', title: 'Operations lead', ip: null, ua: null, recorded_by_member: 'Aaron Stransky', how: 'accepted on the 09-12 call' }, '2026-09-12T20:05:00Z', ['l-pkg-improve'], 'member:aaron');
    this.entries.set(FIXTURE_TOKENS.recorded, { record: recorded, version_no: 2 });

    const revoked = orderPadRecord();
    for (const t of revoked.share_tokens) t.revoked_at = '2026-09-12T20:00:00Z';
    revoked.events.push({ id: 'e-rev', quote_id: revoked.quote.id, at: '2026-09-12T20:00:00Z', actor: 'member:aaron', kind: 'revoked', data: { reason: 'sent to the wrong address' }, ip: null, ua: null });
    this.entries.set(FIXTURE_TOKENS.revoked, { record: revoked, version_no: 2 });

    const declined = orderPadRecord();
    declined.quote.status = 'declined';
    declined.quote.decline_reason = 'Board chose to wait a quarter.';
    declined.events.push({ id: 'e-dec', quote_id: declined.quote.id, at: '2026-09-13T09:00:00Z', actor: 'client:fx-order', kind: 'declined', data: { reason: declined.quote.decline_reason }, ip: '203.0.113.7', ua: 'Chrome on macOS' });
    this.entries.set(FIXTURE_TOKENS.declined, { record: declined, version_no: 2 });
  }

  /** The live studio record (what the composer edits in the mock). */
  record(token: string = FIXTURE_TOKENS.current): QuoteRecord | null {
    return this.entries.get(token)?.record ?? null;
  }

  private markAccepted(record: QuoteRecord, by: NonNullable<QuoteRecord['quote']['accepted_by']>, at: string, selected: string[], actor: string | null): void {
    record.quote.status = 'accepted';
    record.quote.accepted_at = at;
    record.quote.accepted_by = by;
    for (const l of record.lines) if (l.option_group) l.selected = selected.includes(l.id);
    for (const v of record.versions) if (v.version_no === record.quote.current_version_no) v.disposition = 'accepted';
    record.events.push({ id: nextId('e'), quote_id: record.quote.id, at, actor: actor ?? `client:${FIXTURE_TOKENS.current.slice(0, 8)}`, kind: 'accepted', data: { name: by.name, title: by.title, selected_line_ids: selected, recorded_by_member: by.recorded_by_member ?? null, version_no: record.quote.current_version_no }, ip: by.ip ?? null, ua: by.ua ?? null });
    record.quote.federated = { ...record.quote.federated, status: 'pending' };
  }

  private stateOf(entry: Entry): { state: AcceptanceState; at: string | null; note: string | null } {
    const { record, version_no } = entry;
    const tok = record.share_tokens.find((t) => record.versions.find((v) => v.id === t.quote_version_id)?.version_no === version_no);
    const version = record.versions.find((v) => v.version_no === version_no);
    if (tok?.revoked_at) return { state: 'revoked', at: tok.revoked_at, note: null };
    if (version?.disposition === 'superseded') {
      const ev = record.events.find((e) => e.kind === 'superseded' && (e.data as { from_version_no?: number } | null)?.from_version_no === version_no);
      return { state: 'superseded', at: ev?.at ?? null, note: null };
    }
    if (record.quote.status === 'accepted' && version?.disposition === 'accepted') return { state: 'accepted', at: record.quote.accepted_at, note: null };
    if (record.quote.status === 'declined') return { state: 'declined', at: record.events.find((e) => e.kind === 'declined')?.at ?? null, note: record.quote.decline_reason };
    if (record.quote.status === 'voided') return { state: 'voided', at: null, note: null };
    if (record.quote.status === 'draft') return { state: 'draft', at: null, note: null };
    const expiresAt = tok ? new Date(tok.expires_at).getTime() : new Date(`${record.quote.valid_until}T23:59:59Z`).getTime();
    if (record.quote.status === 'expired' || expiresAt < this.now().getTime()) return { state: 'expired', at: tok?.expires_at ?? record.quote.valid_until, note: null };
    return { state: 'open', at: null, note: null };
  }

  private viewOf(entry: Entry): QuoteView {
    const st = this.stateOf(entry);
    const version = entry.record.versions.find((v) => v.version_no === entry.version_no);
    return toQuoteView(entry.record, {
      state: st.state,
      state_at: st.at,
      state_note: st.note,
      accepted_by: entry.record.quote.accepted_by,
      version: version ? { no: version.version_no, disposition: version.disposition } : null,
      now: this.now().toISOString(),
    });
  }

  async lookup(token: string, meta: RequestMeta): Promise<PublicLookup> {
    const entry = this.entries.get(token);
    if (!entry) return { found: false };
    const st = this.stateOf(entry);
    const tok = entry.record.share_tokens.find((t) => t.token === token);
    if (tok) {
      tok.view_count += 1;
      tok.last_viewed_at = this.now().toISOString();
    }
    if (st.state === 'open') {
      if (entry.record.quote.status === 'sent') entry.record.quote.status = 'viewed';
      entry.record.events.push({ id: nextId('e'), quote_id: entry.record.quote.id, at: this.now().toISOString(), actor: `client:${token.slice(0, 8)}`, kind: 'viewed', data: { version_no: entry.version_no }, ip: meta.ip, ua: meta.ua });
    }
    return { found: true, view: this.viewOf(entry), token_prefix: token.slice(0, 8) };
  }

  private gate(entry: Entry): { ok: true } | { ok: false; status: number; code: string; detail: string } {
    const st = this.stateOf(entry).state;
    if (st === 'open') return { ok: true };
    if (st === 'superseded') return { ok: false, status: 409, code: 'QUOTE_SUPERSEDED', detail: 'This version was replaced; only the current version can be accepted.' };
    if (st === 'expired') return { ok: false, status: 410, code: 'QUOTE_EXPIRED', detail: 'This quote has expired.' };
    if (st === 'revoked') return { ok: false, status: 410, code: 'QUOTE_REVOKED', detail: 'This link was withdrawn.' };
    if (st === 'accepted') return { ok: false, status: 409, code: 'QUOTE_ALREADY_ACCEPTED', detail: 'This quote is already accepted.' };
    return { ok: false, status: 409, code: 'QUOTE_NOT_OPEN', detail: `This quote is ${st}.` };
  }

  async beginAcceptance(token: string, payload: AcceptPayload, meta: RequestMeta): Promise<AcceptOutcome> {
    const replayKey = meta.idempotency_key ? `accept:${token}:${meta.idempotency_key}` : null;
    if (replayKey && this.replays.has(replayKey)) return this.replays.get(replayKey) as AcceptOutcome;
    const entry = this.entries.get(token);
    const outcome = await this.beginInner(entry, token, payload, meta);
    if (replayKey) this.replays.set(replayKey, outcome);
    return outcome;
  }

  private async beginInner(entry: Entry | undefined, token: string, payload: AcceptPayload, meta: RequestMeta): Promise<AcceptOutcome> {
    if (!entry) return { ok: false, status: 404, code: 'QUOTE_NOT_FOUND', detail: 'No quote at this link.' };
    const g = this.gate(entry);
    if (!g.ok) return g;
    if (!payload.accepted) return { ok: false, status: 400, code: 'ACCEPT_CHECKBOX', detail: 'Tick the acceptance statement.' };
    if (!payload.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return { ok: false, status: 400, code: 'ACCEPT_FIELDS', detail: 'A name and a valid email are required.' };
    const rec = entry.record;
    if (rec.recipients.length && !rec.recipients.some((r) => r.email.toLowerCase() === payload.email.trim().toLowerCase())) {
      return { ok: false, status: 403, code: 'NOT_A_RECIPIENT', detail: 'This quote was sent to named recipients; use the address it was sent to.' };
    }
    // Every exclusive group needs exactly one choice (A8).
    const groups = rec.quote.option_groups;
    for (const g2 of groups) {
      const members = rec.lines.filter((l) => l.option_group === g2.key);
      const chosen = members.filter((l) => payload.selected_line_ids.includes(l.id));
      if (g2.mode === 'exclusive' && chosen.length !== 1) return { ok: false, status: 400, code: 'OPTION_REQUIRED', detail: `Choose one option in "${g2.label}".` };
    }
    const pending_id = nextId('pa');
    const expires = this.now().getTime() + PENDING_TTL_MS;
    this.pending.set(pending_id, { token, payload, code: FIXTURE_CODE, expires_at: expires, attempts: 0, voided: false, ip: meta.ip, ua: meta.ua });
    rec.events.push({ id: nextId('e'), quote_id: rec.quote.id, at: this.now().toISOString(), actor: `client:${token.slice(0, 8)}`, kind: 'acceptance_pending', data: { name: payload.name, title: payload.title, selected_line_ids: payload.selected_line_ids, expires_at: new Date(expires).toISOString() }, ip: meta.ip, ua: meta.ua });
    for (const l of rec.lines) if (l.option_group) l.selected = payload.selected_line_ids.includes(l.id);
    const [user, domain] = payload.email.trim().split('@');
    const hint = `We sent a six-digit code to ${user.slice(0, 1)}•••@${domain}. It is good for ten minutes.`;
    return { ok: true, status: 202, pending_id, expires_at: new Date(expires).toISOString(), email_hint: hint };
  }

  async confirmAcceptance(token: string, payload: ConfirmPayload, meta: RequestMeta): Promise<ConfirmOutcome> {
    const replayKey = meta.idempotency_key ? `confirm:${token}:${meta.idempotency_key}` : null;
    if (replayKey && this.replays.has(replayKey)) return this.replays.get(replayKey) as ConfirmOutcome;
    const outcome = this.confirmInner(token, payload, meta);
    if (replayKey) this.replays.set(replayKey, outcome);
    return outcome;
  }

  private confirmInner(token: string, payload: ConfirmPayload, meta: RequestMeta): ConfirmOutcome {
    const entry = this.entries.get(token);
    if (!entry) return { ok: false, status: 404, code: 'QUOTE_NOT_FOUND', detail: 'No quote at this link.' };
    const g = this.gate(entry);
    if (!g.ok) return g;
    const p = payload.pending_id ? this.pending.get(payload.pending_id) : [...this.pending.values()].filter((x) => x.token === token && !x.voided).pop();
    if (!p || p.token !== token) return { ok: false, status: 404, code: 'PENDING_NOT_FOUND', detail: 'No acceptance is waiting for a code.' };
    if (p.voided) return { ok: false, status: 410, code: 'PENDING_VOIDED', detail: 'Too many wrong codes; start again.' };
    if (p.expires_at < this.now().getTime()) return { ok: false, status: 410, code: 'PENDING_EXPIRED', detail: 'The code expired; start again.' };
    if (payload.code !== p.code) {
      p.attempts += 1;
      const left = MAX_CODE_ATTEMPTS - p.attempts;
      entry.record.events.push({ id: nextId('e'), quote_id: entry.record.quote.id, at: this.now().toISOString(), actor: `client:${token.slice(0, 8)}`, kind: 'acceptance_code_failed', data: { attempts_left: left }, ip: meta.ip, ua: meta.ua });
      if (left <= 0) {
        p.voided = true;
        return { ok: false, status: 410, code: 'PENDING_VOIDED', detail: 'Too many wrong codes; the pending acceptance is void.', attempts_left: 0 };
      }
      return { ok: false, status: 400, code: 'CODE_INVALID', detail: 'That code is not right.', attempts_left: left };
    }
    const at = this.now().toISOString();
    this.markAccepted(entry.record, { name: p.payload.name.trim(), email: p.payload.email.trim(), title: p.payload.title?.trim() || null, ip: meta.ip ?? p.ip, ua: meta.ua ?? p.ua }, at, p.payload.selected_line_ids, `client:${token.slice(0, 8)}`);
    this.pending.delete(payload.pending_id ?? '');
    return { ok: true, status: 200, accepted_at: at };
  }
}

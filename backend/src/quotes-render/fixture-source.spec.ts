import { FIXTURE_CODE, FIXTURE_TOKENS, FixtureQuoteSource, MAX_CODE_ATTEMPTS } from './fixtures/fixture-source';

const meta = { ip: '198.51.100.9', ua: 'jest', idempotency_key: null };
const payload = { name: 'Jordan Mercer', email: 'Jordan.Mercer@example.com', title: 'Operations lead', accepted: true, selected_line_ids: ['l-pkg-improve'] };

describe('FixtureQuoteSource — the two-step acceptance (A1/A2/A10)', () => {
  let src: FixtureQuoteSource;
  beforeEach(() => {
    src = new FixtureQuoteSource();
    src.setClock(() => new Date('2026-09-12T20:00:00Z'));
  });

  it('resolves every fixture token to its state and records the view', async () => {
    const cur = await src.lookup(FIXTURE_TOKENS.current, meta);
    expect(cur.found && cur.view.acceptance.state).toBe('open');
    expect(cur.found && cur.view.version).toEqual({ no: 2, disposition: 'current' });
    const sup = await src.lookup(FIXTURE_TOKENS.superseded, meta);
    expect(sup.found && sup.view.acceptance.state).toBe('superseded');
    expect(sup.found && sup.view.version.no).toBe(1);
    for (const [k, state] of [['expired', 'expired'], ['accepted', 'accepted'], ['recorded', 'accepted'], ['revoked', 'revoked'], ['declined', 'declined']] as const) {
      const r = await src.lookup(FIXTURE_TOKENS[k], meta);
      expect(r.found && r.view.acceptance.state).toBe(state);
    }
    expect(await src.lookup('nope', meta)).toEqual({ found: false });
    const rec = src.record(FIXTURE_TOKENS.current)!;
    expect(rec.events.filter((e) => e.kind === 'viewed').length).toBeGreaterThanOrEqual(3);
    expect(rec.share_tokens.find((t) => t.token === FIXTURE_TOKENS.current)?.view_count).toBe(3);
  });

  it('walks pending → wrong code → right code → accepted, with events and the client-safe receipt', async () => {
    const begin = await src.beginAcceptance(FIXTURE_TOKENS.current, payload, meta);
    expect(begin.ok && begin.status).toBe(202);
    if (!begin.ok) return;
    expect(begin.email_hint).toContain('J•••@example.com');
    const wrong = await src.confirmAcceptance(FIXTURE_TOKENS.current, { pending_id: begin.pending_id, code: '000000' }, meta);
    expect(!wrong.ok && wrong.code).toBe('CODE_INVALID');
    expect(!wrong.ok && wrong.attempts_left).toBe(MAX_CODE_ATTEMPTS - 1);
    const right = await src.confirmAcceptance(FIXTURE_TOKENS.current, { pending_id: begin.pending_id, code: FIXTURE_CODE }, meta);
    expect(right.ok && right.status).toBe(200);
    const after = await src.lookup(FIXTURE_TOKENS.current, meta);
    expect(after.found && after.view.acceptance.state).toBe('accepted');
    expect(after.found && after.view.acceptance.accepted_by).toEqual({ name: 'Jordan Mercer', title: 'Operations lead', recorded_by_member: null });
    const rec = src.record(FIXTURE_TOKENS.current)!;
    expect(rec.quote.status).toBe('accepted');
    expect(rec.quote.accepted_by?.ip).toBe('198.51.100.9');
    expect(rec.versions.find((v) => v.version_no === 2)?.disposition).toBe('accepted');
    expect(rec.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['acceptance_pending', 'acceptance_code_failed', 'accepted']));
    // a second acceptance is refused
    const again = await src.beginAcceptance(FIXTURE_TOKENS.current, payload, meta);
    expect(!again.ok && again.code).toBe('QUOTE_ALREADY_ACCEPTED');
  });

  it('voids the pending acceptance after five wrong codes', async () => {
    const begin = await src.beginAcceptance(FIXTURE_TOKENS.current, payload, meta);
    if (!begin.ok) throw new Error('begin failed');
    let last;
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) last = await src.confirmAcceptance(FIXTURE_TOKENS.current, { pending_id: begin.pending_id, code: '111111' }, meta);
    expect(last && !last.ok && last.code).toBe('PENDING_VOIDED');
    const right = await src.confirmAcceptance(FIXTURE_TOKENS.current, { pending_id: begin.pending_id, code: FIXTURE_CODE }, meta);
    expect(!right.ok && right.code).toBe('PENDING_VOIDED');
  });

  it('expires a pending acceptance after ten minutes', async () => {
    const begin = await src.beginAcceptance(FIXTURE_TOKENS.current, payload, meta);
    if (!begin.ok) throw new Error('begin failed');
    src.setClock(() => new Date('2026-09-12T20:11:00Z'));
    const late = await src.confirmAcceptance(FIXTURE_TOKENS.current, { pending_id: begin.pending_id, code: FIXTURE_CODE }, meta);
    expect(!late.ok && late.code).toBe('PENDING_EXPIRED');
  });

  it('refuses superseded (409), expired and revoked (410) tokens on POST', async () => {
    const sup = await src.beginAcceptance(FIXTURE_TOKENS.superseded, payload, meta);
    expect(!sup.ok && [sup.status, sup.code]).toEqual([409, 'QUOTE_SUPERSEDED']);
    const exp = await src.beginAcceptance(FIXTURE_TOKENS.expired, payload, meta);
    expect(!exp.ok && [exp.status, exp.code]).toEqual([410, 'QUOTE_EXPIRED']);
    const rev = await src.beginAcceptance(FIXTURE_TOKENS.revoked, payload, meta);
    expect(!rev.ok && [rev.status, rev.code]).toEqual([410, 'QUOTE_REVOKED']);
    const revc = await src.confirmAcceptance(FIXTURE_TOKENS.revoked, { pending_id: null, code: FIXTURE_CODE }, meta);
    expect(!revc.ok && revc.status).toBe(410);
  });

  it('gates acceptance to named recipients and requires one choice per exclusive group', async () => {
    const stranger = await src.beginAcceptance(FIXTURE_TOKENS.current, { ...payload, email: 'someone@else.example' }, meta);
    expect(!stranger.ok && [stranger.status, stranger.code]).toEqual([403, 'NOT_A_RECIPIENT']);
    const noChoice = await src.beginAcceptance(FIXTURE_TOKENS.current, { ...payload, selected_line_ids: [] }, meta);
    expect(!noChoice.ok && noChoice.code).toBe('OPTION_REQUIRED');
    const unticked = await src.beginAcceptance(FIXTURE_TOKENS.current, { ...payload, accepted: false }, meta);
    expect(!unticked.ok && unticked.code).toBe('ACCEPT_CHECKBOX');
  });

  it('replays an Idempotency-Key instead of creating a second pending acceptance', async () => {
    const m = { ...meta, idempotency_key: 'k-1' };
    const a = await src.beginAcceptance(FIXTURE_TOKENS.current, payload, m);
    const b = await src.beginAcceptance(FIXTURE_TOKENS.current, payload, m);
    expect(a).toEqual(b);
    const rec = src.record(FIXTURE_TOKENS.current)!;
    expect(rec.events.filter((e) => e.kind === 'acceptance_pending').length).toBe(1);
  });
});

describe('FixtureQuoteSource — what step one may and may not do', () => {
  let src: FixtureQuoteSource;
  beforeEach(() => {
    src = new FixtureQuoteSource();
    src.setClock(() => new Date('2026-09-12T20:00:00Z'));
  });

  it('does NOT change the quote until the code is confirmed (H2)', async () => {
    const before = src.record(FIXTURE_TOKENS.current)!.lines.filter((l) => l.selected).map((l) => l.id);
    const begin = await src.beginAcceptance(FIXTURE_TOKENS.current, { ...payload, selected_line_ids: ['l-pkg-build'] }, meta);
    expect(begin.ok).toBe(true);
    // An unverified stranger picked a different package. The quote must not move.
    const during = src.record(FIXTURE_TOKENS.current)!.lines.filter((l) => l.selected).map((l) => l.id);
    expect(during).toEqual(before);
    const view = await src.lookup(FIXTURE_TOKENS.current, meta);
    expect(view.found && view.view.totals.year_one_cents).toBe(6_280_000);
    if (!begin.ok) throw new Error('begin failed');
    await src.confirmAcceptance(FIXTURE_TOKENS.current, { pending_id: begin.pending_id, code: FIXTURE_CODE }, meta);
    // Only now does the choice land.
    expect(src.record(FIXTURE_TOKENS.current)!.lines.filter((l) => l.selected).map((l) => l.id)).toEqual(['l-pkg-build']);
  });

  it('refuses a confirm without a pending id, and one pending id never confirms another (H3)', async () => {
    const first = await src.beginAcceptance(FIXTURE_TOKENS.current, payload, meta);
    const second = await src.beginAcceptance(FIXTURE_TOKENS.current, { ...payload, name: 'Someone Else' }, meta);
    if (!first.ok || !second.ok) throw new Error('begin failed');
    expect(first.pending_id).not.toBe(second.pending_id);

    const bare = await src.confirmAcceptance(FIXTURE_TOKENS.current, { pending_id: null, code: FIXTURE_CODE }, meta);
    expect(!bare.ok && [bare.status, bare.code]).toEqual([400, 'PENDING_ID_REQUIRED']);
    expect(src.record(FIXTURE_TOKENS.current)!.quote.status).not.toBe('accepted');

    const unknown = await src.confirmAcceptance(FIXTURE_TOKENS.current, { pending_id: 'pa-not-real', code: FIXTURE_CODE }, meta);
    expect(!unknown.ok && unknown.code).toBe('PENDING_NOT_FOUND');

    // The code belongs to the record it was minted for: confirming the FIRST id
    // must accept the first person's claim, not whichever was started last.
    const done = await src.confirmAcceptance(FIXTURE_TOKENS.current, { pending_id: first.pending_id, code: FIXTURE_CODE }, meta);
    expect(done.ok).toBe(true);
    expect(src.record(FIXTURE_TOKENS.current)!.quote.accepted_by?.name).toBe('Jordan Mercer');
  });

  it('still explains an expired or voided pending record instead of forgetting it', async () => {
    const begin = await src.beginAcceptance(FIXTURE_TOKENS.current, payload, meta);
    if (!begin.ok) throw new Error('begin failed');
    src.setClock(() => new Date('2026-09-12T20:12:00Z'));
    const late = await src.confirmAcceptance(FIXTURE_TOKENS.current, { pending_id: begin.pending_id, code: FIXTURE_CODE }, meta);
    expect(!late.ok && late.code).toBe('PENDING_EXPIRED');
    // Well past the grace window it is gone, and the map does not grow forever.
    src.setClock(() => new Date('2026-09-12T23:00:00Z'));
    const gone = await src.confirmAcceptance(FIXTURE_TOKENS.current, { pending_id: begin.pending_id, code: FIXTURE_CODE }, meta);
    expect(!gone.ok && gone.code).toBe('PENDING_NOT_FOUND');
  });
});

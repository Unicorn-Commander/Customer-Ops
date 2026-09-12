import { computeQuote, discountCentsOf, formatMoney, lineAmountCents, snapshotOf, canonicalJson, type QuoteLine, type OptionGroup } from './quote-model';
import { orderPadRecord } from './fixtures/orderpad.fixture';

const line = (over: Partial<QuoteLine>): QuoteLine => ({
  id: 'l', quote_id: 'q', section_id: 's', position: 1, kind: 'one_time', label: 'x', description_md: null, qty: 1, unit: null,
  unit_price_cents: 1000, amount_cents: 1000, status_tag: 'proposed', recurring: null, hourly: null, milestone: null,
  option_group: null, selected: false, price_book_item_id: null, features: null, ...over,
});

describe('computeQuote — the one compute path (A4/A5/A8/A16)', () => {
  it('derives amount from qty × unit − discount, bps or cents, never both', () => {
    expect(lineAmountCents(line({ qty: 3, unit_price_cents: 1000 }))).toBe(3000);
    expect(lineAmountCents(line({ qty: 2, unit_price_cents: 1000, discount_bps: 1250 }))).toBe(1750);
    expect(discountCentsOf(line({ discount_bps: 3333 }), 10000)).toBe(3333);
    expect(lineAmountCents(line({ unit_price_cents: 1000, discount_cents: 250 }))).toBe(750);
    expect(() => lineAmountCents(line({ discount_bps: 100, discount_cents: 5 }))).toThrow(/both/);
    // a discount can never exceed the gross
    expect(lineAmountCents(line({ unit_price_cents: 100, discount_cents: 900 }))).toBe(0);
  });

  it('reproduces the Order Pad figures with "Improve it" selected', () => {
    const r = orderPadRecord();
    const t = computeQuote({ currency: 'USD', lines: r.lines, option_groups: r.quote.option_groups });
    expect(t.one_time_cents).toBe(1_000_000);
    expect(t.milestone_cents).toBe(3_600_000);
    expect(t.recurring.month_cents).toBe(140_000);
    expect(t.recurring.monthly_equivalent_cents).toBe(140_000);
    expect(t.year_one_cents).toBe(6_280_000); // $62,800 — matches the floor's internal band
    expect(t.deposit_cents).toBe(2_300_000); // first halves: 5,000 + 4×(4,000|6,000)
    expect(t.hourly_primary?.rate_cents).toBe(15_000);
    expect(t.option_group_errors).toEqual([]);
    const excluded = t.lines.find((l) => l.id === 'l-cards');
    expect(excluded?.amount_cents).toBe(0);
    expect(excluded?.invoiceable).toBe(false);
    const included = t.lines.find((l) => l.id === 'l-website');
    expect(included?.invoiceable).toBe(false);
    const unselected = t.lines.find((l) => l.id === 'l-pkg-build');
    expect(unselected?.counted).toBe(false);
    expect(unselected?.invoiceable).toBe(false);
  });

  it('counts only the selected option of an exclusive group and flags a missing choice', () => {
    const groups: OptionGroup[] = [{ key: 'g', label: 'Care', mode: 'exclusive' }];
    const lines = [
      line({ id: 'a', kind: 'option', option_group: 'g', recurring: { interval: 'month' }, unit_price_cents: 60000, selected: false }),
      line({ id: 'b', kind: 'option', option_group: 'g', recurring: { interval: 'month' }, unit_price_cents: 140000, selected: false }),
    ];
    const none = computeQuote({ currency: 'USD', lines, option_groups: groups });
    expect(none.recurring.month_cents).toBe(0);
    expect(none.option_group_errors[0].message).toMatch(/exactly one/);
    const one = computeQuote({ currency: 'USD', lines: lines.map((l) => ({ ...l, selected: l.id === 'b' })), option_groups: groups });
    expect(one.recurring.month_cents).toBe(140000);
    expect(one.option_group_errors).toEqual([]);
  });

  it('additive groups allow zero or more and quarterly/annual recur ×4/×1 in year one', () => {
    const groups: OptionGroup[] = [{ key: 'add', label: 'Add-ons', mode: 'additive' }];
    const lines = [
      line({ id: 'q', kind: 'option', option_group: 'add', recurring: { interval: 'quarter' }, unit_price_cents: 30000, selected: true }),
      line({ id: 'y', kind: 'option', option_group: 'add', recurring: { interval: 'year' }, unit_price_cents: 120000, selected: true }),
      line({ id: 'n', kind: 'option', option_group: 'add', recurring: { interval: 'month' }, unit_price_cents: 999, selected: false }),
    ];
    const t = computeQuote({ currency: 'USD', lines, option_groups: groups });
    expect(t.option_group_errors).toEqual([]);
    expect(t.year_one_cents).toBe(30000 * 4 + 120000);
    expect(t.recurring.monthly_equivalent_cents).toBe(Math.round(30000 / 3 + 120000 / 12));
  });

  it('deposit follows each line payment_split, defaulting to [50,50]', () => {
    const lines = [
      line({ id: 'a', kind: 'milestone', unit_price_cents: 10000, milestone: { payment_split: [30, 70] } }),
      line({ id: 'b', kind: 'one_time', unit_price_cents: 10000 }),
    ];
    const t = computeQuote({ currency: 'USD', lines, option_groups: [] });
    expect(t.deposit_cents).toBe(3000 + 5000);
  });

  it('rejects two primary hourly lines', () => {
    const lines = [
      line({ id: 'h1', kind: 'hourly', hourly: { rate_cents: 100, primary: true } }),
      line({ id: 'h2', kind: 'hourly', hourly: { rate_cents: 200, primary: true } }),
    ];
    expect(computeQuote({ currency: 'USD', lines, option_groups: [] }).option_group_errors.some((e) => e.key === 'hourly')).toBe(true);
  });

  it('formats money as whole dollars unless cents are present', () => {
    expect(formatMoney(6_280_000, 'USD')).toBe('$62,800');
    expect(formatMoney(140_050, 'USD')).toBe('$1,400.50');
    expect(formatMoney(-25_000, 'USD')).toBe('−$250');
    expect(formatMoney(100, 'EUR')).toBe('€1');
  });

  it('snapshotOf carries totals and no internal basis notes', () => {
    const snap = snapshotOf(orderPadRecord());
    expect(snap.totals.year_one_cents).toBe(6_280_000);
    for (const s of snap.sections) expect('internal_basis_md' in s).toBe(false);
    expect(canonicalJson({ b: 1, a: [{ z: 1, y: 2 }] })).toBe('{"a":[{"y":2,"z":1}],"b":1}');
  });
});

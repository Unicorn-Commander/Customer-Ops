import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { computeQuote as canonicalCompute } from '../quotes-render/quote-model';
import { quoteComputeInput } from './compute-quote';
import { computeStoredQuote } from './compute-quote';
import { lineInput } from './quote.schemas';
const line = ({ id, ...data }: any) => ({
  ...lineInput.parse({ kind: 'one_time', label: 'Synthetic line', unitPriceCents: 1001, ...data }),
  id: id || String(nextId++),
});
let nextId = 1;
const compute = (lines: any[], forSend = false, currency = 'USD') =>
  computeStoredQuote({ currency, lines }, { forSend, validateEdit: true });
describe('computeQuote', () => {
  it('uses decimal quantities and integer discount rounding', () => {
    const r = compute([line({ qty: '1.5', discountBps: 1000 })]);
    expect(r.lines[0].amountCents).toBe(1352);
    expect(r.totals.deposit_cents).toBe(676);
  });
  it('rejects conflicting discounts, negative quantities and unsupported currency exponents', () => {
    expect(() => compute([line({ discountBps: 1, discountCents: 1 })])).toThrow(/both/);
    expect(() => compute([line({ qty: -1 })])).toThrow(/qty/);
    expect(() => line({ qty: 1.23456 })).toThrow(/qty/);
    expect(() => compute([], false, 'JPY')).toThrow(/2-decimal/);
    expect(() => compute([], false, 'ZZZ')).toThrow(/ISO/);
  });
  it('counts selected options only and validates exclusive/additive groups', () => {
    const a = line({ optionGroup: { id: 'package', mode: 'exclusive' }, selected: true });
    const b = line({ optionGroup: { id: 'package', mode: 'exclusive' }, selected: false });
    expect(compute([a, b], true).totals.one_time_cents).toBe(1001);
    expect(() => compute([a, { ...b, selected: true }])).toThrow(/exactly one/);
    expect(() => compute([{ ...a, selected: false }], true)).toThrow(/exactly one/);
    expect(
      compute([{ ...a, selected: false, optionGroup: { id: 'extras', mode: 'additive' } }], true)
        .totals.one_time_cents,
    ).toBe(0);
  });
  it('uses per-line splits and recurring intervals for year one', () => {
    const r = compute([
      line({ unitPriceCents: 1000, paymentSplit: [30, 70] }),
      line({ kind: 'milestone', unitPriceCents: 2000, paymentSplit: [25, 75] }),
      ...(['month', 'quarter', 'year'] as const).map((interval) =>
        line({ kind: 'recurring', unitPriceCents: 100, recurring: { interval } }),
      ),
    ]);
    expect(r.totals.deposit_cents).toBe(800);
    expect(r.totals.year_one_cents).toBe(4700);
  });
  it('never invoices excluded/included lines or changes money based on status tags', () => {
    expect(
      compute([line({ kind: 'included' }), line({ kind: 'excluded' })]).totals.year_one_cents,
    ).toBe(0);
    expect(compute([line({ id: 'status', statusTag: 'agreed' })]).totals).toEqual(
      compute([line({ id: 'status', statusTag: 'proposed' })]).totals,
    );
  });
  it('rejects multiple primary rates and invalid payment schedules', () => {
    const hourly = line({ kind: 'hourly', hourly: { rate_cents: 100, primary: true } });
    expect(() => compute([hourly, hourly])).toThrow(/one hourly/);
    expect(() => compute([line({ paymentSplit: [20, 20] })])).toThrow(/100/);
  });
});

describe('4180955 shared-money integration', () => {
  it('keeps the lifted canonical module byte-identical to the approved source', () => {
    const source = readFileSync(join(__dirname, '../quotes-render/quote-model.ts'));
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '39be1b52876b6c086ea443602364b03343c8ba0f7a8cdf9b594ef149232548c1',
    );
  });
  it('returns the canonical totals and exact remainder parts without re-rounding', () => {
    const snapshot = {
      currency: 'USD',
      lines: [line({ unitPriceCents: 333, paymentSplit: [50, 50] })],
    };
    const actual = computeStoredQuote(snapshot, { validateEdit: true });
    expect(actual.totals).toEqual(canonicalCompute(quoteComputeInput(snapshot)));
    expect(actual.totals.lines[0].payment_parts).toEqual([167, 166]);
    expect(actual.totals.lines[0].remainder_cents).toEqual([166]);
    expect(actual.totals.deposit_cents + actual.totals.remainder_total_cents).toBe(
      actual.totals.one_time_cents,
    );
  });
  it('surfaces shared legacy-data errors on reads and rejects them on writes', () => {
    const snapshot = { currency: 'USD', lines: [{ ...line({}), paymentSplit: [20, 20] }] };
    expect(computeStoredQuote(snapshot).totals.line_errors).toHaveLength(1);
    expect(() => computeStoredQuote(snapshot, { validateEdit: true })).toThrow(/100/);
    expect(() => line({ paymentSplit: [33.3, 66.7] })).toThrow();
  });
  it('uses the shared option money classification and accepts fractional hourly minimums', () => {
    const result = compute([
      line({
        kind: 'option',
        recurring: { interval: 'quarter' },
        optionGroup: { id: 'extra', mode: 'additive' },
        selected: true,
      }),
      line({ kind: 'hourly', hourly: { rate_cents: 100, minimum_hours: 0.5, primary: true } }),
    ]);
    expect(result.totals.recurring.quarter_cents).toBe(1001);
    expect(result.totals.one_time_cents).toBe(0);
    expect(result.totals.hourly_primary?.minimum_hours).toBe(0.5);
  });
  it('fails closed on a negative shared rounding remainder instead of inventing another allocation', () => {
    expect(() => compute([line({ unitPriceCents: 1, paymentSplit: [50, 50, 0] })])).toThrow(
      /negative remainder/,
    );
  });
});

import { QuoteSnapshot } from '../quotes-render/quote-model';
import { ProjectionState, toQuoteView } from '../quotes-render/quote-view';

/** Published money is evidence, not a request to rerun a future calculator. */
export function toPublishedQuoteView(snapshot: QuoteSnapshot, state: ProjectionState) {
  const view = toQuoteView(snapshot, state);
  const {
    line_errors: _lineErrors,
    option_group_errors: _optionErrors,
    ...totals
  } = snapshot.totals;
  view.totals = totals;
  const amounts = new Map(snapshot.totals.lines.map((line) => [line.id, line]));
  for (const section of view.sections)
    for (const line of section.lines) {
      const frozen = amounts.get(line.id);
      if (!frozen) throw new Error('Published quote is missing line totals');
      line.gross_cents = frozen.gross_cents;
      line.discount_cents = frozen.discount_cents;
      line.amount_cents = frozen.amount_cents;
      line.deposit_cents = frozen.deposit_cents;
      line.remainder_cents = frozen.remainder_cents;
    }
  return view;
}

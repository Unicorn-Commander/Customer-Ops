import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  assertSupportedCurrency,
  computeQuote,
  OptionGroup,
  QuoteLine,
} from '../quotes-render/quote-model';
import { lineInput } from './quote.schemas';

export { computeQuote } from '../quotes-render/quote-model';
export class QuoteComputationError extends Error {}
export function validateCurrency(currency: string) {
  try {
    assertSupportedCurrency(currency);
  } catch (error) {
    throw new QuoteComputationError((error as Error).message);
  }
}

type StoredLine = z.infer<typeof lineInput> & { id: string; quoteId?: string };

/** Persistence-to-shared-model adapter only. All arithmetic belongs to quote-model.ts. */
export function quoteComputeInput(snapshot: {
  currency: string;
  lines: StoredLine[];
  taxEstimateCents?: number | null;
}) {
  validateCurrency(snapshot.currency);
  const groups = new Map<string, OptionGroup>();
  const lines: QuoteLine[] = snapshot.lines.map((line) => {
    const qty = new Prisma.Decimal(line.qty);
    if (!qty.isFinite() || qty.lt(0) || qty.gt(1000000) || qty.decimalPlaces() > 4)
      throw new QuoteComputationError('qty must be nonnegative with at most four decimal places');
    if (line.optionGroup) {
      const prior = groups.get(line.optionGroup.id);
      if (prior && prior.mode !== line.optionGroup.mode)
        throw new QuoteComputationError('Option group modes must agree');
      groups.set(line.optionGroup.id, {
        key: line.optionGroup.id,
        label: line.optionGroup.id,
        mode: line.optionGroup.mode,
      });
    }
    // A plain option has one-time money. Keep that classification when adapting
    // the database's top-level paymentSplit to the shared milestone terms.
    const kind =
      line.kind === 'option' && !line.recurring && !line.hourly && !line.milestone
        ? 'one_time'
        : line.kind;
    const needsSplit = kind === 'one_time' || kind === 'milestone' || !!line.milestone;
    return {
      id: line.id,
      quote_id: line.quoteId || '',
      section_id: line.sectionId || '',
      position: line.position,
      kind,
      label: line.label,
      description_md: line.descriptionMd,
      qty: qty.toNumber(),
      unit: line.unit,
      unit_price_cents: line.unitPriceCents,
      amount_cents: 0, // ignored and re-derived by the shared calculator
      discount_bps: line.discountBps,
      discount_cents: line.discountCents,
      status_tag: line.statusTag,
      recurring: line.recurring ?? null,
      hourly: line.hourly ?? null,
      milestone: needsSplit
        ? {
            ...line.milestone,
            payment_split: line.paymentSplit ?? line.milestone?.payment_split,
          }
        : null,
      option_group: line.optionGroup?.id ?? null,
      selected: line.selected,
      price_book_item_id: line.priceBookItemId ?? null,
    };
  });
  return {
    currency: snapshot.currency,
    lines,
    option_groups: [...groups.values()],
    tax_estimate_cents: snapshot.taxEstimateCents,
  };
}

/** Reads surface shared data errors; writes refuse them before transaction commit. */
export function computeStoredQuote(
  snapshot: Parameters<typeof quoteComputeInput>[0],
  options: { validateEdit?: boolean; forSend?: boolean } = {},
) {
  const input = quoteComputeInput(snapshot);
  const totals = computeQuote(input);
  const checkSafe = (value: unknown, key = ''): void => {
    if (typeof value === 'number' && key !== 'minimum_hours' && !Number.isSafeInteger(value))
      throw new QuoteComputationError('Quote amount exceeds safe integer range');
    if (value && typeof value === 'object')
      Object.entries(value).forEach(([name, child]) => checkSafe(child, name));
  };
  checkSafe(totals);
  if (options.validateEdit || options.forSend) {
    if (totals.lines.some((line) => line.payment_parts.some((part) => part < 0)))
      throw new QuoteComputationError(
        'Payment split produces a negative remainder; revise the split',
      );
    if (totals.line_errors.length)
      throw new QuoteComputationError(totals.line_errors.map((e) => e.message).join('; '));
    for (const group of input.option_groups) {
      const selected = input.lines.filter((l) => l.option_group === group.key && l.selected).length;
      if (group.mode === 'exclusive' && selected > 1)
        throw new QuoteComputationError(
          'Exclusive option group requires exactly one selected line before send',
        );
    }
    if (options.forSend && totals.option_group_errors.length)
      throw new QuoteComputationError(totals.option_group_errors.map((e) => e.message).join('; '));
    for (const line of input.lines) {
      const computed = totals.lines.find((entry) => entry.id === line.id)!;
      if (line.discount_cents != null && line.discount_cents > computed.gross_cents)
        throw new QuoteComputationError('Discount exceeds line amount');
      if (line.discount_bps != null && line.discount_cents != null)
        throw new QuoteComputationError('Use discountBps or discountCents, not both');
      if (line.kind === 'recurring' && !line.recurring)
        throw new QuoteComputationError('Recurring line requires interval');
      if (line.kind === 'hourly' && !line.hourly)
        throw new QuoteComputationError('Hourly line requires rate metadata');
    }
  }
  const byId = new Map(totals.lines.map((line) => [line.id, line]));
  return {
    lines: snapshot.lines.map((line) => ({
      ...line,
      amountCents: byId.get(line.id)!.amount_cents,
      accepted: byId.get(line.id)!.counted,
    })),
    totals,
  };
}

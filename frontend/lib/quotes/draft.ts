/**
 * The composer's MOCK store.
 *
 * Lane L2 builds the look against a mock of contract §1 + Amendment 01 while
 * L1 builds the real data layer. This module is that mock: it holds one
 * `QuoteRecord` in React state, persists it per quote id in localStorage, and
 * exposes small pure mutations. Every money figure still comes from the shared
 * `computeQuote` — the mock never does arithmetic of its own, so when the store
 * is swapped for the API the numbers on screen cannot move.
 *
 * Replacing this with L1 means swapping `useQuoteDraft`'s load/save for the
 * REST calls; nothing in the composer components reaches around it.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { orderPadRecord, PRICE_BOOK } from './quotes-render/fixtures/orderpad.fixture';
import {
  computeQuote,
  withDerivedAmounts,
  type LineKind,
  type OptionGroup,
  type PriceBookItem,
  type QuoteCost,
  type QuoteLine,
  type QuoteRecipient,
  type QuoteRecord,
  type QuoteSection,
  type QuoteTotals,
} from './quotes-render/quote-model';

export { PRICE_BOOK };
export type { PriceBookItem };

const STORAGE_PREFIX = 'co-quote-draft:';

/** The fixture is the seed: Q-2026-0001, four sections, twelve lines. */
export function seedRecord(): QuoteRecord {
  return orderPadRecord();
}

function storageKey(quoteId: string): string {
  return `${STORAGE_PREFIX}${quoteId}`;
}

function readStored(quoteId: string): QuoteRecord | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(quoteId));
    return raw ? (JSON.parse(raw) as QuoteRecord) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure mutations — each returns a NEW record (the codebase has no reducer
// convention; this keeps the composer's useState immutable and diffable).
// ---------------------------------------------------------------------------

let idSeq = 0;
const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(idSeq += 1).toString(36)}`;

function reposition<T extends { position: number }>(items: T[]): T[] {
  return items.map((item, i) => ({ ...item, position: i + 1 }));
}

export function patchQuote(record: QuoteRecord, patch: Partial<QuoteRecord['quote']>): QuoteRecord {
  return { ...record, quote: { ...record.quote, ...patch } };
}

export function addSection(record: QuoteRecord, kind: QuoteSection['kind'] = 'scope'): QuoteRecord {
  const section: QuoteSection = {
    id: newId('s'),
    quote_id: record.quote.id,
    position: record.sections.length + 1,
    kind,
    heading: kind === 'terms' ? 'Terms' : 'New section',
    body_md: null,
    internal_basis_md: null,
  };
  return { ...record, sections: reposition([...record.sections, section]) };
}

export function patchSection(record: QuoteRecord, id: string, patch: Partial<QuoteSection>): QuoteRecord {
  return { ...record, sections: record.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

export function removeSection(record: QuoteRecord, id: string): QuoteRecord {
  return {
    ...record,
    sections: reposition(record.sections.filter((s) => s.id !== id)),
    lines: reposition(record.lines.filter((l) => l.section_id !== id)),
  };
}

export function moveSection(record: QuoteRecord, id: string, delta: -1 | 1): QuoteRecord {
  const ordered = [...record.sections].sort((a, b) => a.position - b.position);
  const i = ordered.findIndex((s) => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ordered.length) return record;
  [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  return { ...record, sections: reposition(ordered) };
}

export function blankLine(record: QuoteRecord, sectionId: string, kind: LineKind = 'one_time'): QuoteLine {
  return {
    id: newId('l'),
    quote_id: record.quote.id,
    section_id: sectionId,
    position: record.lines.filter((l) => l.section_id === sectionId).length + 1,
    kind,
    label: 'New line',
    description_md: null,
    qty: 1,
    unit: null,
    unit_price_cents: 0,
    amount_cents: 0,
    status_tag: 'proposed',
    recurring: kind === 'recurring' ? { interval: 'month' } : null,
    hourly: kind === 'hourly' ? { rate_cents: 0 } : null,
    milestone: kind === 'milestone' ? { payment_split: [50, 50] } : null,
    option_group: null,
    selected: false,
    price_book_item_id: null,
  };
}

/** A line built from a price-book item — the picker's whole job. */
export function lineFromPriceBook(record: QuoteRecord, sectionId: string, item: PriceBookItem): QuoteLine {
  const base = blankLine(record, sectionId, item.kind);
  return {
    ...base,
    kind: item.kind,
    label: item.label,
    description_md: item.description_md,
    unit: item.unit,
    unit_price_cents: item.default_price_cents,
    recurring: item.recurring ?? (item.kind === 'recurring' ? { interval: 'month' } : null),
    hourly: item.hourly ?? (item.kind === 'hourly' ? { rate_cents: item.default_price_cents } : null),
    milestone: item.kind === 'milestone' ? { payment_split: [50, 50] } : null,
    features: item.features ?? null,
    price_book_item_id: item.id,
  };
}

export function addLine(record: QuoteRecord, line: QuoteLine): QuoteRecord {
  return { ...record, lines: [...record.lines, line] };
}

export function patchLine(record: QuoteRecord, id: string, patch: Partial<QuoteLine>): QuoteRecord {
  return { ...record, lines: record.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) };
}

export function removeLine(record: QuoteRecord, id: string): QuoteRecord {
  return { ...record, lines: record.lines.filter((l) => l.id !== id) };
}

export function moveLine(record: QuoteRecord, id: string, delta: -1 | 1): QuoteRecord {
  const line = record.lines.find((l) => l.id === id);
  if (!line) return record;
  const siblings = record.lines.filter((l) => l.section_id === line.section_id).sort((a, b) => a.position - b.position);
  const i = siblings.findIndex((l) => l.id === id);
  const j = i + delta;
  if (j < 0 || j >= siblings.length) return record;
  [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
  const positions = new Map(reposition(siblings).map((l) => [l.id, l.position]));
  return { ...record, lines: record.lines.map((l) => (positions.has(l.id) ? { ...l, position: positions.get(l.id) as number } : l)) };
}

/** Select one line inside a group; exclusive groups clear their siblings (A8). */
export function selectOption(record: QuoteRecord, groupKey: string, lineId: string, on: boolean): QuoteRecord {
  const group = record.quote.option_groups.find((g) => g.key === groupKey);
  const exclusive = group?.mode !== 'additive';
  return {
    ...record,
    lines: record.lines.map((l) => {
      if (l.option_group !== groupKey) return l;
      if (l.id === lineId) return { ...l, selected: exclusive ? true : on };
      return exclusive ? { ...l, selected: false } : l;
    }),
  };
}

export function addOptionGroup(record: QuoteRecord): QuoteRecord {
  const key = newId('og');
  const group: OptionGroup = { key, label: 'New option group', mode: 'exclusive', intro_md: null };
  return patchQuote(record, { option_groups: [...record.quote.option_groups, group] });
}

export function patchOptionGroup(record: QuoteRecord, key: string, patch: Partial<OptionGroup>): QuoteRecord {
  return patchQuote(record, { option_groups: record.quote.option_groups.map((g) => (g.key === key ? { ...g, ...patch } : g)) });
}

export function removeOptionGroup(record: QuoteRecord, key: string): QuoteRecord {
  return {
    ...patchQuote(record, { option_groups: record.quote.option_groups.filter((g) => g.key !== key) }),
    lines: record.lines.map((l) => (l.option_group === key ? { ...l, option_group: null, selected: false } : l)),
  };
}

export function addCost(record: QuoteRecord): QuoteRecord {
  const cost: QuoteCost = { id: newId('c'), quote_id: record.quote.id, label: 'New direct cost', amount_cents: 0, kind: 'other', notes: null };
  return { ...record, costs: [...record.costs, cost] };
}

export function patchCost(record: QuoteRecord, id: string, patch: Partial<QuoteCost>): QuoteRecord {
  return { ...record, costs: record.costs.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

export function removeCost(record: QuoteRecord, id: string): QuoteRecord {
  return { ...record, costs: record.costs.filter((c) => c.id !== id) };
}

export function addRecipient(record: QuoteRecord): QuoteRecord {
  const r: QuoteRecipient = { id: newId('r'), quote_id: record.quote.id, name: '', email: '', role: 'to', added_by: 'member:you' };
  return { ...record, recipients: [...record.recipients, r] };
}

export function patchRecipient(record: QuoteRecord, id: string, patch: Partial<QuoteRecipient>): QuoteRecord {
  return { ...record, recipients: record.recipients.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
}

export function removeRecipient(record: QuoteRecord, id: string): QuoteRecord {
  return { ...record, recipients: record.recipients.filter((r) => r.id !== id) };
}

// ---------------------------------------------------------------------------
// Validation — what `send` would refuse (A8, A14, A17)
// ---------------------------------------------------------------------------

export interface DraftProblem {
  level: 'error' | 'warn';
  message: string;
}

export function draftProblems(record: QuoteRecord, totals: QuoteTotals): DraftProblem[] {
  // computeQuote is the authority on data errors (option groups, payment splits,
  // double discounts, the primary-hourly rule). The composer never re-derives
  // them — it just says what it was told, so the studio and the invoice
  // schedule can never disagree about what is wrong.
  const out: DraftProblem[] = [...totals.option_group_errors, ...totals.line_errors].map((e) => ({
    level: 'error' as const,
    message: e.message,
  }));
  if (!record.quote.title.trim()) out.push({ level: 'error', message: 'The quote needs a title.' });
  if (!record.sections.some((s) => s.kind === 'summary' && s.body_md?.trim())) {
    out.push({ level: 'warn', message: 'No summary section — the client view opens without a narrative lede.' });
  }
  if (!record.recipients.length) {
    out.push({ level: 'warn', message: 'No named recipients — any address will be allowed to accept (A1).' });
  }
  const validUntil = Date.parse(record.quote.valid_until);
  if (Number.isNaN(validUntil)) out.push({ level: 'error', message: 'Validity date is not a date.' });
  return out;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface QuoteDraft {
  record: QuoteRecord;
  totals: QuoteTotals;
  problems: DraftProblem[];
  dirty: boolean;
  /** Apply a pure mutation. */
  apply: (fn: (r: QuoteRecord) => QuoteRecord) => void;
  /** Throw the local draft away and reload the seed. */
  reset: () => void;
}

export function useQuoteDraft(quoteId: string): QuoteDraft {
  const [record, setRecord] = useState<QuoteRecord>(seedRecord);
  const [dirty, setDirty] = useState(false);
  const hydrated = useRef(false);

  // Hydrate from localStorage AFTER mount: the server render and the first
  // client render must agree, so the seed is what both start from.
  useEffect(() => {
    const stored = readStored(quoteId);
    if (stored) {
      setRecord(stored);
      setDirty(true);
    }
    hydrated.current = true;
  }, [quoteId]);

  useEffect(() => {
    if (!hydrated.current || !dirty) return;
    try {
      window.localStorage.setItem(storageKey(quoteId), JSON.stringify(record));
    } catch {
      /* a private window or a full quota — the draft simply does not persist */
    }
  }, [quoteId, record, dirty]);

  const apply = useCallback((fn: (r: QuoteRecord) => QuoteRecord) => {
    setRecord((prev) => fn(prev));
    setDirty(true);
  }, []);

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(storageKey(quoteId));
    } catch {
      /* nothing to clear */
    }
    setRecord(seedRecord());
    setDirty(false);
  }, [quoteId]);

  // One compute path: the composer's figures and the client document's figures
  // come from the same function over the same lines (A4).
  const totals = useMemo(
    () =>
      computeQuote({
        currency: record.quote.currency,
        lines: withDerivedAmounts(record.lines),
        option_groups: record.quote.option_groups,
        tax_estimate_cents: record.quote.tax_estimate_cents,
      }),
    [record],
  );

  const problems = useMemo(() => draftProblems(record, totals), [record, totals]);

  return { record, totals, problems, dirty, apply, reset };
}

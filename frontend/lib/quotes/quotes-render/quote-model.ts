/**
 * Quotes & Proposals — the SHARED model (contract v1 §1 + Amendment 01).
 *
 * MIRRORED FILE. The canonical copy lives at
 *   backend/src/quotes-render/quote-model.ts
 * and a byte-identical mirror at
 *   frontend/lib/quotes/quote-model.ts
 * `quotes-render/mirror.spec.ts` fails the build when the two drift. Keep this
 * file dependency-free (no Nest, no React, no Node built-ins) so both runtimes
 * and the browser can load it, and so L1 can lift `computeQuote` verbatim.
 *
 * Money is INTEGER CENTS. Currency per quote (2-decimal ISO 4217 only in v1).
 * `amount_cents` on a line is DERIVED (A4): qty × unit_price_cents − discount.
 * Nothing here is rendered; nothing here reads a database. Pure data + maths.
 */

// ---------------------------------------------------------------------------
// Enumerations (contract v1 §1, amended by A01 §A8, A11, A7)
// ---------------------------------------------------------------------------

/** Commercial status of the quote (A11). */
export type QuoteStatus = 'draft' | 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'voided';

/** Disposition of one immutable version (A11). */
export type VersionDisposition = 'current' | 'superseded' | 'accepted';

/** Federation rollup after acceptance (A7). */
export type FederationStatus = 'pending' | 'partial' | 'complete' | 'failed';
export type AdapterCursor = 'pending' | 'done' | 'failed' | 'skipped';

export type SectionKind = 'summary' | 'scope' | 'acceptance' | 'terms' | 'custom';

export type LineKind = 'one_time' | 'milestone' | 'recurring' | 'hourly' | 'option' | 'included' | 'excluded';

export type StatusTag = 'agreed' | 'proposed';

export type RecurringInterval = 'month' | 'quarter' | 'year';

/** exclusive = pick exactly one before send; additive = zero or more (A8/F13). */
export type OptionGroupMode = 'exclusive' | 'additive';

export type SplitKind = 'none' | 'percent_net' | 'fee';

export type CostKind = 'hosting' | 'ai_usage' | 'third_party' | 'other';

export type QuoteEventKind =
  | 'created'
  | 'updated'
  | 'sent'
  | 'send_approved'
  | 'viewed'
  | 'option_selected'
  | 'acceptance_pending'
  | 'acceptance_code_failed'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'superseded'
  | 'revoked'
  | 'voided'
  | 'project_created'
  | 'invoice_created'
  | 'partner_invoice_created'
  | 'federation_retried'
  | 'error';

// ---------------------------------------------------------------------------
// Records (what Customer-Ops stores — the shapes L1 persists)
// ---------------------------------------------------------------------------

export interface RecurringTerms {
  interval: RecurringInterval;
  term_months?: number | null;
  notice_days?: number | null;
  included_hours?: number | null;
  ai_allowance_cents?: number | null;
}

export interface HourlyTerms {
  rate_cents: number;
  minimum_hours?: number | null;
  cadence?: string | null;
  surcharge_multiplier?: number | null;
  /** Exactly one hourly line may be primary — it feeds Project-Ops defaultBillRate (A14). */
  primary?: boolean;
}

export interface MilestoneTerms {
  acceptance_criteria_md?: string | null;
  weeks?: number | null;
  /** Percent parts; default [50, 50] (A5). Applies to one_time and milestone money. */
  payment_split?: number[] | null;
}

/** A structured feature row for an option (package) line — drives the matrix. */
export interface OptionFeature {
  label: string;
  value: string;
}

export interface QuoteLine {
  id: string;
  quote_id: string;
  section_id: string;
  position: number;
  kind: LineKind;
  label: string;
  description_md: string | null;
  qty: number;
  unit: string | null;
  unit_price_cents: number;
  /** Derived — see computeQuote. Persisted for history but never edited by hand (A4). */
  amount_cents: number;
  /** A line carries either discount_bps OR discount_cents, never both (A4). */
  discount_bps?: number | null;
  discount_cents?: number | null;
  status_tag: StatusTag;
  recurring: RecurringTerms | null;
  hourly: HourlyTerms | null;
  milestone: MilestoneTerms | null;
  /** Key into Quote.option_groups; lines in one group are packages. */
  option_group: string | null;
  /** The client's (or drafter's) choice inside an option group. */
  selected: boolean;
  price_book_item_id: string | null;
  /** Feature rows for option lines (the package matrix is data-driven, A01 addendum). */
  features?: OptionFeature[] | null;
}

export interface QuoteSection {
  id: string;
  quote_id: string;
  position: number;
  kind: SectionKind;
  heading: string;
  body_md: string | null;
  /** Studio-only margin note. NEVER leaves the workspace. */
  internal_basis_md: string | null;
}

export interface OptionGroup {
  key: string;
  label: string;
  mode: OptionGroupMode;
  /** Shown above the matrix as prose (optional). */
  intro_md?: string | null;
}

export interface SplitRule {
  kind: SplitKind;
  percent?: number | null;
  hosting_to_partner?: boolean;
  notes?: string | null;
}

/** Direct costs (A3) — never in any snapshot, render, or Project-Ops payload. */
export interface QuoteCost {
  id: string;
  quote_id: string;
  label: string;
  amount_cents: number;
  kind: CostKind;
  notes: string | null;
}

export interface QuoteRecipient {
  id: string;
  quote_id: string;
  name: string;
  email: string;
  role: 'to' | 'cc';
  added_by: string | null;
}

export interface OrgRef {
  label: string;
  contact_ops_org_id?: string | null;
}

/** The letterhead block (A01 addendum) — from workspace settings via L1. */
export interface Letterhead {
  legal_name: string;
  address_lines: string[];
  tax_id_label?: string | null;
  tax_id?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
}

export interface AcceptedBy {
  name: string;
  email: string;
  title: string | null;
  ip?: string | null;
  ua?: string | null;
  /** Set when a member recorded an acceptance given on a call (F20). */
  recorded_by_member?: string | null;
  how?: string | null;
}

export interface FederationState {
  status: FederationStatus;
  cursors: {
    project_ops: AdapterCursor;
    accounting_ops: AdapterCursor;
    partner: AdapterCursor;
  };
  project_ops_project_id: string | null;
  accounting_ops_invoice_ids: string[];
  accounting_ops_schedule_ids: string[];
  partner_invoice_id: string | null;
  last_error: string | null;
}

export interface QuoteVersion {
  id: string;
  quote_id: string;
  version_no: number;
  disposition: VersionDisposition;
  created_at: string;
  /** sha256 of the canonical snapshot JSON (F19). HTML is regenerated, never stored. */
  render_hash: string | null;
  pdf_asset_ref: string | null;
}

export interface QuoteShareToken {
  id: string;
  quote_version_id: string;
  /** The raw token is shown ONLY in the mock; L1 stores sha256(token). */
  token: string;
  expires_at: string;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
}

export interface QuoteEvent {
  id: string;
  quote_id: string;
  at: string;
  /** `member:<uid>` | `client:<token-prefix>` | `agent:<name>` | `system` */
  actor: string;
  kind: QuoteEventKind;
  data: Record<string, unknown> | null;
  ip: string | null;
  ua: string | null;
}

export interface PriceBookItem {
  id: string;
  workspace_id: string;
  sku: string;
  label: string;
  kind: LineKind;
  unit: string | null;
  default_price_cents: number;
  description_md: string | null;
  active: boolean;
  recurring?: RecurringTerms | null;
  hourly?: HourlyTerms | null;
  features?: OptionFeature[] | null;
}

export interface Quote {
  id: string;
  workspace_id: string;
  customer_id: string;
  number: string;
  title: string;
  status: QuoteStatus;
  currency: string;
  valid_until: string;
  brand_slug: string | null;
  vendor_of_record: OrgRef;
  delivery_partner: OrgRef | null;
  /** Internal — never leaves the workspace. */
  split_rule: SplitRule;
  terms_md: string | null;
  /** Internal — never rendered in the client view. */
  internal_notes_md: string | null;
  /** Estimate only; the invoice applies real tax (A9). */
  tax_estimate_cents: number | null;
  option_groups: OptionGroup[];
  /** The customer as it should read on the document (federated from Contact-Ops by L1). */
  customer: { display_name: string; org_name: string | null; attention: string | null };
  letterhead: Letterhead;
  created_by: string;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  accepted_at: string | null;
  accepted_by: AcceptedBy | null;
  decline_reason: string | null;
  current_version_no: number;
  locked_for_send: boolean;
  federated: FederationState;
  parent_quote_id: string | null;
}

/** The full studio record: everything Customer-Ops holds about one quote. */
export interface QuoteRecord {
  quote: Quote;
  sections: QuoteSection[];
  lines: QuoteLine[];
  costs: QuoteCost[];
  recipients: QuoteRecipient[];
  versions: QuoteVersion[];
  share_tokens: QuoteShareToken[];
  events: QuoteEvent[];
}

/**
 * The snapshot a version freezes (A4/F19): sections + lines + terms + option
 * groups + the computed totals. NO internal notes, NO basis notes, NO split,
 * NO costs, NO recipients. Structural — the type cannot carry them.
 */
export interface QuoteSnapshot {
  number: string;
  title: string;
  currency: string;
  valid_until: string;
  brand_slug: string | null;
  vendor_of_record: OrgRef;
  delivery_partner: OrgRef | null;
  terms_md: string | null;
  tax_estimate_cents: number | null;
  option_groups: OptionGroup[];
  customer: Quote['customer'];
  letterhead: Letterhead;
  sections: Array<Omit<QuoteSection, 'internal_basis_md'>>;
  lines: QuoteLine[];
  totals: QuoteTotals;
}

// ---------------------------------------------------------------------------
// computeQuote — the ONE compute path for money (A4, A5, A8, A16)
// ---------------------------------------------------------------------------

export interface LineComputation {
  id: string;
  /** Normalised money kind (option lines resolve to their terms). */
  money_kind: 'one_time' | 'milestone' | 'recurring' | 'hourly' | 'included' | 'excluded';
  gross_cents: number;
  discount_cents: number;
  amount_cents: number;
  /** Counted toward totals: true for every non-option line and the selected option lines. */
  counted: boolean;
  /** Reaches Accounting-Ops on accept (A16: included/excluded never invoice). */
  invoiceable: boolean;
  deposit_cents: number;
  interval: RecurringInterval | null;
}

export interface QuoteTotals {
  currency: string;
  one_time_cents: number;
  milestone_cents: number;
  recurring: {
    month_cents: number;
    quarter_cents: number;
    year_cents: number;
    /** month + quarter/3 + year/12, rounded — the "per month" figure on the ledger strip. */
    monthly_equivalent_cents: number;
  };
  hourly_primary: { line_id: string; label: string; rate_cents: number; minimum_hours: number | null } | null;
  discount_total_cents: number;
  deposit_cents: number;
  /** one_time + milestones + month×12 + quarter×4 + year×1 (A8). */
  year_one_cents: number;
  tax_estimate_cents: number | null;
  lines: LineComputation[];
  /** Option groups that violate their mode (exclusive needs exactly one selected). */
  option_group_errors: Array<{ key: string; message: string }>;
}

/** Input to computeQuote: the minimum a snapshot or a live record carries. */
export interface ComputeInput {
  currency: string;
  lines: QuoteLine[];
  option_groups: OptionGroup[];
  tax_estimate_cents?: number | null;
}

/** Round half away from zero for positive cents — deterministic across runtimes. */
export function roundCents(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

/** Resolve a line's money kind: `option` lines take the kind their terms imply. */
export function moneyKindOf(line: QuoteLine): LineComputation['money_kind'] {
  if (line.kind === 'included' || line.kind === 'excluded') return line.kind;
  if (line.kind === 'option') {
    if (line.recurring) return 'recurring';
    if (line.milestone) return 'milestone';
    if (line.hourly) return 'hourly';
    return 'one_time';
  }
  return line.kind;
}

/** Discount for one line (A4): bps → round(gross × bps / 10000); cents as given; never both. */
export function discountCentsOf(line: QuoteLine, grossCents: number): number {
  const bps = line.discount_bps ?? null;
  const cents = line.discount_cents ?? null;
  if (bps !== null && cents !== null && bps !== 0 && cents !== 0) {
    throw new Error(`Line ${line.id}: carries both discount_bps and discount_cents`);
  }
  if (bps !== null && bps !== 0) return Math.min(grossCents, roundCents((grossCents * bps) / 10000));
  if (cents !== null && cents !== 0) return Math.min(grossCents, roundCents(cents));
  return 0;
}

/** The derived amount of one line (A4). Excluded lines total 0 (A16). */
export function lineAmountCents(line: QuoteLine): number {
  if (line.kind === 'excluded') return 0;
  const gross = roundCents(line.qty * line.unit_price_cents);
  return gross - discountCentsOf(line, gross);
}

/** Is the line counted in totals given the option-group selections? */
export function isCounted(line: QuoteLine): boolean {
  return line.option_group ? line.selected : true;
}

function depositShare(line: QuoteLine, amount: number): number {
  const split = line.milestone?.payment_split ?? [50, 50];
  const first = split[0] ?? 100;
  return roundCents((amount * first) / 100);
}

/**
 * computeQuote — every money figure the public page, the PDF, the composer and
 * the federation payloads use. Pure. Counts only the selected line of each
 * exclusive option group (and every selected line of an additive group).
 */
export function computeQuote(input: ComputeInput): QuoteTotals {
  const groups = new Map(input.option_groups.map((g) => [g.key, g]));
  const lines: LineComputation[] = [];
  let one_time = 0;
  let milestone = 0;
  let month = 0;
  let quarter = 0;
  let year = 0;
  let discount_total = 0;
  let deposit = 0;
  let hourly_primary: QuoteTotals['hourly_primary'] = null;

  const ordered = [...input.lines].sort((a, b) => a.position - b.position);
  for (const line of ordered) {
    const money_kind = moneyKindOf(line);
    const gross = line.kind === 'excluded' ? 0 : roundCents(line.qty * line.unit_price_cents);
    const discount_cents = line.kind === 'excluded' ? 0 : discountCentsOf(line, gross);
    const amount_cents = gross - discount_cents;
    const counted = isCounted(line);
    const invoiceable = counted && money_kind !== 'included' && money_kind !== 'excluded' && amount_cents !== 0;
    const interval = money_kind === 'recurring' ? line.recurring?.interval ?? 'month' : null;
    let line_deposit = 0;

    if (counted) {
      discount_total += discount_cents;
      switch (money_kind) {
        case 'one_time':
          one_time += amount_cents;
          line_deposit = depositShare(line, amount_cents);
          break;
        case 'milestone':
          milestone += amount_cents;
          line_deposit = depositShare(line, amount_cents);
          break;
        case 'recurring':
          if (interval === 'month') month += amount_cents;
          else if (interval === 'quarter') quarter += amount_cents;
          else year += amount_cents;
          break;
        case 'hourly':
          if (line.hourly?.primary) {
            hourly_primary = {
              line_id: line.id,
              label: line.label,
              rate_cents: line.hourly.rate_cents,
              minimum_hours: line.hourly.minimum_hours ?? null,
            };
          }
          break;
        default:
          break;
      }
      deposit += line_deposit;
    }

    lines.push({
      id: line.id,
      money_kind,
      gross_cents: gross,
      discount_cents,
      amount_cents,
      counted,
      invoiceable,
      deposit_cents: line_deposit,
      interval,
    });
  }

  // Option-group validation (A8): exclusive → exactly one selected; additive → any.
  const option_group_errors: QuoteTotals['option_group_errors'] = [];
  for (const [key, group] of groups) {
    const members = ordered.filter((l) => l.option_group === key);
    const selected = members.filter((l) => l.selected).length;
    if (group.mode === 'exclusive' && selected !== 1) {
      option_group_errors.push({
        key,
        message: `Option group "${group.label}" needs exactly one selected line (has ${selected}).`,
      });
    }
  }
  // Lines that point at an undeclared group are a data error worth surfacing.
  for (const line of ordered) {
    if (line.option_group && !groups.has(line.option_group)) {
      option_group_errors.push({ key: line.option_group, message: `Line "${line.label}" references an undeclared option group "${line.option_group}".` });
    }
  }
  // A quote may declare only one primary hourly line (A14).
  const primaries = ordered.filter((l) => l.hourly?.primary && moneyKindOf(l) === 'hourly');
  if (primaries.length > 1) {
    option_group_errors.push({ key: 'hourly', message: `Only one hourly line may be primary (has ${primaries.length}).` });
  }

  const monthly_equivalent = roundCents(month + quarter / 3 + year / 12);
  return {
    currency: input.currency,
    one_time_cents: one_time,
    milestone_cents: milestone,
    recurring: { month_cents: month, quarter_cents: quarter, year_cents: year, monthly_equivalent_cents: monthly_equivalent },
    hourly_primary,
    discount_total_cents: discount_total,
    deposit_cents: deposit,
    year_one_cents: one_time + milestone + month * 12 + quarter * 4 + year,
    tax_estimate_cents: input.tax_estimate_cents ?? null,
    lines,
    option_group_errors,
  };
}

/** Re-derive amount_cents on every line (what L1 does before persisting). */
export function withDerivedAmounts(lines: QuoteLine[]): QuoteLine[] {
  return lines.map((l) => ({ ...l, amount_cents: lineAmountCents(l) }));
}

// ---------------------------------------------------------------------------
// Money formatting (2-decimal currencies only in v1 — A17)
// ---------------------------------------------------------------------------

const TWO_DECIMAL = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SGD', 'HKD', 'MXN', 'BRL', 'ZAR', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'INR', 'AED']);

export function assertSupportedCurrency(code: string): void {
  if (!TWO_DECIMAL.has(code.toUpperCase())) {
    throw new Error(`Unsupported currency "${code}": v1 supports 2-decimal ISO 4217 currencies only.`);
  }
}

const SYMBOL: Record<string, string> = { USD: '$', CAD: 'CA$', AUD: 'A$', NZD: 'NZ$', EUR: '€', GBP: '£', CHF: 'CHF ', INR: '₹', MXN: 'MX$', BRL: 'R$', ZAR: 'R', SGD: 'S$', HKD: 'HK$' };

/** "$1,400" / "$1,400.50" / "−$250". Whole amounts drop the cents on purpose. */
export function formatMoney(cents: number, currency: string, opts: { alwaysCents?: boolean } = {}): string {
  const code = currency.toUpperCase();
  const sym = SYMBOL[code] ?? `${code} `;
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = frac === 0 && !opts.alwaysCents ? grouped : `${grouped}.${frac.toString().padStart(2, '0')}`;
  return `${neg ? '−' : ''}${sym}${body}`;
}

/** Per-interval suffix for a recurring figure. */
export function intervalSuffix(interval: RecurringInterval): string {
  return interval === 'month' ? '/mo' : interval === 'quarter' ? '/qtr' : '/yr';
}

// ---------------------------------------------------------------------------
// Snapshot — what a version freezes (structurally free of internals)
// ---------------------------------------------------------------------------

export function snapshotOf(record: Pick<QuoteRecord, 'quote' | 'sections' | 'lines'>): QuoteSnapshot {
  const { quote } = record;
  const lines = withDerivedAmounts(record.lines);
  return {
    number: quote.number,
    title: quote.title,
    currency: quote.currency,
    valid_until: quote.valid_until,
    brand_slug: quote.brand_slug,
    vendor_of_record: quote.vendor_of_record,
    delivery_partner: quote.delivery_partner,
    terms_md: quote.terms_md,
    tax_estimate_cents: quote.tax_estimate_cents,
    option_groups: quote.option_groups,
    customer: quote.customer,
    letterhead: quote.letterhead,
    sections: [...record.sections]
      .sort((a, b) => a.position - b.position)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(({ internal_basis_md: _omit, ...s }) => s),
    lines,
    totals: computeQuote({ currency: quote.currency, lines, option_groups: quote.option_groups, tax_estimate_cents: quote.tax_estimate_cents }),
  };
}

/** Stable JSON for hashing a snapshot (keys sorted, no whitespace). */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = sort((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

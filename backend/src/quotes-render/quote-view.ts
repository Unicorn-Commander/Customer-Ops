/**
 * QuoteView — the typed model the renderer consumes, and the ONE projection
 * that builds it. A QuoteView is client-safe by construction: the type has no
 * field for internal notes, basis notes, the split, direct costs or recipient
 * addresses, so the public page and the PDF cannot leak them (contract §2.6,
 * §5; A3). Studio-only material travels separately as a `StudioOverlay` that
 * only the member preview passes.
 */

import {
  computeQuote,
  withDerivedAmounts,
  type AcceptedBy,
  type FederationState,
  type Letterhead,
  type OptionGroup,
  type OrgRef,
  type QuoteCost,
  type QuoteEvent,
  type QuoteLine,
  type QuoteRecipient,
  type QuoteRecord,
  type QuoteSnapshot,
  type QuoteStatus,
  type QuoteTotals,
  type SplitRule,
  type VersionDisposition,
} from './quote-model';

export type AcceptanceState = 'draft' | 'open' | 'accepted' | 'declined' | 'superseded' | 'expired' | 'revoked' | 'voided';

/**
 * The totals a CLIENT may see. `option_group_errors` and `line_errors` are
 * pricing hygiene for the studio — "this split does not sum to 100", "two
 * primary hourly lines" — and they name the drafter's mistakes, not the
 * client's business. They are removed structurally, not filtered in a template:
 * the type has no field for them, so no render and no public JSON can carry
 * them. `toStudioOverlay` is where a member gets them back.
 */
export type PublicTotals = Omit<QuoteTotals, 'option_group_errors' | 'line_errors'>;

export interface AcceptanceView {
  state: AcceptanceState;
  /** True only for an open, current, unexpired, unrevoked version. */
  can_accept: boolean;
  accepted_at: string | null;
  /** Client-safe: name + title only (email, ip and ua stay in the workspace). */
  accepted_by: { name: string; title: string | null; recorded_by_member: string | null } | null;
  /** When named recipients exist, only their addresses may accept (no addresses exposed). */
  recipients_gate: boolean;
  state_at: string | null;
  state_note: string | null;
}

export interface QuoteViewLine {
  id: string;
  kind: QuoteLine['kind'];
  money_kind: 'one_time' | 'milestone' | 'recurring' | 'hourly' | 'included' | 'excluded';
  label: string;
  description_md: string | null;
  qty: number;
  unit: string | null;
  unit_price_cents: number;
  gross_cents: number;
  discount_cents: number;
  amount_cents: number;
  /** computeQuote's exact first payment part for this line (A5). */
  deposit_cents: number;
  /** The later payment parts, exact to the cent; they sum with the deposit to amount_cents. */
  remainder_cents: number[];
  status_tag: QuoteLine['status_tag'];
  recurring: QuoteLine['recurring'];
  hourly: QuoteLine['hourly'];
  milestone: { weeks: number | null; payment_split: number[] | null; acceptance_criteria_md: string | null } | null;
  option_group: string | null;
  selected: boolean;
  features: QuoteLine['features'];
}

export interface QuoteViewSection {
  id: string;
  kind: 'scope' | 'acceptance' | 'terms' | 'custom';
  no: number;
  heading: string;
  body_md: string | null;
  lines: QuoteViewLine[];
}

export interface QuoteView {
  number: string;
  title: string;
  status: QuoteStatus;
  currency: string;
  issued_on: string;
  valid_until: string;
  version: { no: number; disposition: VersionDisposition };
  brand_slug: string | null;
  vendor: Letterhead & { label: string };
  delivery_partner: OrgRef | null;
  /** Gates the "with <partner>" phrase on the client's document. */
  show_delivery_partner: boolean;
  customer: { display_name: string; org_name: string | null; attention: string | null };
  /** The summary section, rendered as prose in the masthead. */
  lede_md: string | null;
  sections: QuoteViewSection[];
  option_groups: OptionGroup[];
  totals: PublicTotals;
  tax_estimate_cents: number | null;
  terms_md: string | null;
  acceptance: AcceptanceView;
}

/** Studio-only material — rendered ONLY by the member preview. Never public. */
export interface StudioOverlay {
  basis_by_section: Record<string, string>;
  /** Pricing hygiene stripped from the client view: split/discount/hourly rules. */
  pricing_errors: Array<{ key: string; message: string }>;
  /** The partner, even when the client's paper does not name them. */
  delivery_partner: OrgRef | null;
  internal_notes_md: string | null;
  split_rule: SplitRule;
  costs: QuoteCost[];
  recipients: QuoteRecipient[];
  federated: FederationState | null;
  events: QuoteEvent[];
}

export interface ProjectionState {
  state: AcceptanceState;
  state_at?: string | null;
  state_note?: string | null;
  accepted_by?: AcceptedBy | null;
  recipients_gate?: boolean;
  issued_on?: string | null;
  version?: { no: number; disposition: VersionDisposition } | null;
  /** Override the live selection (e.g. the accepted version's choices). */
  selected_line_ids?: string[] | null;
  now?: string;
}

const NON_LEDE_KINDS = new Set(['scope', 'acceptance', 'terms', 'custom']);

/** Build the client-safe view from a live record (studio) or a frozen snapshot (public). */
export function toQuoteView(source: QuoteRecord | QuoteSnapshot, state: ProjectionState): QuoteView {
  const isRecord = 'quote' in source;
  const q = isRecord ? source.quote : source;
  let lines = withDerivedAmounts(source.lines);
  if (state.selected_line_ids) {
    const chosen = new Set(state.selected_line_ids);
    lines = lines.map((l) => (l.option_group ? { ...l, selected: chosen.has(l.id) } : l));
  }
  const computed = computeQuote({ currency: q.currency, lines, option_groups: q.option_groups, tax_estimate_cents: q.tax_estimate_cents });
  // Drop the studio's pricing hygiene on the way out (see PublicTotals).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { option_group_errors: _og, line_errors: _le, ...totals } = computed;
  const comp = new Map(computed.lines.map((c) => [c.id, c]));
  const sections = [...source.sections].sort((a, b) => a.position - b.position);
  const lede = sections.find((s) => s.kind === 'summary');
  let no = 0;
  const viewSections: QuoteViewSection[] = sections
    .filter((s) => NON_LEDE_KINDS.has(s.kind))
    .map((s) => {
      no += 1;
      return {
        id: s.id,
        kind: s.kind as QuoteViewSection['kind'],
        no,
        heading: s.heading,
        body_md: s.body_md,
        lines: lines
          .filter((l) => l.section_id === s.id)
          .sort((a, b) => a.position - b.position)
          .map((l) => {
            const c = comp.get(l.id);
            return {
              id: l.id,
              kind: l.kind,
              money_kind: c?.money_kind ?? 'one_time',
              label: l.label,
              description_md: l.description_md,
              qty: l.qty,
              unit: l.unit,
              unit_price_cents: l.unit_price_cents,
              gross_cents: c?.gross_cents ?? 0,
              discount_cents: c?.discount_cents ?? 0,
              amount_cents: c?.amount_cents ?? l.amount_cents,
              deposit_cents: c?.deposit_cents ?? 0,
              remainder_cents: c?.remainder_cents ?? [],
              status_tag: l.status_tag,
              recurring: l.recurring,
              hourly: l.hourly,
              milestone: l.milestone
                ? { weeks: l.milestone.weeks ?? null, payment_split: l.milestone.payment_split ?? null, acceptance_criteria_md: l.milestone.acceptance_criteria_md ?? null }
                : null,
              option_group: l.option_group,
              selected: l.selected,
              features: l.features ?? null,
            };
          }),
      };
    });

  const acceptedBy = state.accepted_by
    ? { name: state.accepted_by.name, title: state.accepted_by.title ?? null, recorded_by_member: state.accepted_by.recorded_by_member ?? null }
    : null;
  const issued = state.issued_on ?? (isRecord ? source.quote.sent_at ?? source.quote.created_at : null) ?? state.now ?? new Date().toISOString();
  const version = state.version ?? (isRecord ? { no: source.quote.current_version_no, disposition: 'current' as const } : { no: 0, disposition: 'current' as const });
  const status: QuoteStatus = isRecord ? source.quote.status : state.state === 'accepted' ? 'accepted' : 'sent';

  return {
    number: q.number,
    title: q.title,
    status,
    currency: q.currency,
    issued_on: issued.slice(0, 10),
    valid_until: q.valid_until.slice(0, 10),
    version,
    brand_slug: q.brand_slug,
    vendor: { ...q.letterhead, label: q.vendor_of_record.label },
    // Not naming the partner means not SHIPPING the partner: their legal name
    // must not sit in the public JSON for anyone who opens devtools, only to be
    // hidden by a template condition. The split and the partner bill are
    // unaffected — neither ever leaves the workspace.
    delivery_partner: q.show_delivery_partner !== false ? q.delivery_partner : null,
    show_delivery_partner: q.show_delivery_partner !== false,
    customer: q.customer,
    lede_md: lede?.body_md ?? null,
    sections: viewSections,
    option_groups: q.option_groups,
    totals,
    tax_estimate_cents: q.tax_estimate_cents,
    terms_md: q.terms_md,
    acceptance: {
      state: state.state,
      can_accept: state.state === 'open',
      accepted_at: state.state === 'accepted' ? state.state_at ?? null : null,
      accepted_by: state.state === 'accepted' ? acceptedBy : null,
      recipients_gate: state.recipients_gate ?? (isRecord ? source.recipients.length > 0 : false),
      state_at: state.state_at ?? null,
      state_note: state.state_note ?? null,
    },
  };
}

/** The studio overlay from a live record — only the member preview calls this. */
export function toStudioOverlay(record: QuoteRecord): StudioOverlay {
  const basis: Record<string, string> = {};
  for (const s of record.sections) if (s.internal_basis_md?.trim()) basis[s.id] = s.internal_basis_md;
  const totals = computeQuote({
    currency: record.quote.currency,
    lines: withDerivedAmounts(record.lines),
    option_groups: record.quote.option_groups,
    tax_estimate_cents: record.quote.tax_estimate_cents,
  });
  return {
    basis_by_section: basis,
    pricing_errors: [...totals.option_group_errors, ...totals.line_errors],
    delivery_partner: record.quote.delivery_partner,
    internal_notes_md: record.quote.internal_notes_md,
    split_rule: record.quote.split_rule,
    costs: record.costs,
    recipients: record.recipients,
    federated: record.quote.federated,
    events: record.events,
  };
}

/** Every string an internal field holds — the leak tests grep the render for these. */
export function internalStrings(record: QuoteRecord): string[] {
  const out: string[] = [];
  for (const s of record.sections) if (s.internal_basis_md) out.push(s.internal_basis_md);
  if (record.quote.internal_notes_md) out.push(record.quote.internal_notes_md);
  if (record.quote.split_rule.notes) out.push(record.quote.split_rule.notes);
  for (const c of record.costs) out.push(c.label, ...(c.notes ? [c.notes] : []));
  for (const r of record.recipients) out.push(r.email);
  return out.filter((s) => s.trim().length > 0);
}

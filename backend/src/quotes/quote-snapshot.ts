import { Prisma } from '@prisma/client';
import { WorkspaceTxClient } from '../prisma/prisma.service';
import { QuoteSnapshot, canonicalJson } from '../quotes-render/quote-model';
import { computeStoredQuote, quoteComputeInput } from './compute-quote';
import { sha256 } from './quote-secrets';

/** No internal notes, basis, split, costs, or recipients are fetched at all. */
export const quoteSnapshotSelect = Prisma.validator<Prisma.QuoteSelect>()({
  id: true,
  number: true,
  title: true,
  currency: true,
  validUntil: true,
  brandSlug: true,
  vendorOfRecord: true,
  deliveryPartner: true,
  showDeliveryPartner: true,
  termsMd: true,
  taxEstimateCents: true,
  sections: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      quoteId: true,
      position: true,
      kind: true,
      heading: true,
      bodyMd: true,
    },
  },
  lines: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      quoteId: true,
      sectionId: true,
      position: true,
      kind: true,
      label: true,
      descriptionMd: true,
      qty: true,
      unit: true,
      unitPriceCents: true,
      discountBps: true,
      discountCents: true,
      statusTag: true,
      recurring: true,
      hourly: true,
      milestone: true,
      paymentSplit: true,
      optionGroup: true,
      selected: true,
      priceBookItemId: true,
    },
  },
});
export type QuotePresentation = Pick<QuoteSnapshot, 'customer' | 'letterhead'>;

/** Called inside the approval transaction, after locking the parent quote. */
export async function prepareQuoteSnapshot(
  tx: WorkspaceTxClient,
  workspaceId: string,
  quoteId: string,
  presentation: QuotePresentation,
  forSend = true,
) {
  const row = await tx.quote.findUnique({
    where: { workspaceId_id: { workspaceId, id: quoteId } },
    select: quoteSnapshotSelect,
  });
  if (!row) throw new Error('Quote not found');
  const data = {
    currency: row.currency,
    taxEstimateCents: row.taxEstimateCents,
    lines: row.lines.map((line) => ({ ...line, qty: line.qty.toString() })) as Parameters<
      typeof quoteComputeInput
    >[0]['lines'],
  };
  const input = quoteComputeInput(data);
  const { totals } = computeStoredQuote(data, { forSend });
  const sections: QuoteSnapshot['sections'] = row.sections.map((s) => ({
    id: s.id,
    quote_id: s.quoteId,
    position: s.position,
    kind: s.kind as QuoteSnapshot['sections'][number]['kind'],
    heading: s.heading,
    body_md: s.bodyMd,
  }));
  const looseSection = 'unsectioned-' + quoteId;
  if (input.lines.some((line) => !line.section_id))
    sections.push({
      id: looseSection,
      quote_id: quoteId,
      position: sections.length,
      kind: 'scope',
      heading: 'Scope',
      body_md: null,
    });
  const byId = new Map(totals.lines.map((line) => [line.id, line]));
  const snapshot: QuoteSnapshot = {
    number: row.number,
    title: row.title,
    currency: row.currency,
    valid_until: row.validUntil.toISOString(),
    brand_slug: row.brandSlug,
    vendor_of_record: { label: row.vendorOfRecord },
    delivery_partner: row.deliveryPartner ? { label: row.deliveryPartner } : null,
    show_delivery_partner: row.showDeliveryPartner,
    terms_md: row.termsMd,
    tax_estimate_cents: row.taxEstimateCents,
    option_groups: input.option_groups,
    // Copy fields explicitly: callers cannot smuggle studio fields into the snapshot.
    customer: {
      display_name: presentation.customer.display_name,
      org_name: presentation.customer.org_name,
      attention: presentation.customer.attention,
    },
    // A34: legal entity details are federated at render time, never snapshotted.
    letterhead: { legal_name: '', address_lines: [] },
    sections,
    lines: input.lines.map((line) => ({
      ...line,
      section_id: line.section_id || looseSection,
      amount_cents: byId.get(line.id)!.amount_cents,
    })),
    totals,
  };
  return { snapshot, renderHash: sha256(canonicalJson(snapshot)) };
}

/**
 * FIXTURE — the Order Pad proposal (2026-09-12) as Q-2026-0001 on the apparel
 * client's relationship. Codename rule: the client is "the apparel client";
 * every person here is synthetic. Letterhead values are placeholders until L1
 * feeds them from workspace settings.
 *
 * MIRRORED FILE — canonical at backend/src/quotes-render/fixtures/orderpad.fixture.ts,
 * mirrored at frontend/lib/quotes/fixtures/orderpad.fixture.ts (see mirror.spec.ts).
 *
 * Twelve lines: 1 one_time (agreed) · 1 included · 1 excluded · 4 milestones
 * (proposed) · a 3-package exclusive option group + its "no package" hosting
 * alternative (4 option lines) · 1 hourly (primary). Two versions: v1 superseded,
 * v2 current. Internal basis notes, direct costs, the split and recipients are
 * filled in so the "never leaks" tests have something to catch.
 */

import {
  computeQuote,
  withDerivedAmounts,
  type PriceBookItem,
  type QuoteLine,
  type QuoteRecord,
  type QuoteSection,
} from '../quote-model';

export const FIXTURE_WORKSPACE_ID = 'ws-magic-unicorn';
export const FIXTURE_CUSTOMER_ID = '2467436b-0000-4000-8000-000000000001';
export const FIXTURE_QUOTE_ID = 'q-orderpad-0001';
/** Share tokens (raw). L1 stores sha256; the mock keeps them readable on purpose. */
export const FIXTURE_TOKEN_CURRENT = 'fx-orderpad';
export const FIXTURE_TOKEN_SUPERSEDED = 'fx-orderpad-v1';

const Q = FIXTURE_QUOTE_ID;

/** Price book seed (contract §1) — Magic Unicorn's catalogue. */
export const PRICE_BOOK: PriceBookItem[] = [
  { id: 'pb-hosting', workspace_id: FIXTURE_WORKSPACE_ID, sku: 'HOST-CELL', label: 'Hosting and operations (dedicated cell)', kind: 'recurring', unit: 'month', default_price_cents: 35000, description_md: 'A dedicated cell on the customer ring in Charleston: TLS, single sign-on, nightly backups kept 30 days, monitoring, security updates.', active: true, recurring: { interval: 'month', notice_days: 30 } },
  { id: 'pb-change', workspace_id: FIXTURE_WORKSPACE_ID, sku: 'CHANGE-HR', label: 'Change work', kind: 'hourly', unit: 'hour', default_price_cents: 15000, description_md: 'Two-hour minimum, scheduled into the next quarterly release. Same-day work at 1.5×.', active: true, hourly: { rate_cents: 15000, minimum_hours: 2, cadence: 'quarterly release', surcharge_multiplier: 1.5 } },
  { id: 'pb-pkg-keep', workspace_id: FIXTURE_WORKSPACE_ID, sku: 'PKG-KEEP', label: 'Keep it running', kind: 'option', unit: 'month', default_price_cents: 60000, description_md: 'Hosting plus break-fix, two change hours a month, quarterly releases.', active: true, recurring: { interval: 'month', included_hours: 2, notice_days: 30 }, features: [{ label: 'Hosting and operations', value: 'Included' }, { label: 'Break-fix response', value: 'Next business day' }, { label: 'Change hours per month', value: '2' }, { label: 'Release cadence', value: 'Quarterly' }, { label: 'Assistants in the office chat', value: '—' }, { label: 'AI usage', value: '—' }, { label: 'Best for', value: 'Phase 1 only, quiet months' }] },
  { id: 'pb-pkg-improve', workspace_id: FIXTURE_WORKSPACE_ID, sku: 'PKG-IMPROVE', label: 'Improve it', kind: 'option', unit: 'month', default_price_cents: 140000, description_md: 'Hosting, four-hour break-fix, eight change hours, monthly releases, Tern and Osprey in the office chat.', active: true, recurring: { interval: 'month', included_hours: 8, ai_allowance_cents: 5000, notice_days: 30 }, features: [{ label: 'Hosting and operations', value: 'Included' }, { label: 'Break-fix response', value: 'Four business hours' }, { label: 'Change hours per month', value: '8' }, { label: 'Release cadence', value: 'Monthly' }, { label: 'Assistants in the office chat', value: 'Tern answers "how does it work"; Osprey watches orders and uptime' }, { label: 'AI usage', value: '$50 a month included, then at cost plus 20%' }, { label: 'Best for', value: 'Between milestones, steady improvements' }] },
  { id: 'pb-pkg-build', workspace_id: FIXTURE_WORKSPACE_ID, sku: 'PKG-BUILD', label: 'Build with us', kind: 'option', unit: 'month', default_price_cents: 290000, description_md: 'Same-day phone break-fix, twenty change hours, weekly releases, workflow agents under office approval.', active: true, recurring: { interval: 'month', included_hours: 20, ai_allowance_cents: 10000, notice_days: 30 }, features: [{ label: 'Hosting and operations', value: 'Included' }, { label: 'Break-fix response', value: 'Same business day, phone' }, { label: 'Change hours per month', value: '20' }, { label: 'Release cadence', value: 'Weekly' }, { label: 'Assistants in the office chat', value: 'Tern and Osprey, plus workflow agents under office approval' }, { label: 'AI usage', value: '$100 a month included, then at cost plus 20%' }, { label: 'Best for', value: 'While the roadmap is being built' }] },
  { id: 'pb-ai-50', workspace_id: FIXTURE_WORKSPACE_ID, sku: 'AI-50', label: 'AI allowance, $50', kind: 'recurring', unit: 'month', default_price_cents: 5000, description_md: 'Included assistant usage; beyond it at cost plus 20%.', active: true, recurring: { interval: 'month' } },
  { id: 'pb-ai-100', workspace_id: FIXTURE_WORKSPACE_ID, sku: 'AI-100', label: 'AI allowance, $100', kind: 'recurring', unit: 'month', default_price_cents: 10000, description_md: 'Included assistant usage; beyond it at cost plus 20%.', active: true, recurring: { interval: 'month' } },
  { id: 'pb-milestone', workspace_id: FIXTURE_WORKSPACE_ID, sku: 'MILESTONE', label: 'Roadmap milestone', kind: 'milestone', unit: 'milestone', default_price_cents: 800000, description_md: 'Priced on its own, half on start and half on acceptance.', active: true },
  { id: 'pb-engagement', workspace_id: FIXTURE_WORKSPACE_ID, sku: 'ENGAGE', label: 'Fixed-price engagement', kind: 'one_time', unit: 'engagement', default_price_cents: 1000000, description_md: 'Half on signature, half on acceptance sign-off.', active: true },
];

const S0 = 's-summary';
const S1 = 's-engagement';
const S2 = 's-roadmap';
const S3 = 's-care';
const S4 = 's-terms';

const sections: QuoteSection[] = [
  {
    id: S0, quote_id: Q, position: 0, kind: 'summary', heading: 'Summary',
    body_md:
      'Prepared by Brightwater Labs for the apparel client\'s leadership, with Magic Unicorn as platform partner. One order record from the booth to the factory, priced as three separate things so nothing is paid for twice: the engagement that is already live, a roadmap bought one milestone at a time, and keeping it running.\n\n' +
      'The number that matters to the office is the order cycle. An order written in a booth with no signal arrives as the office\'s own confirmation, typed by nobody; the roadmap extends that record to the art desk, the factory and, in the end, the customer watching their order.',
    internal_basis_md: 'The lede is the proposal\'s header text. Keep it client-specific: name their booth, their factory, their cycle. No bullets here by rule (A01 design addendum).',
  },
  {
    id: S1, quote_id: Q, position: 1, kind: 'scope', heading: 'What the $10,000 buys',
    body_md:
      'The system that cuts the order cycle in half at the front: an order captured in the booth arrives in the office as their own order confirmation, typed by nobody. Everything below is either live today or finishes before sign-off.\n\n' +
      '| Included | State |\n|---|---|\n' +
      '| Booth order pad: works offline, no login, size-run grid, tiered pricing with per-colourway override, catalogue of 135 styles and 234 colourways | Live |\n' +
      '| Order service: validates, stores and seals every order; a readable order is never refused into oblivion, it is stored and flagged | Live |\n' +
      '| Documents: the order confirmation and factory PO workbooks in the client\'s own layouts (PDF, Excel, text) | Live |\n' +
      '| Office notifications: one message per named recipient, the writing rep copied | Live, recipients switched on at go-live |\n' +
      '| Staff portal with single sign-on, roles (office, rep, art), attributed corrections, an event log per order | Live |\n' +
      '| Tablet enrolment: only enrolled devices can submit; revoke from the office screen | Live |\n' +
      '| Mockup requests with no pricing, routed to the art team | Live on the server; pad screen in the next release |\n' +
      '| Hosted cell with TLS, nightly backups, monitoring; practice mode to live cutover with the office | Live in practice mode |\n' +
      '| Acceptance test walked through together, signed; 30 days of break-fix after acceptance | At handover |\n\n' +
      '### Acceptance test, the things that get signed\n\n' +
      '- An order written in the booth with no signal reaches the office when the signal returns.\n' +
      '- The generated order confirmation matches the office-typed one on six historical orders; totals exact.\n' +
      '- The named office recipients receive one message each; the rep is copied.\n' +
      '- Office staff sign in with their accounts; a rep sees only their own accounts.\n' +
      '- A refused or malformed submission is stored and visible in the recovery queue, never lost.\n' +
      '- A revoked tablet cannot submit; a re-enrolled one can.\n' +
      '- The website is live on the client\'s domain and links to the pad.\n\n' +
      '**Payment:** half on signature, half on acceptance sign-off.',
    internal_basis_md:
      'Client offered $10k; the partner wanted $15k and had floated $18–20k for the whole build (09-10 calls). Aaron: "cut their cycle in half, that\'s what they get for the ten."\n\n' +
      'Aaron 09-12: the $10k covers "the website and taking customer orders", so the website is inside with a five-page cap. Confirm.\n\n' +
      'The 88.4% cell match and six-order test are measured (discovery brief). The rest of the list is what went live this week.',
  },
  {
    id: S2, quote_id: Q, position: 2, kind: 'scope', heading: 'The ERP, one milestone at a time',
    body_md:
      'The client\'s own phases, from their board: phase one is the sales order and PO, phase two is production tracking, phase three is the customer watching their order. Each milestone is priced on its own, paid half on start and half on acceptance, and each one extends the live system rather than replacing it.\n\n' +
      'Work starts after the show freeze (14 to 17 September). Milestones can be bought in order, one at a time, with no obligation to buy the next. The full build lands inside a year.\n\n' +
      '### Prerequisites on the client\'s side\n\n' +
      '- QuickBooks: either QuickBooks Online, or QuickBooks Desktop Enterprise kept running on an always-on Windows machine (or a hosted plan) so the Web Connector can reach it. This choice is theirs and it is the expensive one to change later.\n' +
      '- The customer list and the rep mapping, released under the data terms both sides sign.\n' +
      '- One person in the office who owns configuration: stages, tiers, factory rules.',
    internal_basis_md:
      'Milestones map one to one onto the partner\'s north star and architecture draft (Phase 2 rows, Phase 3 rows). Nothing here is invented scope.\n\n' +
      'Sizing: at this week\'s velocity the build cost is small; the price is set against value (a $4–6M house, 33 days waiting after approval) and against what the client has signalled ($10k for phase one, $18–20k casually for "the whole thing"). $36k over four milestones keeps each decision under $10k.\n\n' +
      'Alternative if they push back: time and materials at $150/hour with a cap per milestone; or drop Phase 3 self-entry (unresolved in their own room).',
  },
  {
    id: S3, quote_id: Q, position: 3, kind: 'scope', heading: 'Hosting, support, and a quarterly release',
    body_md:
      'Software is bought like a box: it runs, and when it breaks the office calls and it is fixed. Changes and new features are a different product, so they are priced as one. Updates the office asks for are gathered and shipped quarterly; anything needed immediately is billed as change work.\n\n' +
      'Package hours do not roll over. Milestone work is never charged against package hours.',
    internal_basis_md:
      'Structure is the partner\'s from 09-10: engagement number, monthly fee, monthly hosting, quarterly updates, pay extra for immediate changes. $150/hour and "three support packages" are Aaron\'s.\n\n' +
      'Tiers are built from $150/hour with a retainer discount: 2 h + hosting ≈ $650 → $600; 8 h + hosting ≈ $1,550 → $1,400; 20 h + hosting ≈ $3,350 → $2,900.\n\n' +
      'Aaron 09-10: "if they don\'t want a subscription, don\'t sell them one." The no-package line keeps that door open.',
  },
  {
    id: S4, quote_id: Q, position: 4, kind: 'terms', heading: 'Terms',
    body_md:
      '- **Their data is theirs.** Orders, customers, documents and the event log belong to the client; a full export is available on request at any time. Recordings stay local. Client names never appear in public material.\n' +
      '- **Hosting.** The system runs on hardware Magic Unicorn owns in Charleston, on a cell dedicated to this client, with nightly backups kept 30 days. It can be moved to the client\'s own infrastructure at any time for the cost of the move.\n' +
      '- **Money of record.** QuickBooks stays the book of money. The ERP owns orders, art, production and shipments and sends QuickBooks what accounting needs; it never becomes a second ledger.\n' +
      '- **Payments.** Engagement and milestones: half on start, half on acceptance. Packages: monthly in advance, 30 days\' notice to change or stop. Change work: invoiced monthly.\n' +
      '- **Acceptance.** Each milestone has a written acceptance test walked through with the office and signed. Thirty days of break-fix follow every acceptance.\n' +
      '- **Validity.** Thirty days from the date above. Work on the roadmap begins after the show.',
    internal_basis_md:
      'The data and money-of-record lines are the partner\'s own north-star principles (§11, §12). The acceptance line is Aaron\'s 09-10 advice. Code ownership is not stated here on purpose; that belongs in the master agreement the partner is asking for.',
  },
];

const care = (id: string, position: number, label: string, cents: number, hours: number, ai: number | null, features: QuoteLine['features'], description: string, selected: boolean): QuoteLine => ({
  id, quote_id: Q, section_id: S3, position, kind: 'option', label, description_md: description, qty: 1, unit: 'month',
  unit_price_cents: cents, amount_cents: cents, status_tag: 'proposed',
  recurring: { interval: 'month', included_hours: hours, ai_allowance_cents: ai, notice_days: 30 },
  hourly: null, milestone: null, option_group: 'care', selected, price_book_item_id: null, features,
});

const milestone = (id: string, position: number, label: string, cents: number, weeks: number, criteria: string): QuoteLine => ({
  id, quote_id: Q, section_id: S2, position, kind: 'milestone', label, description_md: criteria, qty: 1, unit: 'milestone',
  unit_price_cents: cents, amount_cents: cents, status_tag: 'proposed', recurring: null, hourly: null,
  milestone: { acceptance_criteria_md: criteria, weeks, payment_split: [50, 50] },
  option_group: null, selected: false, price_book_item_id: 'pb-milestone', features: null,
});

const lines: QuoteLine[] = withDerivedAmounts([
  {
    id: 'l-engagement', quote_id: Q, section_id: S1, position: 1, kind: 'one_time', label: 'Order Pad engagement',
    description_md: 'Order pad, order service, staff portal, website. Half on signature, half on acceptance sign-off.',
    qty: 1, unit: 'engagement', unit_price_cents: 1000000, amount_cents: 1000000, status_tag: 'agreed',
    recurring: null, hourly: null, milestone: { acceptance_criteria_md: null, weeks: null, payment_split: [50, 50] },
    option_group: null, selected: false, price_book_item_id: 'pb-engagement', features: null,
  },
  {
    id: 'l-website', quote_id: Q, section_id: S1, position: 2, kind: 'included', label: 'Website: up to five pages on the client\'s domain, with the order pad behind it',
    description_md: 'To build. Inside the engagement, five-page cap.', qty: 1, unit: null, unit_price_cents: 0, amount_cents: 0,
    status_tag: 'agreed', recurring: null, hourly: null, milestone: null, option_group: null, selected: false, price_book_item_id: null, features: null,
  },
  {
    id: 'l-cards', quote_id: Q, section_id: S1, position: 3, kind: 'excluded', label: 'Card numbers on file',
    description_md: 'Declined on purpose; an alternative is offered at acceptance. Customer approval on the spot, production tracking and customer self-entry are roadmap milestones, not this engagement.',
    qty: 1, unit: null, unit_price_cents: 0, amount_cents: 0, status_tag: 'agreed', recurring: null, hourly: null, milestone: null,
    option_group: null, selected: false, price_book_item_id: null, features: null,
  },
  milestone('l-m21', 4, '2.1 Art and approval', 800000, 4, 'Mockup requests reach the art team from the pad; the customer approves the order confirmation online, art and UPCs separately, each locked once approved; the customer gets a copy of the order automatically.'),
  milestone('l-m22', 5, '2.2 Factory', 800000, 4, 'PO summary sheet; factory POs per factory with the review gate before release; factory rules by fabric and embellishment limits as settings, not code; Dropbox delivery of documents.'),
  milestone('l-m23', 6, '2.3 Production and money', 800000, 4, 'Production stages recorded as events (typed, proofed, cut, sewn, shipped); containers and split shipments; QuickBooks receives the invoice authorization with the client\'s own order number, one customer ID mapping from day one.'),
  milestone('l-m3', 7, '3 Customer window', 1200000, 6, 'Customer-facing order status ("watching it like a pizza being made"); rep-scoped access for contractor reps; customer self-entry as a switchable option ($3,000 of this milestone).'),
  care('l-pkg-keep', 8, 'Keep it running', 60000, 2, null, PRICE_BOOK[2].features ?? null, 'Hosting plus break-fix, two change hours a month, quarterly releases.', false),
  care('l-pkg-improve', 9, 'Improve it', 140000, 8, 5000, PRICE_BOOK[3].features ?? null, 'Hosting, four-hour break-fix, eight change hours, monthly releases, Tern and Osprey in the office chat.', true),
  care('l-pkg-build', 10, 'Build with us', 290000, 20, 10000, PRICE_BOOK[4].features ?? null, 'Same-day phone break-fix, twenty change hours, weekly releases, workflow agents under office approval.', false),
  {
    id: 'l-hosting-only', quote_id: Q, section_id: S3, position: 11, kind: 'option', label: 'Hosting and operations alone',
    description_md: 'A dedicated cell on Magic Unicorn\'s customer ring in Charleston, TLS, single sign-on, nightly backups kept 30 days, monitoring, security updates. No change hours; change work billed by the hour.',
    qty: 1, unit: 'month', unit_price_cents: 35000, amount_cents: 35000, status_tag: 'proposed',
    recurring: { interval: 'month', notice_days: 30 }, hourly: null, milestone: null, option_group: 'care', selected: false, price_book_item_id: 'pb-hosting', features: null,
  },
  {
    id: 'l-change', quote_id: Q, section_id: S3, position: 12, kind: 'hourly', label: 'Change work',
    description_md: 'Outside a package: two-hour minimum, scheduled into the next quarterly release. Same-day work at 1.5×. Invoiced monthly.',
    qty: 1, unit: 'hour', unit_price_cents: 15000, amount_cents: 15000, status_tag: 'proposed', recurring: null,
    hourly: { rate_cents: 15000, minimum_hours: 2, cadence: 'quarterly release', surcharge_multiplier: 1.5, primary: true },
    milestone: null, option_group: null, selected: false, price_book_item_id: 'pb-change', features: null,
  },
]);

/** Build a fresh, mutable copy of the fixture record (callers may edit it). */
export function orderPadRecord(): QuoteRecord {
  const optionGroups = [{ key: 'care', label: 'Keeping it running', mode: 'exclusive' as const, intro_md: 'Three packages, or hosting alone. Pick the one that matches the year you are about to have; change it with thirty days\' notice.' }];
  const totals = computeQuote({ currency: 'USD', lines, option_groups: optionGroups, tax_estimate_cents: null });
  if (totals.option_group_errors.length) throw new Error(totals.option_group_errors.map((e) => e.message).join('; '));
  return {
    quote: {
      id: Q,
      workspace_id: FIXTURE_WORKSPACE_ID,
      customer_id: FIXTURE_CUSTOMER_ID,
      number: 'Q-2026-0001',
      title: 'Order Pad: the engagement, the roadmap, and keeping it running',
      status: 'viewed',
      currency: 'USD',
      valid_until: '2026-10-12',
      brand_slug: 'brightwater-labs',
      vendor_of_record: { label: 'Brightwater Labs', contact_ops_org_id: null },
      delivery_partner: { label: 'Magic Unicorn Unconventional Technology & Stuff Inc', contact_ops_org_id: null },
      split_rule: { kind: 'percent_net', percent: 50, hosting_to_partner: true, notes: 'Option B: hosting to Magic Unicorn in full; milestones and packages 50/50 after direct costs, tracked as lanes on Project-Ops so the split is visible, not remembered.' },
      terms_md: null,
      internal_notes_md:
        'Decisions before the partner sends this: the numbers ($36k roadmap, $600/$1,400/$2,900 packages, $350 hosting, $150 change work); website scope inside the $10k; whether to sell a package at all; the split (A, B or C); the QuickBooks path; who signs on their side.\n\n' +
        'Year one under B with "Improve it": client pays $62,800; Magic Unicorn ≈ $33,500 ($5,000 + $18,000 + $4,200 hosting + $6,300 half of the rest).',
      tax_estimate_cents: null,
      option_groups: optionGroups,
      customer: { display_name: 'The apparel client', org_name: 'The apparel client', attention: 'Jordan Mercer, Operations' },
      letterhead: {
        legal_name: 'Brightwater Labs LLC',
        address_lines: ['1 Placeholder Way, Suite 200', 'Charlotte, NC 28202'],
        tax_id_label: 'EIN',
        tax_id: 'on file',
        email: 'quotes@example.com',
        phone: null,
        website: 'genesisflowlabs.example',
      },
      created_by: 'agent:persephone',
      created_at: '2026-09-12T14:05:00Z',
      updated_at: '2026-09-12T18:30:00Z',
      sent_at: '2026-09-12T18:31:00Z',
      accepted_at: null,
      accepted_by: null,
      decline_reason: null,
      current_version_no: 2,
      locked_for_send: false,
      federated: {
        status: 'pending',
        cursors: { project_ops: 'pending', accounting_ops: 'pending', partner: 'pending' },
        project_ops_project_id: null,
        accounting_ops_invoice_ids: [],
        accounting_ops_schedule_ids: [],
        partner_invoice_id: null,
        last_error: null,
      },
      parent_quote_id: null,
    },
    sections: sections.map((s) => ({ ...s })),
    lines: lines.map((l) => ({ ...l })),
    costs: [
      { id: 'c-cell', quote_id: Q, label: 'Customer-ring cell (rackboy1 share)', amount_cents: 3000, kind: 'hosting', notes: 'per month; under 0.1% of the host' },
      { id: 'c-ai', quote_id: Q, label: 'Assistant usage for Tern and Osprey (estimate)', amount_cents: 6000, kind: 'ai_usage', notes: 'per month; passed through above the included allowance' },
    ],
    recipients: [
      { id: 'r-ops', quote_id: Q, name: 'Jordan Mercer', email: 'jordan.mercer@example.com', role: 'to', added_by: 'member:aaron' },
      { id: 'r-owner', quote_id: Q, name: 'Priya Castellanos', email: 'priya.castellanos@example.com', role: 'cc', added_by: 'member:aaron' },
    ],
    versions: [
      { id: 'v1', quote_id: Q, version_no: 1, disposition: 'superseded', created_at: '2026-09-12T15:00:00Z', render_hash: 'sha256:fixture-v1', pdf_asset_ref: null },
      { id: 'v2', quote_id: Q, version_no: 2, disposition: 'current', created_at: '2026-09-12T18:30:00Z', render_hash: 'sha256:fixture-v2', pdf_asset_ref: null },
    ],
    share_tokens: [
      { id: 't1', quote_version_id: 'v1', token: FIXTURE_TOKEN_SUPERSEDED, expires_at: '2026-10-12T23:59:59Z', revoked_at: null, view_count: 1, last_viewed_at: '2026-09-12T16:10:00Z' },
      { id: 't2', quote_version_id: 'v2', token: FIXTURE_TOKEN_CURRENT, expires_at: '2026-10-12T23:59:59Z', revoked_at: null, view_count: 2, last_viewed_at: '2026-09-12T19:02:00Z' },
    ],
    events: [
      { id: 'e1', quote_id: Q, at: '2026-09-12T14:05:00Z', actor: 'agent:persephone', kind: 'created', data: { via: 'draft_quote', assumed: 'four sections, twelve lines, packages from the price book' }, ip: null, ua: null },
      { id: 'e2', quote_id: Q, at: '2026-09-12T14:40:00Z', actor: 'member:aaron', kind: 'updated', data: { fields: ['internal_notes_md', 'split_rule'] }, ip: null, ua: null },
      { id: 'e3', quote_id: Q, at: '2026-09-12T15:00:00Z', actor: 'member:aaron', kind: 'sent', data: { version_no: 1, email_ops_draft_id: 'eo-draft-0001' }, ip: null, ua: null },
      { id: 'e4', quote_id: Q, at: '2026-09-12T15:04:00Z', actor: 'member:aaron', kind: 'send_approved', data: { version_no: 1 }, ip: null, ua: null },
      { id: 'e5', quote_id: Q, at: '2026-09-12T16:10:00Z', actor: 'client:fx-order', kind: 'viewed', data: { version_no: 1 }, ip: '203.0.113.7', ua: 'Mobile Safari' },
      { id: 'e6', quote_id: Q, at: '2026-09-12T18:30:00Z', actor: 'member:aaron', kind: 'superseded', data: { from_version_no: 1, to_version_no: 2, reason: 'website line added inside the engagement' }, ip: null, ua: null },
      { id: 'e7', quote_id: Q, at: '2026-09-12T18:31:00Z', actor: 'member:aaron', kind: 'sent', data: { version_no: 2, email_ops_draft_id: 'eo-draft-0002' }, ip: null, ua: null },
      { id: 'e8', quote_id: Q, at: '2026-09-12T18:33:00Z', actor: 'member:aaron', kind: 'send_approved', data: { version_no: 2 }, ip: null, ua: null },
      { id: 'e9', quote_id: Q, at: '2026-09-12T19:02:00Z', actor: 'client:fx-order', kind: 'viewed', data: { version_no: 2 }, ip: '203.0.113.7', ua: 'Chrome on macOS' },
      { id: 'e10', quote_id: Q, at: '2026-09-12T19:05:00Z', actor: 'client:fx-order', kind: 'option_selected', data: { option_group: 'care', line_id: 'l-pkg-improve', label: 'Improve it' }, ip: '203.0.113.7', ua: 'Chrome on macOS' },
    ],
  };
}

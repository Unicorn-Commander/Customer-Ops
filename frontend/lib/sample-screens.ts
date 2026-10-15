/**
 * Rich, on-brand sample data for the NO-AUTH preview screens (Phase 5).
 *
 * Fully typed against `lib/customers.ts`. Drives three screenshot-able routes
 * with the suite's real-world leadgen reality — retirement 401(k) rollovers,
 * commercial real estate sourced off LoopNet, Northwind Remodeling, and dental
 * practices — so a human can review the rebuilt screens without a backend.
 *
 *   - SAMPLE_ROWS    → /preview/relationships  (the relationships table)
 *   - SAMPLE_PIPELINE→ /preview/pipeline       (the kanban board)
 *   - SAMPLE_360     → /preview/customer       (one fleshed-out customer-360)
 *
 * Everything degrades clean in real life; here every federated panel is wired
 * "alive" (configured + entitled + can*) so the reviewer sees the full surface.
 */
import type {
  CustomerRow,
  Customer360,
  PipelineBoard,
  PipelineLane,
  Stage,
  TimelineEntry,
} from './customers';

/* ── time helpers (relative to "now" so dates always read fresh) ───────────── */
const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();
/** ISO string `n` days from now (negative = the past). */
const days = (n: number): string => new Date(now + n * DAY).toISOString();
/** ISO string `n` hours from now (negative = the past). */
const hours = (n: number): string => new Date(now + n * HOUR).toISOString();

const OWNER_AARON = 'aaron@magicunicorn.tech';
const OWNER_SHAFEN = 'shafen@magicunicorn.tech';

/* ─────────────────────────────────────────────────────────────────────────────
 * SAMPLE_ROWS — ~13 relationships across LEAD / PROSPECT / CUSTOMER.
 * Realistic federated contacts, priorities, sources, expected value (decimal
 * STRINGS), a mix of overdue + upcoming next-actions, and one lost deal.
 * ─────────────────────────────────────────────────────────────────────────── */
export const SAMPLE_ROWS: CustomerRow[] = [
  // ── Leads ──────────────────────────────────────────────────────────────────
  {
    id: 'rel-001',
    contactId: 'c-coastal-cre',
    stage: 'LEAD',
    priority: 'HIGH',
    source: 'LoopNet scrape',
    notes: '3 listings off-market in Mount Pleasant — owner-occupier exiting.',
    ownerUserKey: OWNER_AARON,
    expectedValue: '48000.0000',
    currency: 'USD',
    nextActionAt: hours(-30), // overdue
    isLost: false,
    lostReason: null,
    closedLostAt: null,
    lastStageChangeAt: days(-2),
    createdAt: days(-2),
    updatedAt: hours(-5),
    contact: {
      displayName: 'Coastal Property Group',
      primaryEmail: 'deals@coastalpropertygroup.com',
      currentOrgName: 'Coastal Property Group',
      tags: ['CRE', 'LoopNet', 'Charleston'],
    },
  },
  {
    id: 'rel-002',
    contactId: 'c-victor-lang',
    stage: 'LEAD',
    priority: 'MEDIUM',
    source: 'Referral — Shafen',
    notes: 'Enriched; email verified. 401(k) rollover, ex-Mumbai relocation.',
    ownerUserKey: OWNER_AARON,
    expectedValue: '14000.0000',
    currency: 'USD',
    nextActionAt: days(2),
    isLost: false,
    lostReason: null,
    closedLostAt: null,
    lastStageChangeAt: days(-4),
    createdAt: days(-4),
    updatedAt: days(-1),
    contact: {
      displayName: 'Victor Lang',
      primaryEmail: 'person15@example.com',
      currentOrgName: 'Lang Holdings',
      tags: ['401(k)', 'rollover', 'referral'],
    },
  },
  {
    id: 'rel-003',
    contactId: 'c-harborview-dental',
    stage: 'LEAD',
    priority: 'MEDIUM',
    source: 'Webform',
    notes: 'New practice; asked about group plan + AR automation.',
    ownerUserKey: OWNER_SHAFEN,
    expectedValue: '9500.0000',
    currency: 'USD',
    nextActionAt: days(1),
    isLost: false,
    lostReason: null,
    closedLostAt: null,
    lastStageChangeAt: days(-1),
    createdAt: days(-1),
    updatedAt: hours(-20),
    contact: {
      displayName: 'Harborview Dental',
      primaryEmail: 'office@harborviewdental.com',
      currentOrgName: 'Harborview Dental',
      tags: ['dental', 'inbound'],
    },
  },
  {
    id: 'rel-004',
    contactId: 'c-arthur-brooks',
    stage: 'LEAD',
    priority: 'LOW',
    source: 'LinkedIn outbound',
    notes: 'Cold; opened the first sequence email once.',
    ownerUserKey: OWNER_AARON,
    expectedValue: '6000.0000',
    currency: 'USD',
    nextActionAt: days(5),
    isLost: false,
    lostReason: null,
    closedLostAt: null,
    lastStageChangeAt: days(-6),
    createdAt: days(-6),
    updatedAt: days(-3),
    contact: {
      displayName: 'Arthur Brooks',
      primaryEmail: 'a.brooks@brooksandco.com',
      currentOrgName: 'Brooks & Co.',
      tags: ['outbound', 'cold'],
    },
  },
  {
    id: 'rel-005',
    contactId: 'c-tidewater-cre',
    stage: 'LEAD',
    priority: 'LOW',
    source: 'LoopNet scrape',
    notes: 'Retail strip on Folly Rd; low motivation right now.',
    ownerUserKey: null,
    expectedValue: '22000.0000',
    currency: 'USD',
    nextActionAt: null,
    isLost: false,
    lostReason: null,
    closedLostAt: null,
    lastStageChangeAt: days(-8),
    createdAt: days(-8),
    updatedAt: days(-7),
    contact: {
      displayName: 'Tidewater Retail Partners',
      primaryEmail: 'leasing@tidewaterretail.com',
      currentOrgName: 'Tidewater Retail Partners',
      tags: ['CRE', 'LoopNet'],
    },
  },

  // ── Prospects ────────────────────────────────────────────────────────────
  {
    id: 'rel-006',
    contactId: 'c-morgan-ali',
    stage: 'PROSPECT',
    priority: 'HIGH',
    source: 'Referral — Shafen',
    notes: 'Irving TX 401(k) rollover; replied warm, wants a call this week.',
    ownerUserKey: OWNER_AARON,
    expectedValue: '32000.0000',
    currency: 'USD',
    nextActionAt: hours(-72), // overdue 3 days
    isLost: false,
    lostReason: null,
    closedLostAt: null,
    lastStageChangeAt: days(-3),
    createdAt: days(-12),
    updatedAt: hours(-2),
    contact: {
      displayName: 'Morgan Ali',
      primaryEmail: 'morgan.ali@irvingtx.com',
      currentOrgName: 'Ali Capital — Irving TX',
      tags: ['401(k)', 'rollover', 'hot'],
    },
  },
  {
    id: 'rel-007',
    contactId: 'c-legacy-obgyn',
    stage: 'PROSPECT',
    priority: 'HIGH',
    source: 'Partner — GFL',
    notes: 'Proposal sent; awaiting signature from Dr. Maya Hart.',
    ownerUserKey: OWNER_SHAFEN,
    expectedValue: '64000.0000',
    currency: 'USD',
    nextActionAt: days(1),
    isLost: false,
    lostReason: null,
    closedLostAt: null,
    lastStageChangeAt: days(-5),
    createdAt: days(-21),
    updatedAt: hours(-8),
    contact: {
      displayName: 'Bayview Health',
      primaryEmail: 'admin@bayviewhealth.example',
      currentOrgName: 'Bayview Health — Frisco',
      tags: ['healthcare', 'proposal-out', 'GFL'],
    },
  },
  {
    id: 'rel-008',
    contactId: 'c-sam-lee-example',
    stage: 'PROSPECT',
    priority: 'MEDIUM',
    source: 'Outreach campaign',
    notes: 'Opened the outreach email 3×; clicked the pricing link.',
    ownerUserKey: OWNER_SHAFEN,
    expectedValue: '18000.0000',
    currency: 'USD',
    nextActionAt: days(0), // due today
    isLost: false,
    lostReason: null,
    closedLostAt: null,
    lastStageChangeAt: days(-4),
    createdAt: days(-15),
    updatedAt: hours(-4),
    contact: {
      displayName: 'Maple Street Dental',
      primaryEmail: 'frontdesk@examplepractice.com',
      currentOrgName: 'Maple Street Dental',
      tags: ['dental', 'engaged'],
    },
  },
  {
    id: 'rel-009',
    contactId: 'c-sunrise-dental',
    stage: 'PROSPECT',
    priority: 'MEDIUM',
    source: 'Webform',
    notes: 'Wants AR automation; comparing us vs incumbent.',
    ownerUserKey: OWNER_AARON,
    expectedValue: '21000.0000',
    currency: 'USD',
    nextActionAt: days(3),
    isLost: false,
    lostReason: null,
    closedLostAt: null,
    lastStageChangeAt: days(-6),
    createdAt: days(-18),
    updatedAt: days(-1),
    contact: {
      displayName: 'Sunrise Dental',
      primaryEmail: 'billing@sunrisedental.com',
      currentOrgName: 'Sunrise Dental',
      tags: ['dental', 'evaluating'],
    },
  },

  // ── Customers ────────────────────────────────────────────────────────────
  {
    id: 'rel-northwind', // the 360 subject below references this id
    contactId: 'c-northwind-remodeling',
    stage: 'CUSTOMER',
    priority: 'HIGH',
    source: 'Referral — Folly Beach',
    notes: 'Won $42k. Active AR; upsell to retainer in progress.',
    ownerUserKey: OWNER_AARON,
    expectedValue: '42000.0000',
    currency: 'USD',
    nextActionAt: days(4),
    isLost: false,
    lostReason: null,
    closedLostAt: null,
    lastStageChangeAt: hours(-12),
    createdAt: days(-34),
    updatedAt: hours(-1),
    contact: {
      displayName: 'Northwind Remodeling',
      primaryEmail: 'dana@northwindremodeling.com',
      currentOrgName: 'Northwind Remodeling LLC',
      tags: ['customer', 'remodeling', 'AR-active', 'retainer-upsell'],
    },
  },
  {
    id: 'rel-011',
    contactId: 'c-sunrise-dental-cust',
    stage: 'CUSTOMER',
    priority: 'MEDIUM',
    source: 'Webform',
    notes: 'Live customer; invoice #1042 paid. Monthly retainer.',
    ownerUserKey: OWNER_SHAFEN,
    expectedValue: '27000.0000',
    currency: 'USD',
    nextActionAt: days(9),
    isLost: false,
    lostReason: null,
    closedLostAt: null,
    lastStageChangeAt: days(-9),
    createdAt: days(-40),
    updatedAt: days(-1),
    contact: {
      displayName: 'Seaside Family Dentistry',
      primaryEmail: 'ap@seasidefamilydentistry.com',
      currentOrgName: 'Seaside Family Dentistry',
      tags: ['customer', 'dental', 'retainer'],
    },
  },
  {
    id: 'rel-012',
    contactId: 'c-magnolia-cre',
    stage: 'CUSTOMER',
    priority: 'LOW',
    source: 'LoopNet scrape',
    notes: 'Closed one CRE deal; quiet but renews annually.',
    ownerUserKey: OWNER_AARON,
    expectedValue: '36000.0000',
    currency: 'USD',
    nextActionAt: days(21),
    isLost: false,
    lostReason: null,
    closedLostAt: null,
    lastStageChangeAt: days(-14),
    createdAt: days(-60),
    updatedAt: days(-5),
    contact: {
      displayName: 'Magnolia Holdings',
      primaryEmail: 'cre@magnoliaholdings.com',
      currentOrgName: 'Magnolia Holdings',
      tags: ['customer', 'CRE', 'annual'],
    },
  },

  // ── Lost (one) ───────────────────────────────────────────────────────────
  {
    id: 'rel-013',
    contactId: 'c-palmetto-payroll',
    stage: 'PROSPECT',
    priority: 'LOW',
    source: 'Outreach campaign',
    notes: 'Went with an incumbent on price.',
    ownerUserKey: OWNER_AARON,
    expectedValue: '12000.0000',
    currency: 'USD',
    nextActionAt: null,
    isLost: true,
    lostReason: 'Chose an incumbent vendor on price; revisit at renewal in Q4.',
    closedLostAt: days(-7),
    lastStageChangeAt: days(-7),
    createdAt: days(-30),
    updatedAt: days(-7),
    contact: {
      displayName: 'Palmetto Payroll Co.',
      primaryEmail: 'ops@palmettopayroll.com',
      currentOrgName: 'Palmetto Payroll Co.',
      tags: ['lost', 'price'],
    },
  },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * SAMPLE_PIPELINE — the kanban board, lanes grouped from SAMPLE_ROWS by stage.
 * Lane cards EXCLUDE the lost row (the board is the live funnel); counts +
 * expected-value totals are summed from the cards each lane actually carries.
 * ─────────────────────────────────────────────────────────────────────────── */
function laneFor(stage: Stage): PipelineLane {
  const cards = SAMPLE_ROWS.filter((r) => r.stage === stage && !r.isLost);
  const total = cards.reduce((sum, c) => sum + Number(c.expectedValue ?? '0'), 0);
  return { stage, count: cards.length, expectedValue: String(total), cards };
}

const LANES: PipelineLane[] = ['LEAD', 'PROSPECT', 'CUSTOMER'].map((s) => laneFor(s as Stage));

export const SAMPLE_PIPELINE: PipelineBoard = {
  lanes: LANES,
  totals: {
    count: LANES.reduce((sum, l) => sum + l.count, 0),
    expectedValue: String(LANES.reduce((sum, l) => sum + Number(l.expectedValue), 0)),
  },
};

/* ─────────────────────────────────────────────────────────────────────────────
 * SAMPLE_360 — ONE fleshed-out relationship: Northwind Remodeling (CUSTOMER).
 * Resolved federated contact, a 6-event timeline, and ALL FOUR federated panels
 * fully alive (configured + entitled + can*) with 2-3 items each. One meeting
 * action item carries a projectOpsTaskId (the "→ task" indicator).
 * ─────────────────────────────────────────────────────────────────────────── */
const NORTHWIND = SAMPLE_ROWS.find((r) => r.id === 'rel-northwind')!;

const SAMPLE_TIMELINE: TimelineEntry[] = [
  {
    id: 't-006',
    kind: 'NOTE',
    fromStage: null,
    toStage: null,
    body: 'Kickoff call done. Dana wants a monthly retainer; sending the SOW + first invoice today.',
    actorUcUid: OWNER_AARON,
    createdAt: hours(-1),
  },
  {
    id: 't-005',
    kind: 'AGENT_RUN',
    fromStage: null,
    toStage: null,
    body: 'Lead-triage agent scored this relationship 88/100 — recommend HIGH priority; strong AR + retainer upsell signal.',
    actorUcUid: 'agent:lead-triage',
    createdAt: hours(-6),
  },
  {
    id: 't-004',
    kind: 'STAGE_CHANGE',
    fromStage: 'PROSPECT',
    toStage: 'CUSTOMER',
    body: 'Signed — $42,000 won. Moved to Customer.',
    actorUcUid: OWNER_AARON,
    createdAt: hours(-12),
  },
  {
    id: 't-003',
    kind: 'EMAIL',
    fromStage: null,
    toStage: null,
    body: 'Sent the final proposal PDF. Dana confirmed budget by reply within the hour.',
    actorUcUid: OWNER_AARON,
    createdAt: days(-3),
  },
  {
    id: 't-002',
    kind: 'STAGE_CHANGE',
    fromStage: 'LEAD',
    toStage: 'PROSPECT',
    body: 'Discovery call booked after the first reply. Moved to Prospect.',
    actorUcUid: OWNER_AARON,
    createdAt: days(-9),
  },
  {
    id: 't-001',
    kind: 'CREATE',
    fromStage: null,
    toStage: 'LEAD',
    body: 'Sourced from a Folly Beach referral. Added as a lead.',
    actorUcUid: OWNER_AARON,
    createdAt: days(-34),
  },
];

export const SAMPLE_360: Customer360 = {
  relationship: NORTHWIND,
  contact: {
    contactId: 'c-northwind-remodeling',
    displayName: 'Northwind Remodeling',
    primaryEmail: 'dana@northwindremodeling.com',
    currentOrgName: 'Northwind Remodeling LLC',
    tags: ['customer', 'remodeling', 'AR-active', 'retainer-upsell'],
    kind: 'organization',
    status: 'active',
    givenName: 'Dana',
    familyName: 'Reyes',
    additionalNames: [],
    honorificPrefix: null,
    honorificSuffix: null,
    phoneticGivenName: 'DAY-nuh',
    phoneticFamilyName: 'RAY-ess',
    nicknames: ['Dana', 'DR'],
    fileAs: 'Northwind Remodeling',
    pronouns: 'she/her',
    mergedIntoId: null,
    relationshipCategory: 'client',
    emails: [
      { address: 'dana@northwindremodeling.com', type: 'work', is_primary: true },
      { address: 'accounting@northwindremodeling.com', type: 'billing' },
    ],
    phones: [
      { e164: '+18435550148', type: 'mobile', is_primary: true },
      { e164: '+18435550199', type: 'office' },
    ],
    imHandles: [{ id: 'im-1', protocol: 'signal', handle: '+18435550148', label: 'mobile', is_primary: true }],
    identifiers: [
      { id: 'id-1', namespace: 'linkedin', value: 'dana-reyes', url: 'https://www.linkedin.com/in/dana-reyes', verified: true },
    ],
    urls: [{ id: 'url-1', url: 'https://northwindremodeling.com', type: 'website', label: 'Website', is_primary: true }],
  },
  contactFederation: { contactId: 'c-northwind-remodeling', resolved: true, source: 'contact-ops' },
  timeline: SAMPLE_TIMELINE,

  // ── Invoices (Accounting-Ops) — alive ──
  invoices: {
    federated: true,
    source: 'accounting-ops',
    configured: true,
    entitled: true,
    canCreate: true,
    items: [
      {
        id: 'inv-link-1',
        customerId: 'rel-northwind',
        externalSource: 'accounting-ops',
        externalRef: 'AO-INV-2041',
        entityId: 'ent-magic-unicorn',
        aoInvoiceId: 'ao-2041',
        invoiceNumber: 'INV-2041',
        status: 'paid',
        currency: 'USD',
        total: '18000.0000',
        balanceDue: '0.0000',
        lastPolledAt: hours(-3),
        createdAt: days(-30),
      },
      {
        id: 'inv-link-2',
        customerId: 'rel-northwind',
        externalSource: 'accounting-ops',
        externalRef: 'AO-INV-2088',
        entityId: 'ent-magic-unicorn',
        aoInvoiceId: 'ao-2088',
        invoiceNumber: 'INV-2088',
        status: 'partial',
        currency: 'USD',
        total: '16000.0000',
        balanceDue: '6000.0000',
        lastPolledAt: hours(-3),
        createdAt: days(-9),
      },
      {
        id: 'inv-link-3',
        customerId: 'rel-northwind',
        externalSource: 'accounting-ops',
        externalRef: 'AO-INV-2103',
        entityId: 'ent-magic-unicorn',
        aoInvoiceId: 'ao-2103',
        invoiceNumber: 'INV-2103',
        status: 'sent',
        currency: 'USD',
        total: '8000.0000',
        balanceDue: '8000.0000',
        lastPolledAt: hours(-3),
        createdAt: hours(-2),
      },
    ],
  },

  // ── Outreach (Listmonk + Postiz) — alive ──
  outreach: {
    federated: true,
    source: 'outreach',
    configured: true,
    entitled: true,
    canStart: true,
    campaigns: [
      { id: 'camp-1', name: 'Remodeling — retainer upsell', channel: 'email', status: 'active', isSequence: true, createdAt: days(-20) },
      { id: 'camp-2', name: 'Quarterly newsletter', channel: 'email', status: 'active', isSequence: false, createdAt: days(-45) },
      { id: 'camp-3', name: 'LinkedIn — case study push', channel: 'social', status: 'active', isSequence: false, createdAt: days(-30) },
    ],
    touches: [
      {
        id: 'touch-1',
        channel: 'email',
        campaignId: 'camp-1',
        campaignName: 'Remodeling — retainer upsell',
        status: 'replied',
        subject: 'A retainer that pays for itself',
        scheduledAt: days(-6),
        sentAt: days(-6),
        lastEngagementKind: 'reply',
        lastEngagementAt: days(-5),
      },
      {
        id: 'touch-2',
        channel: 'email',
        campaignId: 'camp-2',
        campaignName: 'Quarterly newsletter',
        status: 'clicked',
        subject: 'Q2 remodeling AR benchmarks',
        scheduledAt: days(-14),
        sentAt: days(-14),
        lastEngagementKind: 'click',
        lastEngagementAt: days(-13),
      },
      {
        id: 'touch-3',
        channel: 'social',
        campaignId: 'camp-3',
        campaignName: 'LinkedIn — case study push',
        status: 'opened',
        subject: null,
        scheduledAt: days(-8),
        sentAt: days(-8),
        lastEngagementKind: 'view',
        lastEngagementAt: days(-8),
      },
    ],
    enrollments: [
      {
        id: 'enr-1',
        contactId: 'c-northwind-remodeling',
        channel: 'email',
        externalSource: 'outreach',
        externalRef: 'lm-enroll-771',
        campaignId: 'camp-1',
        outreachId: 'or-771',
        campaignName: 'Remodeling — retainer upsell',
        status: 'sent',
        lastPolledAt: hours(-4),
        createdAt: days(-6),
      },
    ],
  },

  // ── Email (Email-Ops / Stalwart) — alive ──
  email: {
    federated: true,
    source: 'email-ops',
    configured: true,
    entitled: true,
    canSend: true,
    threads: [
      {
        id: 'thr-1',
        subject: 'Re: Proposal — Northwind retainer',
        messageCount: 5,
        unread: true,
        lastMessageAt: hours(-5),
        lastSnippet: 'Looks great — go ahead and send the first invoice, we’re ready to start Monday.',
        participants: [
          { address: 'dana@northwindremodeling.com', name: 'Jules Whitman' },
          { address: 'aaron@magicunicorn.tech', name: 'Aaron Stransky' },
        ],
      },
      {
        id: 'thr-2',
        subject: 'Kickoff scheduling',
        messageCount: 3,
        unread: false,
        lastMessageAt: days(-2),
        lastSnippet: 'Tuesday 10am ET works on our end. I’ll send the Meeting-Ops link.',
        participants: [
          { address: 'dana@northwindremodeling.com', name: 'Jules Whitman' },
          { address: 'aaron@magicunicorn.tech', name: 'Aaron Stransky' },
        ],
      },
    ],
    sent: [
      {
        id: 'em-link-1',
        contactId: 'c-northwind-remodeling',
        mode: 'send',
        externalSource: 'email-ops',
        externalRef: 'stw-msg-9912',
        threadId: 'thr-1',
        messageId: 'msg-9912',
        subject: 'Proposal — Northwind retainer (PDF)',
        status: 'delivered',
        lastPolledAt: hours(-5),
        createdAt: days(-3),
      },
      {
        id: 'em-link-2',
        contactId: 'c-northwind-remodeling',
        mode: 'draft',
        externalSource: 'email-ops',
        externalRef: 'stw-draft-1043',
        threadId: 'thr-1',
        messageId: null,
        subject: 'Welcome + onboarding checklist',
        status: 'draft',
        lastPolledAt: hours(-5),
        createdAt: hours(-6),
      },
    ],
  },

  // ── Messages (device · iMessage/SMS via UUDC) — alive ──
  conversations: {
    federated: true,
    source: 'conversations-ops',
    configured: true,
    entitled: true,
    canSend: true,
    liveSendEnabled: false,
    dryRunDefault: true,
    enabledChannels: ['iMessage', 'SMS'],
    threads: [
      {
        id: '+18435550148',
        handle: '+18435550148',
        channel: 'iMessage',
        displayName: 'Jules Whitman',
        lastMessageAt: hours(-2),
        lastSnippet: 'Perfect — see you Monday! 🎉',
        lastFromMe: false,
      },
      {
        id: '+18435550199',
        handle: '+18435550199',
        channel: 'SMS',
        displayName: 'Northwind (office)',
        lastMessageAt: days(-1),
        lastSnippet: 'On my way to the site now, will text photos.',
        lastFromMe: true,
      },
    ],
  },

  // ── Meetings (Meeting-Ops) — alive ──
  meetings: {
    federated: true,
    source: 'meeting-ops',
    configured: true,
    meetings: [
      {
        id: 'mtg-1',
        title: 'Northwind — kickoff & SOW review',
        startedAt: hours(-26),
        endedAt: hours(-25),
        durationSeconds: 3120,
        status: 'summarized',
        hasSummary: true,
        actionItemCount: 3,
        participants: [
          { contactId: 'c-northwind-remodeling', displayName: 'Jules Whitman', email: 'dana@northwindremodeling.com' },
          { contactId: null, displayName: 'Aaron Stransky', email: 'aaron@magicunicorn.tech' },
        ],
      },
      {
        id: 'mtg-2',
        title: 'Discovery call',
        startedAt: days(-9),
        endedAt: days(-9),
        durationSeconds: 1860,
        status: 'transcribed',
        hasSummary: false,
        actionItemCount: 1,
        participants: [
          { contactId: 'c-northwind-remodeling', displayName: 'Jules Whitman', email: 'dana@northwindremodeling.com' },
          { contactId: null, displayName: 'Aaron Stransky', email: 'aaron@magicunicorn.tech' },
        ],
      },
    ],
    summaries: [
      {
        id: 'sum-1',
        meetingId: 'mtg-1',
        headline: 'Kickoff aligned on a monthly retainer; first invoice approved.',
        body: 'Dana confirmed the $42k engagement and a monthly retainer going forward. Scope: AR automation + monthly remodeling-AR benchmarking. First invoice to go out today; onboarding starts Monday.',
        keyPoints: [
          'Monthly retainer confirmed on top of the $42k project',
          'AR automation is the priority deliverable',
          'First invoice approved — send today',
          'Onboarding checklist + welcome email to follow',
        ],
        createdAt: hours(-25),
      },
    ],
    actionItems: [
      {
        id: 'ai-1',
        meetingId: 'mtg-1',
        text: 'Send the first invoice (INV-2103) and the onboarding checklist.',
        status: 'open',
        assigneeContactId: null,
        assigneeLabel: 'Aaron',
        dueAt: days(1),
        projectOpsTaskId: 'PROJ-2026-000412', // the "→ task" indicator
        createdAt: hours(-25),
      },
      {
        id: 'ai-2',
        meetingId: 'mtg-1',
        text: 'Share the remodeling-AR benchmark deck with Dana.',
        status: 'open',
        assigneeContactId: null,
        assigneeLabel: 'Aaron',
        dueAt: days(3),
        projectOpsTaskId: null,
        createdAt: hours(-25),
      },
      {
        id: 'ai-3',
        meetingId: 'mtg-1',
        text: 'Confirm the Monday onboarding start time with the practice.',
        status: 'done',
        assigneeContactId: 'c-northwind-remodeling',
        assigneeLabel: 'Dana',
        dueAt: hours(-2),
        projectOpsTaskId: null,
        createdAt: hours(-25),
      },
    ],
  },

  // ── Projects (Project-Ops) — alive ──
  projects: {
    federated: true,
    source: 'project-ops',
    configured: true,
    projects: [
      {
        id: 'proj-1',
        matchedBy: 'customerOpsCustomerId',
        projectNumber: 'P-00412',
        title: 'AR automation rollout',
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        dueDate: days(18),
        clientName: 'Northwind Remodeling',
        organizationName: 'Northwind Remodeling',
        assignedTo: { displayName: 'Aaron Stransky', email: 'aaron@magicunicorn.tech' },
      },
      {
        id: 'proj-2',
        matchedBy: 'contactOpsContactId',
        projectNumber: 'P-00418',
        title: 'Remodeling-AR benchmark deck',
        status: 'UNDER_REVIEW',
        priority: 'MEDIUM',
        dueDate: days(4),
        clientName: 'Northwind Remodeling',
        organizationName: 'Northwind Remodeling',
        assignedTo: { displayName: 'Aaron Stransky', email: 'aaron@magicunicorn.tech' },
      },
      {
        id: 'proj-3',
        matchedBy: 'name',
        projectNumber: 'P-00377',
        title: 'Discovery & SOW',
        status: 'COMPLETED',
        priority: 'LOW',
        dueDate: days(-12),
        clientName: 'Northwind Remodeling',
        organizationName: 'Northwind Remodeling',
        assignedTo: null,
      },
    ],
  },
};

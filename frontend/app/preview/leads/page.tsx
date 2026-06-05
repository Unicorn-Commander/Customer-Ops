'use client';

import { useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { LeadIngestion } from '@/components/dashboard/LeadIngestion';
import {
  type LeadIntake, type IntakeStats, type IntakeStatus, type IngestLeadInput,
  type IngestResult, type ResolvePendingResult,
  slugifyDedupKey,
} from '@/lib/leads';

/**
 * Design preview — the Lead Ingestion cockpit with rich sample data, no
 * auth/backend required. Used to review the visual direction (and screenshot
 * it). The live screen lives at /dashboard/leads.
 *
 * Actions run against LOCAL state so the preview feels alive: "Resolve pending"
 * promotes some PENDING rows to RESOLVED (and upgrades a provisional), discard
 * drops a row, and "Add lead" appends a freshly-ingested PENDING intake.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();
const days = (n: number) => new Date(now + n * DAY).toISOString();
const hours = (n: number) => new Date(now + n * HOUR).toISOString();

const OWNER_AARON = 'aaron@magicunicorn.tech';
const OWNER_SHAFEN = 'shafen@magicunicorn.tech';

/* 13 intakes across every source, a realistic status mix, some provisional. */
const SAMPLE_INTAKES: LeadIntake[] = [
  {
    id: 'li-001', source: 'northwind', sourceDedupKey: 'dana-merrill-northwind-remodel',
    status: 'RESOLVED', displayName: 'Casey Merrill', email: 'dana@northwindremodeling.com',
    phone: '+1 843 555 0147', orgName: 'Northwind Remodeling', tags: ['remodel', 'retainer', 'charleston'],
    score: 92, expectedValue: '15100.0000', currency: 'USD', priority: 'HIGH',
    ownerUserKey: OWNER_AARON, notes: 'Graduated from outreach; signed SOW.',
    resolvedContactId: 'c-northwind', provisional: false, customerId: 'rel-northwind',
    statusDetail: 'Matched to Contact-Ops contact c-northwind.', createdByUcUid: null,
    resolvedAt: hours(-20), createdAt: days(-3), updatedAt: hours(-20),
  },
  {
    id: 'li-002', source: 'loopnet', sourceDedupKey: 'coastal-property-group-mtp',
    status: 'PENDING', displayName: 'Coastal Property Group', email: 'deals@coastalpropertygroup.com',
    phone: null, orgName: 'Coastal Property Group', tags: ['CRE', 'LoopNet', 'off-market'],
    score: 81, expectedValue: '48000.0000', currency: 'USD', priority: 'HIGH',
    ownerUserKey: OWNER_AARON, notes: '3 off-market listings in Mount Pleasant.',
    resolvedContactId: null, provisional: false, customerId: null,
    statusDetail: 'Awaiting a Contact-Ops match on the listing email.', createdByUcUid: null,
    resolvedAt: null, createdAt: hours(-6), updatedAt: hours(-6),
  },
  {
    id: 'li-003', source: 'magic-unicorn-outreach', sourceDedupKey: 'victor-lang-rollover',
    status: 'RESOLVED', displayName: 'Victor Lang', email: 'person15@example.com',
    phone: '+1 469 555 0188', orgName: 'Lang Holdings', tags: ['401(k)', 'rollover', 'sequence'],
    score: 74, expectedValue: '14000.0000', currency: 'USD', priority: 'MEDIUM',
    ownerUserKey: OWNER_AARON, notes: 'Replied to step 2 of the rollover sequence.',
    resolvedContactId: 'c-victor-lang', provisional: false, customerId: 'rel-002',
    statusDetail: 'Matched to Contact-Ops contact c-victor-lang.', createdByUcUid: null,
    resolvedAt: hours(-40), createdAt: days(-2), updatedAt: hours(-40),
  },
  {
    id: 'li-004', source: 'multistate', sourceDedupKey: 'harborview-dental-webform',
    status: 'PENDING', displayName: 'Harborview Dental', email: 'office@harborviewdental.com',
    phone: '+1 843 555 0312', orgName: 'Harborview Dental', tags: ['dental', 'group-plan'],
    score: 58, expectedValue: '9500.0000', currency: 'USD', priority: 'MEDIUM',
    ownerUserKey: OWNER_SHAFEN, notes: 'New practice; asked about AR automation.',
    resolvedContactId: null, provisional: false, customerId: null,
    statusDetail: 'Queued for the next resolve sweep.', createdByUcUid: null,
    resolvedAt: null, createdAt: hours(-11), updatedAt: hours(-11),
  },
  {
    id: 'li-005', source: 'multistate', sourceDedupKey: 'sandhills-401k-rollover',
    status: 'PENDING', displayName: 'Marcus Webb', email: 'mwebb@sandhillswealth.com',
    phone: null, orgName: 'Sandhills Wealth', tags: ['401(k)', 'rollover', 'NC'],
    score: 49, expectedValue: '11200.0000', currency: 'USD', priority: 'MEDIUM',
    ownerUserKey: OWNER_AARON, notes: 'Multistate 1.27M batch; mid-funnel.',
    resolvedContactId: null, provisional: false, customerId: null,
    statusDetail: 'Awaiting identity resolution.', createdByUcUid: null,
    resolvedAt: null, createdAt: hours(-26), updatedAt: hours(-26),
  },
  {
    id: 'li-006', source: 'agent', sourceDedupKey: 'agent-triage-elena-cho',
    status: 'RESOLVED', displayName: 'Elena Cho', email: 'elena.cho@brightpathclinic.com',
    phone: '+1 415 555 0199', orgName: 'BrightPath Clinic', tags: ['agent-sourced', 'healthcare'],
    score: 88, expectedValue: '22000.0000', currency: 'USD', priority: 'HIGH',
    ownerUserKey: OWNER_AARON, notes: 'Lead-triage agent graduated this from the inbox.',
    resolvedContactId: 'c-elena-cho', provisional: true, customerId: 'rel-006',
    statusDetail: 'Resolved against a provisional placeholder (Contact-Ops was dormant at ingest).',
    createdByUcUid: 'agent:lead-triage', resolvedAt: hours(-15), createdAt: hours(-16), updatedAt: hours(-15),
  },
  {
    id: 'li-007', source: 'northwind', sourceDedupKey: 'patel-kitchen-reno',
    status: 'PENDING', displayName: 'Raj Patel', email: 'person100@example.com',
    phone: '+1 843 555 0521', orgName: null, tags: ['remodel', 'kitchen'],
    score: 63, expectedValue: '28000.0000', currency: 'USD', priority: 'HIGH',
    ownerUserKey: OWNER_AARON, notes: 'Kitchen + primary bath; budget confirmed.',
    resolvedContactId: null, provisional: false, customerId: null,
    statusDetail: 'Awaiting a Contact-Ops match.', createdByUcUid: null,
    resolvedAt: null, createdAt: hours(-3), updatedAt: hours(-3),
  },
  {
    id: 'li-008', source: 'loopnet', sourceDedupKey: 'oakwood-industrial-park',
    status: 'FAILED', displayName: null, email: 'leasing@oakwoodindustrial.com',
    phone: null, orgName: 'Oakwood Industrial', tags: ['CRE', 'industrial'],
    score: 41, expectedValue: '60000.0000', currency: 'USD', priority: 'MEDIUM',
    ownerUserKey: OWNER_AARON, notes: 'Enrichment failed — bad domain MX.',
    resolvedContactId: null, provisional: false, customerId: null,
    statusDetail: 'Resolution failed: contact enrichment timed out. Retry available.',
    createdByUcUid: null, resolvedAt: null, createdAt: days(-1), updatedAt: hours(-22),
  },
  {
    id: 'li-009', source: 'magic-unicorn-outreach', sourceDedupKey: 'greenfield-cpa-firm',
    status: 'PENDING', displayName: 'Tom Greenfield', email: 'tom@greenfieldcpa.com',
    phone: '+1 919 555 0244', orgName: 'Greenfield CPA', tags: ['accounting', 'B2B'],
    score: 55, expectedValue: '8400.0000', currency: 'USD', priority: 'LOW',
    ownerUserKey: OWNER_SHAFEN, notes: 'Opened sequence; no reply yet.',
    resolvedContactId: null, provisional: false, customerId: null,
    statusDetail: 'Queued for resolution.', createdByUcUid: null,
    resolvedAt: null, createdAt: hours(-30), updatedAt: hours(-30),
  },
  {
    id: 'li-010', source: 'agent', sourceDedupKey: 'agent-web-summit-nadia',
    status: 'RESOLVED', displayName: 'Nadia Rahman', email: 'nadia@summitlegal.io',
    phone: '+1 646 555 0166', orgName: 'Summit Legal', tags: ['agent-sourced', 'legal'],
    score: 79, expectedValue: '18500.0000', currency: 'USD', priority: 'HIGH',
    ownerUserKey: OWNER_AARON, notes: 'Web-summit follow-up agent graduated this.',
    resolvedContactId: 'c-nadia-rahman', provisional: false, customerId: 'rel-010',
    statusDetail: 'Matched to Contact-Ops contact c-nadia-rahman.', createdByUcUid: 'agent:follow-up',
    resolvedAt: hours(-48), createdAt: days(-2), updatedAt: hours(-48),
  },
  {
    id: 'li-011', source: 'multistate', sourceDedupKey: 'duplicate-spam-blast-x',
    status: 'DISCARDED', displayName: null, email: 'noreply@spamblast.example',
    phone: null, orgName: null, tags: ['spam'],
    score: 4, expectedValue: null, currency: 'USD', priority: 'LOW',
    ownerUserKey: null, notes: 'List-bomb; discarded.',
    resolvedContactId: null, provisional: false, customerId: null,
    statusDetail: 'Discarded by operator: spam.', createdByUcUid: null,
    resolvedAt: null, createdAt: days(-1), updatedAt: hours(-23),
  },
  {
    id: 'li-012', source: 'manual', sourceDedupKey: 'walkin-alex-rivera-summit medical',
    status: 'RESOLVED', displayName: 'Leo Grant', email: 'leo.grant@university.example',
    phone: '+1 214 555 0101', orgName: 'Summit Medical Center', tags: ['consulting', 'referral', 'manual'],
    score: 86, expectedValue: '40000.0000', currency: 'USD', priority: 'HIGH',
    ownerUserKey: OWNER_AARON, notes: 'Added by Aaron after the Jason intro call.',
    resolvedContactId: 'c-alex-rivera', provisional: false, customerId: 'rel-012',
    statusDetail: 'Resolved via explicit contact id.', createdByUcUid: 'aaron@magicunicorn.tech',
    resolvedAt: hours(-9), createdAt: hours(-9), updatedAt: hours(-9),
  },
  {
    id: 'li-013', source: 'loopnet', sourceDedupKey: 'riverside-retail-strip',
    status: 'PENDING', displayName: 'Riverside Retail Partners', email: null,
    phone: '+1 843 555 0777', orgName: 'Riverside Retail Partners', tags: ['CRE', 'retail'],
    score: 67, expectedValue: '52000.0000', currency: 'USD', priority: 'MEDIUM',
    ownerUserKey: OWNER_AARON, notes: 'Phone-only lead off a LoopNet listing.',
    resolvedContactId: null, provisional: false, customerId: null,
    statusDetail: 'Awaiting identity resolution (no email on file).', createdByUcUid: null,
    resolvedAt: null, createdAt: hours(-2), updatedAt: hours(-2),
  },
];

function statsFor(intakes: LeadIntake[], coReachable: boolean): IntakeStats {
  const byStatus: Record<IntakeStatus, number> = { PENDING: 0, RESOLVED: 0, FAILED: 0, DISCARDED: 0 };
  for (const it of intakes) byStatus[it.status] += 1;
  return { total: intakes.length, byStatus, coReachable };
}

export default function PreviewLeadsPage() {
  const [intakes, setIntakes] = useState<LeadIntake[]>(SAMPLE_INTAKES);
  // Toggle this to false in code to preview the "Contact-Ops dormant" header chip.
  const [coReachable] = useState(true);
  const stats = useMemo(() => statsFor(intakes, coReachable), [intakes, coReachable]);

  const onResolvePending = async (): Promise<ResolvePendingResult> => {
    let resolved = 0;
    let upgraded = 0;
    const next = intakes.map((it) => {
      if (it.status === 'PENDING') {
        // Resolve the first couple of pending rows to make the sweep feel real.
        if (resolved < 2) {
          resolved += 1;
          return {
            ...it,
            status: 'RESOLVED' as IntakeStatus,
            resolvedContactId: `c-${it.id}`,
            customerId: `rel-${it.id}`,
            statusDetail: 'Resolved via Contact-Ops match.',
            resolvedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        }
      }
      if (it.provisional && it.status === 'RESOLVED') {
        upgraded += 1;
        return { ...it, provisional: false, statusDetail: 'Provisional record upgraded to a real identity.' };
      }
      return it;
    });
    setIntakes(next);
    const stillOpen = next.filter((it) => it.status === 'PENDING' || it.status === 'FAILED').length;
    const scanned = intakes.filter((it) => it.status === 'PENDING' || it.status === 'FAILED').length;
    return { scanned, resolved, stillOpen, provisionalUpgraded: upgraded, coReachable };
  };

  const onIngest = async (body: IngestLeadInput): Promise<IngestResult> => {
    const id = `li-new-${Math.random().toString(36).slice(2, 8)}`;
    const intake: LeadIntake = {
      id,
      source: body.source,
      sourceDedupKey: body.sourceDedupKey || slugifyDedupKey(body.email ?? id),
      status: body.contactId ? 'RESOLVED' : 'PENDING',
      displayName: body.displayName ?? null,
      email: body.email ?? null,
      phone: body.phone ?? null,
      orgName: body.orgName ?? null,
      tags: body.tags ?? [],
      score: body.score ?? null,
      expectedValue: body.expectedValue ?? null,
      currency: body.currency ?? 'USD',
      priority: body.priority ?? 'MEDIUM',
      ownerUserKey: body.ownerUserKey ?? OWNER_AARON,
      notes: body.notes ?? null,
      resolvedContactId: body.contactId ?? null,
      provisional: false,
      customerId: null,
      statusDetail: body.contactId ? 'Resolved via explicit contact id.' : 'Awaiting identity resolution.',
      createdByUcUid: 'aaron@magicunicorn.tech',
      resolvedAt: body.contactId ? new Date().toISOString() : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setIntakes((prev) => [intake, ...prev]);
    return {
      intake,
      resolved: !!body.contactId,
      via: body.contactId ? 'explicit' : null,
      provisional: false,
      contactId: body.contactId ?? null,
      customerId: null,
      detail: body.contactId
        ? 'Bound directly to the supplied Contact-Ops contact.'
        : 'Staged in the queue — will resolve on the next Contact-Ops sweep.',
    };
  };

  const onDiscard = (id: string) => {
    setIntakes((prev) =>
      prev.map((it) => (it.id === id
        ? { ...it, status: 'DISCARDED' as IntakeStatus, statusDetail: 'Discarded by operator.', updatedAt: new Date().toISOString() }
        : it)),
    );
  };

  return (
    <AppShell demo>
      <LeadIngestion
        stats={stats}
        intakes={intakes}
        coReachable={coReachable}
        onResolvePending={onResolvePending}
        onIngest={onIngest}
        onDiscard={onDiscard}
        onRefresh={() => {}}
      />
    </AppShell>
  );
}

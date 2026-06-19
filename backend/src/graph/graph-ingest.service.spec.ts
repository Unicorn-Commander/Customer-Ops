/**
 * GraphIngestService — the Phase-2 INGEST mapping (relationship + federation →
 * graph nodes/edges).
 *
 * These specs run the REAL GraphService write primitives over a FAKE FalkorDbService
 * that captures every Cypher query + params in memory, so we assert the ACTUAL
 * batched UNWIND payloads the ingest produces — the node labels, the stable keys,
 * the edge types, and the degrade-clean posture. The federation ports + the
 * workspace/prisma seam are faked the same way customers.service.spec fakes them
 * (plain jest.fn() objects cast to the port type). No real FalkorDB / DB / federated
 * app is touched.
 *
 * The contracts under test:
 *   1. DORMANT GRAPH → clean no-op (0/0), no primitive call, no throw.
 *   2. LOCAL SKELETON → Hub + Person + Deal + LeadSource nodes and the
 *      IS_CONTACT / OWNS_DEAL / SOURCED_FROM edges, on the stable key scheme,
 *      written even when EVERY federation source is dormant.
 *   3. FEDERATION ENRICHMENT → Contact-Ops fills displayName + Org/WORKS_AT;
 *      Meeting/Outreach/Email add their nodes+edges when configured.
 *   4. DEGRADE-CLEAN FEDERATION → a throwing source is skipped; the skeleton + the
 *      other sources still land (the backfill never throws).
 *   5. upsertCustomer → the single-customer path; swallows errors (best-effort).
 *   6. IDEMPOTENCY → all writes are MERGE (asserted on the generated Cypher).
 */

import { FalkorDbService } from './falkordb.service';
import { GraphService } from './graph.service';
import { GraphIngestService } from './graph-ingest.service';
import { graphKeyFor } from './graph-key';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { MeetingOpsPort } from '../meeting-ops/meeting-ops.port';
import { AccountingOpsPort } from '../accounting-ops/accounting-ops.port';
import { OutreachPort } from '../outreach-ops/outreach-ops.port';
import { EmailOpsPort } from '../email-ops/email-ops.port';

const WS = '0190a000-7e57-7000-8000-00000000c007'; // valid uuid → graphKeyFor passes
const KEY = graphKeyFor(WS);

/** One captured Cypher call. */
interface Captured {
  cypher: string;
  params?: Record<string, any>;
}

/**
 * A fake graph handle that records every query. `configured=false` makes graph()
 * throw exactly like the dormant transport (so the dormant-path test is real).
 */
function makeFalkor(configured: boolean, sink: Captured[]): FalkorDbService {
  const graphHandle = {
    query: jest.fn(async (cypher: string, opts?: { params?: Record<string, any> }) => {
      sink.push({ cypher, params: opts?.params });
      return { data: [] };
    }),
  };
  return {
    get isConfigured() {
      return configured;
    },
    graph: (_key: string) => {
      if (!configured) throw new Error('dormant');
      return graphHandle as any;
    },
  } as unknown as FalkorDbService;
}

/** A WorkspaceContextService whose runInWorkspace just invokes fn with the fake tx. */
function makeWorkspaces(tx: any): WorkspaceContextService {
  return {
    runInWorkspace: jest.fn(async (_ws: string, _uid: string | null, fn: (t: any) => any) => fn(tx)),
  } as unknown as WorkspaceContextService;
}

/** A fake Prisma tx exposing only the finders the ingest reads. */
function makeTx(opts: {
  customers?: any[];
  oneCustomer?: any | null;
  invoiceLinks?: any[];
  outreachLinks?: any[];
  emailLinks?: any[];
  intakes?: any[];
}) {
  return {
    customer: {
      findMany: jest.fn().mockResolvedValue(opts.customers ?? []),
      findFirst: jest.fn().mockResolvedValue(opts.oneCustomer ?? null),
    },
    customerInvoiceLink: { findMany: jest.fn().mockResolvedValue(opts.invoiceLinks ?? []) },
    customerOutreachLink: { findMany: jest.fn().mockResolvedValue(opts.outreachLinks ?? []) },
    customerEmailLink: { findMany: jest.fn().mockResolvedValue(opts.emailLinks ?? []) },
    leadIntake: { findMany: jest.fn().mockResolvedValue(opts.intakes ?? []) },
  };
}

/** All five federation ports, dormant/empty by default (degrade-clean baseline). */
function makePorts(overrides: Partial<{
  contact: Partial<ContactOpsPort>;
  meeting: Partial<MeetingOpsPort>;
  accounting: Partial<AccountingOpsPort>;
  outreach: Partial<OutreachPort>;
  email: Partial<EmailOpsPort>;
}> = {}) {
  const contact = {
    getContactSummaries: jest.fn().mockResolvedValue(new Map()),
    getContact: jest.fn().mockResolvedValue(null),
    listContacts: jest.fn(),
    getWorkspaceProjection: jest.fn(),
    upsertContact: jest.fn(),
    ...overrides.contact,
  } as unknown as ContactOpsPort;
  const meeting = {
    isConfigured: jest.fn().mockReturnValue(false),
    listMeetingsForContact: jest.fn().mockResolvedValue({ items: [], count: 0, nextCursor: null }),
    listSummariesForContact: jest.fn().mockResolvedValue([]),
    listActionItemsForContact: jest.fn().mockResolvedValue([]),
    getMeetingSignal: jest.fn(),
    ...overrides.meeting,
  } as unknown as MeetingOpsPort;
  const accounting = {
    isConfigured: jest.fn().mockReturnValue(false),
    checkEntitlement: jest.fn(),
    createInvoice: jest.fn(),
    getInvoiceByRef: jest.fn(),
    getInvoiceById: jest.fn(),
    ...overrides.accounting,
  } as unknown as AccountingOpsPort;
  const outreach = {
    isConfigured: jest.fn().mockReturnValue(false),
    checkEntitlement: jest.fn(),
    listCampaigns: jest.fn().mockResolvedValue([]),
    listTouchesForContact: jest.fn().mockResolvedValue([]),
    enrollContact: jest.fn(),
    scheduleSocialTouch: jest.fn(),
    ...overrides.outreach,
  } as unknown as OutreachPort;
  const email = {
    isConfigured: jest.fn().mockReturnValue(false),
    checkEntitlement: jest.fn(),
    listThreadsWithContact: jest.fn().mockResolvedValue([]),
    listThreadMessages: jest.fn(),
    composeEmail: jest.fn(),
    ...overrides.email,
  } as unknown as EmailOpsPort;
  return { contact, meeting, accounting, outreach, email };
}

function makeCustomer(over: Partial<any> = {}) {
  return {
    id: 'cust-1',
    contactId: 'person-1',
    stage: 'LEAD',
    priority: 'MEDIUM',
    source: 'northwind',
    expectedValue: { toString: () => '1000.0000' },
    currency: 'USD',
    ownerUserKey: 'rep-1',
    isLost: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastStageChangeAt: new Date('2026-01-02T00:00:00.000Z'),
    ...over,
  };
}

/** Build the service with a captured-Cypher graph + the given fakes. */
function build(opts: {
  configured?: boolean;
  tx?: any;
  ports?: ReturnType<typeof makePorts>;
}) {
  const sink: Captured[] = [];
  const falkor = makeFalkor(opts.configured ?? true, sink);
  const graph = new GraphService(falkor);
  const tx = opts.tx ?? makeTx({});
  const workspaces = makeWorkspaces(tx);
  const ports = opts.ports ?? makePorts();
  const svc = new GraphIngestService(
    falkor,
    graph,
    workspaces,
    {} as unknown as PrismaService,
    ports.contact,
    ports.meeting,
    ports.accounting,
    ports.outreach,
    ports.email,
  );
  return { svc, sink, ports, tx };
}

/** Collect the node keys submitted for a given label across all UNWIND batches. */
function nodeKeysFor(sink: Captured[], label: string): string[] {
  const keys: string[] = [];
  for (const c of sink) {
    if (c.cypher.includes(`MERGE (n:${label} {`) && c.params?.rows) {
      for (const r of c.params.rows) keys.push(r.key);
    }
  }
  return keys;
}

/** Collect the (from,to) pairs submitted for a given edge type. */
function edgesFor(sink: Captured[], type: string): Array<{ from: string; to: string; props: any }> {
  const out: Array<{ from: string; to: string; props: any }> = [];
  for (const c of sink) {
    if (c.cypher.includes(`[r:${type}]`) && c.params?.rows) {
      for (const r of c.params.rows) out.push({ from: r.fromKey, to: r.toKey, props: r.props });
    }
  }
  return out;
}

describe('GraphIngestService', () => {
  describe('dormant graph', () => {
    it('backfillWorkspace no-ops (0/0) and never touches the graph', async () => {
      const { svc, sink, tx } = build({ configured: false });
      const result = await svc.backfillWorkspace(WS);
      expect(result).toEqual({ nodes: 0, edges: 0 });
      expect(sink).toHaveLength(0);
      // It must not even open an RLS read when the graph is dormant.
      expect(tx.customer.findMany).not.toHaveBeenCalled();
    });

    it('upsertCustomer no-ops cleanly while dormant (no throw, no write)', async () => {
      const { svc, sink } = build({ configured: false });
      await expect(svc.upsertCustomer(WS, 'cust-1')).resolves.toBeUndefined();
      expect(sink).toHaveLength(0);
    });
  });

  describe('local skeleton (no federation configured)', () => {
    it('writes Hub + Person + Deal + LeadSource on the stable key scheme', async () => {
      const tx = makeTx({ customers: [makeCustomer()] });
      const { svc, sink } = build({ tx });

      const result = await svc.backfillWorkspace(WS);

      // Indexes were created against the per-workspace graph key (chokepoint).
      expect(sink.some((c) => c.cypher.includes('CREATE INDEX'))).toBe(true);

      expect(nodeKeysFor(sink, 'Hub')).toEqual([`hub:${WS}`]);
      expect(nodeKeysFor(sink, 'Person')).toContain('person:person-1');
      expect(nodeKeysFor(sink, 'Deal')).toEqual(['deal:cust-1']);
      expect(nodeKeysFor(sink, 'LeadSource')).toEqual(['source:northwind']);

      // Edges: Hub→Person (IS_CONTACT), Person→Deal (OWNS_DEAL), Person→Source.
      expect(edgesFor(sink, 'IS_CONTACT')).toEqual([
        expect.objectContaining({ from: `hub:${WS}`, to: 'person:person-1' }),
      ]);
      const owns = edgesFor(sink, 'OWNS_DEAL');
      expect(owns[0]).toEqual(
        expect.objectContaining({ from: 'person:person-1', to: 'deal:cust-1' }),
      );
      // OWNS_DEAL weight carries the expected pipeline value (numeric).
      expect(owns[0].props.weight).toBe(1000);
      expect(edgesFor(sink, 'SOURCED_FROM')).toEqual([
        expect.objectContaining({ from: 'person:person-1', to: 'source:northwind' }),
      ]);

      // The skeleton stood alone — non-zero counts even with all federation dormant.
      expect(result.nodes).toBeGreaterThan(0);
      expect(result.edges).toBeGreaterThan(0);
    });

    it('maps invoice / outreach / email links to their nodes + edges', async () => {
      const tx = makeTx({
        customers: [makeCustomer()],
        invoiceLinks: [
          {
            externalRef: 'inv-ref-1',
            externalSource: 'customer-ops',
            invoiceNumber: 'INV-001',
            lastStatus: 'sent',
            currency: 'USD',
            totalAmount: { toString: () => '500.0000' },
            createdAt: new Date('2026-01-03T00:00:00.000Z'),
          },
        ],
        outreachLinks: [
          {
            campaignId: 'camp-9',
            externalRef: 'out-ref-1',
            externalSource: 'customer-ops',
            campaignName: 'Spring Blast',
            channel: 'email',
            lastStatus: 'sent',
            createdAt: new Date('2026-01-04T00:00:00.000Z'),
          },
        ],
        emailLinks: [
          {
            threadId: 'thread-7',
            externalRef: 'em-ref-1',
            externalSource: 'customer-ops',
            subject: 'Hello',
            lastStatus: 'delivered',
            createdAt: new Date('2026-01-05T00:00:00.000Z'),
          },
        ],
      });
      const { svc, sink } = build({ tx });

      await svc.backfillWorkspace(WS);

      expect(nodeKeysFor(sink, 'Invoice')).toEqual(['invoice:inv-ref-1']);
      expect(nodeKeysFor(sink, 'Campaign')).toEqual(['campaign:camp-9']);
      expect(nodeKeysFor(sink, 'Email')).toEqual(['email:thread-7']);

      expect(edgesFor(sink, 'BILLED_FOR')[0]).toEqual(
        expect.objectContaining({ from: 'person:person-1', to: 'invoice:inv-ref-1' }),
      );
      expect(edgesFor(sink, 'ENROLLED_IN')[0]).toEqual(
        expect.objectContaining({ from: 'person:person-1', to: 'campaign:camp-9' }),
      );
      expect(edgesFor(sink, 'EMAILED')[0]).toEqual(
        expect.objectContaining({ from: 'person:person-1', to: 'email:thread-7' }),
      );
    });

    it('records REFERRED_BY when a lead-intake resolved a different contact', async () => {
      const tx = makeTx({
        customers: [makeCustomer()],
        intakes: [{ source: 'referral', resolvedContactId: 'person-referrer' }],
      });
      const { svc, sink } = build({ tx });

      await svc.backfillWorkspace(WS);

      expect(edgesFor(sink, 'REFERRED_BY')[0]).toEqual(
        expect.objectContaining({ from: 'person:person-1', to: 'person:person-referrer' }),
      );
      // The referral source is also recorded as a LeadSource.
      expect(nodeKeysFor(sink, 'LeadSource')).toContain('source:referral');
    });

    it('all node + edge writes are MERGE (idempotent)', async () => {
      const tx = makeTx({ customers: [makeCustomer()] });
      const { svc, sink } = build({ tx });
      await svc.backfillWorkspace(WS);
      const writes = sink.filter((c) => c.params?.rows);
      expect(writes.length).toBeGreaterThan(0);
      for (const w of writes) expect(w.cypher).toContain('MERGE');
    });
  });

  describe('federation enrichment', () => {
    it('Contact-Ops fills displayName + draws Person→Org WORKS_AT', async () => {
      const summaries = new Map([
        [
          'person-1',
          {
            contactId: 'person-1',
            displayName: 'Ada Lovelace',
            primaryEmail: 'ada@example.com',
            currentOrgId: 'org-42',
            currentOrgName: 'Analytical Engines',
            lastInteractionAt: '2026-01-06T00:00:00.000Z',
            communicationStrength: 5,
            tags: [],
            etag: null,
          },
        ],
      ]);
      const ports = makePorts({ contact: { getContactSummaries: jest.fn().mockResolvedValue(summaries) } });
      const tx = makeTx({ customers: [makeCustomer()] });
      const { svc, sink } = build({ tx, ports });

      await svc.backfillWorkspace(WS);

      // Org node keyed by the federated org id; WORKS_AT from the person.
      expect(nodeKeysFor(sink, 'Org')).toEqual(['org:org-42']);
      expect(edgesFor(sink, 'WORKS_AT')[0]).toEqual(
        expect.objectContaining({ from: 'person:person-1', to: 'org:org-42' }),
      );
      // The Person node's displayName was enriched to the real name.
      const personRows = sink
        .filter((c) => c.cypher.includes('MERGE (n:Person {') && c.params?.rows)
        .flatMap((c) => c.params!.rows);
      const ada = personRows.find((r: any) => r.key === 'person:person-1');
      expect(ada.props.displayName).toBe('Ada Lovelace');
    });

    it('falls back to an org:name:<slug> key when only the org NAME is known', async () => {
      const summaries = new Map([
        [
          'person-1',
          {
            contactId: 'person-1',
            displayName: 'Grace Hopper',
            primaryEmail: null,
            currentOrgId: null,
            currentOrgName: 'US Navy',
            lastInteractionAt: null,
            communicationStrength: null,
            tags: [],
            etag: null,
          },
        ],
      ]);
      const ports = makePorts({ contact: { getContactSummaries: jest.fn().mockResolvedValue(summaries) } });
      const { svc, sink } = build({ tx: makeTx({ customers: [makeCustomer()] }), ports });
      await svc.backfillWorkspace(WS);
      expect(nodeKeysFor(sink, 'Org')).toEqual(['org:name:us-navy']);
    });

    it('Meeting-Ops adds Meeting nodes + ATTENDED when configured', async () => {
      const ports = makePorts({
        meeting: {
          isConfigured: jest.fn().mockReturnValue(true),
          listMeetingsForContact: jest.fn().mockResolvedValue({
            items: [
              {
                id: 'mtg-1',
                title: 'Discovery call',
                startedAt: '2026-01-07T00:00:00.000Z',
                endedAt: null,
                durationSeconds: null,
                status: 'transcribed',
                hasSummary: true,
                actionItemCount: 2,
                participants: [],
              },
            ],
            count: 1,
            nextCursor: null,
          }),
        },
      });
      const { svc, sink } = build({ tx: makeTx({ customers: [makeCustomer()] }), ports });
      await svc.backfillWorkspace(WS);
      expect(nodeKeysFor(sink, 'Meeting')).toEqual(['meeting:mtg-1']);
      expect(edgesFor(sink, 'ATTENDED')[0]).toEqual(
        expect.objectContaining({ from: 'person:person-1', to: 'meeting:mtg-1' }),
      );
    });
  });

  describe('degrade-clean federation', () => {
    it('skips a throwing source but still writes the skeleton + other sources', async () => {
      const ports = makePorts({
        // Contact-Ops throws — must be swallowed.
        contact: { getContactSummaries: jest.fn().mockRejectedValue(new Error('CO down')) },
        // Email-Ops is healthy + configured — must still land.
        email: {
          isConfigured: jest.fn().mockReturnValue(true),
          listThreadsWithContact: jest.fn().mockResolvedValue([
            {
              id: 'th-1',
              subject: 'Re: proposal',
              messageCount: 3,
              unread: false,
              lastMessageAt: '2026-01-08T00:00:00.000Z',
              lastSnippet: null,
              participants: [],
            },
          ]),
        },
      });
      const { svc, sink } = build({ tx: makeTx({ customers: [makeCustomer()] }), ports });

      const result = await svc.backfillWorkspace(WS);

      // Did not throw; skeleton present; the healthy source landed.
      expect(nodeKeysFor(sink, 'Deal')).toEqual(['deal:cust-1']);
      expect(nodeKeysFor(sink, 'Email')).toEqual(['email:th-1']);
      expect(result.nodes).toBeGreaterThan(0);
    });
  });

  describe('upsertCustomer (single-customer incremental)', () => {
    it('builds the one customer subgraph and merges it', async () => {
      const tx = makeTx({ oneCustomer: makeCustomer({ id: 'cust-9', contactId: 'person-9' }) });
      const { svc, sink } = build({ tx });

      await svc.upsertCustomer(WS, 'cust-9');

      expect(tx.customer.findFirst).toHaveBeenCalledWith({ where: { id: 'cust-9' } });
      expect(nodeKeysFor(sink, 'Deal')).toEqual(['deal:cust-9']);
      expect(nodeKeysFor(sink, 'Person')).toContain('person:person-9');
    });

    it('no-ops when the customer is not visible (RLS) / deleted', async () => {
      const tx = makeTx({ oneCustomer: null });
      const { svc, sink } = build({ tx });
      await svc.upsertCustomer(WS, 'missing');
      // Only index DDL may run; no node/edge batch is written.
      expect(sink.filter((c) => c.params?.rows)).toHaveLength(0);
    });

    it('swallows a read error (best-effort behind a committed write)', async () => {
      const tx = makeTx({});
      tx.customer.findFirst = jest.fn().mockRejectedValue(new Error('db blip'));
      const { svc } = build({ tx });
      await expect(svc.upsertCustomer(WS, 'cust-1')).resolves.toBeUndefined();
    });
  });
});

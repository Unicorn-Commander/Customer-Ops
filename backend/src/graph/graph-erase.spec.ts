/**
 * GraphService erasure primitives (GDPR data lifecycle) — deleteNodesByKeys +
 * purgeWorkspaceGraph, and the GraphIngestService domain wrappers over them.
 *
 * Runs the REAL GraphService over a FAKE FalkorDbService that records every
 * Cypher query + params (and a delete() call), so we assert the ACTUAL DETACH
 * DELETE the erasure emits — the tenant tripwire (workspaceId in the MATCH), the
 * stable node keys, and the degrade-clean posture (dormant → clean no-op, no
 * throw). No real FalkorDB is touched.
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

const WS = '0190a000-7e57-7000-8000-00000000c007';
const KEY = graphKeyFor(WS);

interface Captured {
  cypher: string;
  params?: Record<string, any>;
}

function makeFalkor(configured: boolean, sink: Captured[], onDelete?: () => void): FalkorDbService {
  const graphHandle = {
    query: jest.fn(async (cypher: string, opts?: { params?: Record<string, any> }) => {
      sink.push({ cypher, params: opts?.params });
      return { data: [] };
    }),
    delete: jest.fn(async () => {
      onDelete?.();
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

describe('GraphService erasure primitives', () => {
  describe('deleteNodesByKeys', () => {
    it('DETACH DELETEs the given keys with the workspaceId tripwire', async () => {
      const sink: Captured[] = [];
      const svc = new GraphService(makeFalkor(true, sink));

      const n = await svc.deleteNodesByKeys(KEY, ['person:contact-1', 'deal:cust-1']);

      expect(n).toBe(2);
      expect(sink).toHaveLength(1);
      expect(sink[0].cypher).toMatch(/DETACH DELETE/);
      // Tenant re-asserted in the MATCH (defense-in-depth) — never a bare key match.
      expect(sink[0].cypher).toMatch(/workspaceId: \$workspaceId/);
      expect(sink[0].params).toEqual({
        keys: ['person:contact-1', 'deal:cust-1'],
        workspaceId: WS,
      });
    });

    it('is a clean no-op (0, no query) when the graph is dormant', async () => {
      const sink: Captured[] = [];
      const svc = new GraphService(makeFalkor(false, sink));

      const n = await svc.deleteNodesByKeys(KEY, ['person:contact-1']);

      expect(n).toBe(0);
      expect(sink).toHaveLength(0);
    });

    it('skips empty/blank keys and returns 0 without a query', async () => {
      const sink: Captured[] = [];
      const svc = new GraphService(makeFalkor(true, sink));

      expect(await svc.deleteNodesByKeys(KEY, [])).toBe(0);
      expect(await svc.deleteNodesByKeys(KEY, ['', '   '])).toBe(0);
      expect(sink).toHaveLength(0);
    });
  });

  describe('purgeWorkspaceGraph', () => {
    it('drops the whole per-workspace graph via GRAPH.DELETE', async () => {
      let deleted = false;
      const svc = new GraphService(makeFalkor(true, [], () => (deleted = true)));

      const ok = await svc.purgeWorkspaceGraph(KEY);

      expect(ok).toBe(true);
      expect(deleted).toBe(true);
    });

    it('is a clean no-op (false) when dormant', async () => {
      const svc = new GraphService(makeFalkor(false, []));
      expect(await svc.purgeWorkspaceGraph(KEY)).toBe(false);
    });
  });
});

// ── domain wrappers on GraphIngestService (they own the key scheme) ───────────

function makeIngest(falkor: FalkorDbService): GraphIngestService {
  const graph = new GraphService(falkor);
  const workspaces = {} as unknown as WorkspaceContextService;
  const prisma = {} as unknown as PrismaService;
  const noop = {} as any;
  return new GraphIngestService(
    falkor,
    graph,
    workspaces,
    prisma,
    noop as ContactOpsPort,
    noop as MeetingOpsPort,
    noop as AccountingOpsPort,
    noop as OutreachPort,
    noop as EmailOpsPort,
  );
}

describe('GraphIngestService erasure wrappers', () => {
  it('eraseCustomer targets person:<contactId> + deal:<customerId>', async () => {
    const sink: Captured[] = [];
    const ingest = makeIngest(makeFalkor(true, sink));

    const n = await ingest.eraseCustomer(WS, 'contact-1', 'cust-1');

    expect(n).toBe(2);
    expect(sink[0].params?.keys).toEqual(['person:contact-1', 'deal:cust-1']);
  });

  it('eraseCustomer no-ops (0) when the graph is dormant', async () => {
    const sink: Captured[] = [];
    const ingest = makeIngest(makeFalkor(false, sink));
    expect(await ingest.eraseCustomer(WS, 'contact-1', 'cust-1')).toBe(0);
    expect(sink).toHaveLength(0);
  });

  it('purgeWorkspace drops the graph when live, no-ops when dormant', async () => {
    let deleted = false;
    const live = makeIngest(makeFalkor(true, [], () => (deleted = true)));
    expect(await live.purgeWorkspace(WS)).toBe(true);
    expect(deleted).toBe(true);

    const dormant = makeIngest(makeFalkor(false, []));
    expect(await dormant.purgeWorkspace(WS)).toBe(false);
  });
});

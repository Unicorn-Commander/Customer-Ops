/**
 * GraphService — the write primitives over the per-workspace knowledge graph.
 *
 * SCOPE (Phase 0-1 foundation): the injection-safe WRITE building blocks only —
 * index creation, single-node + single-edge upsert, and an UNWIND batch helper.
 * The domain ingest (mapping a Customer/Deal/federated entity onto these calls)
 * and the read/query + controller land in later phases; their method signatures
 * are listed in the handoff so they compose cleanly on top of these.
 *
 * INVARIANTS this layer enforces so callers can't get them wrong:
 *   1. TENANCY — `graphKey` MUST be produced by graphKeyFor(workspaceId) (the
 *      chokepoint). On top of the per-workspace graph isolation, EVERY node/edge
 *      is stamped with a redundant `workspaceId` property (defense-in-depth — a
 *      query can re-assert the tenant; a stray cross-graph write is still wrong
 *      but also detectable).
 *   2. IDEMPOTENCY — writes are MERGE-based and keyed on the natural `key`, so a
 *      replay updates in place (never duplicates). `createdAt` is stamped ON
 *      CREATE only; `updatedAt` on every write.
 *   3. INJECTION-SAFETY — labels/edge-types are validated against the closed
 *      vocab (graph.types) and interpolated ONLY after that check; ALL VALUES go
 *      through Cypher `$params`, never string interpolation. (Cypher can't
 *      parameterize a label/relationship-type, hence the allow-list gate — the
 *      same shape as validating an enum before it touches a query.)
 *
 * DEGRADE-CLEAN: these are WRITE primitives — when FalkorDB is dormant
 * FalkorDbService.graph() throws ServiceUnavailableException and that propagates
 * (an ingest caller decides whether a missing graph is fatal or skippable; the
 * cockpit READ path checks isConfigured and never calls these when dormant).
 */

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { FalkorDbService } from './falkordb.service';
import {
  EdgeProps,
  EdgeType,
  GraphDataDTO,
  GraphEdgeDTO,
  GraphNodeDTO,
  GraphProps,
  isEdgeType,
  isNodeLabel,
  kindToRendererType,
  NodeDetailDTO,
  NodeDetailLine,
  NodeLabel,
  NodeProps,
} from './graph.types';
import type { Stage } from './graph.stage';
import {
  NEIGHBORHOOD_DEFAULT_DEPTH,
  NEIGHBORHOOD_DEFAULT_LIMIT,
  NEIGHBORHOOD_MAX_DEPTH,
  NEIGHBORHOOD_MAX_LIMIT,
} from './dto/graph-query.dto';

/** One node in an UNWIND batch upsert: its `key` + the props to SET. */
export interface NodeUpsert {
  key: string;
  props?: NodeProps;
}

/** One edge in an UNWIND batch upsert. `fromKey`/`toKey` reference node `key`s. */
export interface EdgeUpsert {
  fromKey: string;
  toKey: string;
  props?: EdgeProps;
}

@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);

  constructor(private readonly falkor: FalkorDbService) {}

  // ── indexes ───────────────────────────────────────────────────────────────

  /**
   * Create the indexes the graph relies on (idempotent — `IF NOT EXISTS`). A
   * range index on `key` per label makes the MERGE-on-`{key}` upserts fast (the
   * hot path), and a `workspaceId` index supports the defensive tenant-scoped
   * reads later phases run. Safe to call on every boot / before a batch.
   *
   * Index DDL is parameter-free + built only from the validated label vocab, so
   * there is no injection surface.
   */
  async ensureIndexes(graphKey: string): Promise<void> {
    const g = this.falkor.graph(graphKey);
    for (const label of indexedLabels()) {
      // FalkorDB: CREATE INDEX IF NOT EXISTS FOR (n:Label) ON (n.key)
      await g.query(`CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.key)`);
      await g.query(`CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.workspaceId)`);
    }
  }

  // ── single upserts ──────────────────────────────────────────────────────────

  /**
   * Upsert ONE node: MERGE on `{key}`, stamp `createdAt` ON CREATE, then SET the
   * redundant `workspaceId`, the caller props, and `updatedAt` on every write.
   *
   * The label is validated against the closed vocab BEFORE it is interpolated
   * (Cypher can't parameterize a label); `key`, `workspaceId`, the timestamp, and
   * every caller prop are passed as `$params` — injection-safe.
   *
   * @returns the node's `key` (echoed for batch/caller convenience).
   */
  async upsertNode(
    graphKey: string,
    label: NodeLabel,
    key: string,
    props: NodeProps = {},
  ): Promise<string> {
    assertLabel(label);
    assertKey(key, 'upsertNode key');
    const workspaceId = workspaceIdFromKey(graphKey);
    const g = this.falkor.graph(graphKey);
    const now = new Date().toISOString();

    // MERGE de-dupes on key; ON CREATE stamps createdAt once; SET applies the
    // tenant stamp + caller props + updatedAt every time. `+= $props` merges the
    // caller map without clobbering unrelated existing props.
    const cypher = `
      MERGE (n:${label} { key: $key })
      ON CREATE SET n.createdAt = $now
      SET n.workspaceId = $workspaceId, n += $props, n.updatedAt = $now
      RETURN n.key AS key`;

    await g.query(cypher, {
      params: { key, now, workspaceId, props: sanitizeProps(props) },
    });
    return key;
  }

  /**
   * Upsert ONE edge `(:* {key:fromKey})-[:EDGE]->(:* {key:toKey})`: MERGE the
   * relationship, stamp `since` ON CREATE, and SET `weight`/`workspaceId`/caller
   * props + `updatedAt` on every write. The endpoint nodes are MERGE-ensured
   * (label-agnostic) so an edge can be written before/independently of a typed
   * node upsert; a later upsertNode refines the same node by `key`.
   *
   * Edge type is validated against the closed vocab before interpolation; all
   * values (`fromKey`, `toKey`, props, timestamps) are `$params`.
   */
  async upsertEdge(
    graphKey: string,
    fromKey: string,
    edgeType: EdgeType,
    toKey: string,
    props: EdgeProps = {},
  ): Promise<void> {
    assertEdgeType(edgeType);
    assertKey(fromKey, 'upsertEdge fromKey');
    assertKey(toKey, 'upsertEdge toKey');
    const workspaceId = workspaceIdFromKey(graphKey);
    const g = this.falkor.graph(graphKey);
    const now = new Date().toISOString();

    // Ensure both endpoints exist (label-agnostic MERGE on key) so edge writes are
    // order-independent; stamp the endpoints' workspaceId too (tenant invariant).
    const cypher = `
      MERGE (a { key: $fromKey }) ON CREATE SET a.workspaceId = $workspaceId
      MERGE (b { key: $toKey })   ON CREATE SET b.workspaceId = $workspaceId
      MERGE (a)-[r:${edgeType}]->(b)
      ON CREATE SET r.since = $now
      SET r.workspaceId = $workspaceId, r += $props, r.updatedAt = $now`;

    await g.query(cypher, {
      params: { fromKey, toKey, now, workspaceId, props: sanitizeProps(props) },
    });
  }

  // ── batch (UNWIND) ──────────────────────────────────────────────────────────

  /**
   * Batch-upsert many nodes of ONE label in a single round-trip via UNWIND — the
   * ingest hot path (one query for N nodes instead of N queries). Same MERGE /
   * createdAt-on-create / SET-tenant+props+updatedAt semantics as upsertNode.
   *
   * The label is allow-list-validated once; the whole batch rides as a single
   * `$rows` parameter (each row's key/props is data, never interpolated).
   *
   * @returns the count of rows submitted.
   */
  async upsertNodesBatch(
    graphKey: string,
    label: NodeLabel,
    nodes: NodeUpsert[],
  ): Promise<number> {
    assertLabel(label);
    if (nodes.length === 0) return 0;
    const workspaceId = workspaceIdFromKey(graphKey);
    const g = this.falkor.graph(graphKey);
    const now = new Date().toISOString();

    const rows = nodes.map((n) => {
      assertKey(n.key, 'upsertNodesBatch key');
      return { key: n.key, props: sanitizeProps(n.props ?? {}) };
    });

    const cypher = `
      UNWIND $rows AS row
      MERGE (n:${label} { key: row.key })
      ON CREATE SET n.createdAt = $now
      SET n.workspaceId = $workspaceId, n += row.props, n.updatedAt = $now`;

    await g.query(cypher, { params: { rows, now, workspaceId } });
    return rows.length;
  }

  /**
   * Batch-upsert many edges of ONE type in a single round-trip via UNWIND. Same
   * MERGE / since-on-create / SET-tenant+props+updatedAt semantics as upsertEdge,
   * including ensuring both endpoints exist (label-agnostic) so the batch is
   * order-independent.
   *
   * @returns the count of rows submitted.
   */
  async upsertEdgesBatch(
    graphKey: string,
    edgeType: EdgeType,
    edges: EdgeUpsert[],
  ): Promise<number> {
    assertEdgeType(edgeType);
    if (edges.length === 0) return 0;
    const workspaceId = workspaceIdFromKey(graphKey);
    const g = this.falkor.graph(graphKey);
    const now = new Date().toISOString();

    const rows = edges.map((e) => {
      assertKey(e.fromKey, 'upsertEdgesBatch fromKey');
      assertKey(e.toKey, 'upsertEdgesBatch toKey');
      return { fromKey: e.fromKey, toKey: e.toKey, props: sanitizeProps(e.props ?? {}) };
    });

    const cypher = `
      UNWIND $rows AS row
      MERGE (a { key: row.fromKey }) ON CREATE SET a.workspaceId = $workspaceId
      MERGE (b { key: row.toKey })   ON CREATE SET b.workspaceId = $workspaceId
      MERGE (a)-[r:${edgeType}]->(b)
      ON CREATE SET r.since = $now
      SET r.workspaceId = $workspaceId, r += row.props, r.updatedAt = $now`;

    await g.query(cypher, { params: { rows, now, workspaceId } });
    return rows.length;
  }

  // ── reads (the cockpit query surface) ───────────────────────────────────────
  //
  // DEGRADE-CLEAN: every read first asserts the graph is wired. When FalkorDB is
  // dormant (FALKORDB_URL unset / connect failed) these throw
  // ServiceUnavailableException, which the controller lets surface as 503 — the
  // frontend then falls back to its DB-derived relationship view. (We pre-check
  // isConfigured rather than relying on graph()'s throw so the contract is
  // explicit at the read entry-point and identical across all three readers.)
  //
  // All reads go through roQuery (read-only; lets FalkorDB route to a replica)
  // and re-assert the tenant via the redundant `workspaceId` property in the
  // MATCH — defense-in-depth alongside the per-workspace graph key. Cypher RETURNs
  // the scalar fields we need (key/label/stage/weight) directly instead of whole
  // node objects, so the mapping doesn't depend on the client's node-object shape.

  /**
   * The top-level constellation for the cockpit center: the workspace Hub + the
   * Orgs it connects to + the top People, read from the PERSISTED graph. Caps at
   * 10 orgs + 28 people, each set ordered by connecting-edge `weight` desc (the
   * strongest relationships first / biggest nodes). Every node is mapped through
   * kindToRendererType so labels collapse to the four render shapes; the Hub is
   * synthesized into the payload as the constellation root.
   *
   * @throws ServiceUnavailableException when the graph is dormant (→ 503 → the
   *   frontend's DB-only fallback).
   */
  async getWorkspaceGraph(graphKey: string): Promise<GraphDataDTO> {
    this.assertGraphAvailable();
    const workspaceId = workspaceIdFromKey(graphKey);
    const g = this.falkor.graph(graphKey);

    // The Hub is the synthetic per-workspace root. We read it (for its display
    // label) but always emit it even if a writer hasn't materialized one yet.
    const hubReply = await g.roQuery<{ key: string; label: string | null }>(
      `MATCH (h:Hub { workspaceId: $workspaceId })
       RETURN h.key AS key, h.label AS label
       LIMIT 1`,
      { params: { workspaceId } },
    );
    const hubRow = hubReply.data?.[0];
    const hubKey = hubRow?.key ?? `hub:${workspaceId}`;
    const hubNode: GraphNodeDTO = {
      id: hubKey,
      label: hubRow?.label ?? 'Workspace',
      type: 'hub',
    };

    // Top Orgs by the Hub→Org / Org-incident edge weight. We anchor on the Hub
    // when present, else fall back to every Org in the workspace (a graph may be
    // populated org-first before a Hub edge exists). Order by the max incident
    // edge weight so the strongest relationships are the biggest nodes.
    const orgReply = await g.roQuery<GraphRow>(
      `MATCH (o:Org { workspaceId: $workspaceId })
       OPTIONAL MATCH (o)-[r { workspaceId: $workspaceId }]-()
       WITH o, max(coalesce(r.weight, 0)) AS w
       RETURN o.key AS key, labels(o)[0] AS nodeLabel, o.label AS displayLabel,
              o.stage AS stage, w AS weight
       ORDER BY w DESC, o.key ASC
       LIMIT $cap`,
      { params: { workspaceId, cap: WORKSPACE_ORG_CAP } },
    );

    // Top People by their strongest incident edge weight (same ordering intent).
    const personReply = await g.roQuery<GraphRow>(
      `MATCH (p:Person { workspaceId: $workspaceId })
       OPTIONAL MATCH (p)-[r { workspaceId: $workspaceId }]-()
       WITH p, max(coalesce(r.weight, 0)) AS w
       RETURN p.key AS key, labels(p)[0] AS nodeLabel, p.label AS displayLabel,
              p.stage AS stage, w AS weight
       ORDER BY w DESC, p.key ASC
       LIMIT $cap`,
      { params: { workspaceId, cap: WORKSPACE_PERSON_CAP } },
    );

    const nodeMap = new Map<string, GraphNodeDTO>();
    nodeMap.set(hubNode.id, hubNode);
    for (const row of orgReply.data ?? []) {
      const n = rowToNode(row);
      if (n) nodeMap.set(n.id, n);
    }
    for (const row of personReply.data ?? []) {
      const n = rowToNode(row);
      if (n) nodeMap.set(n.id, n);
    }

    // Edges AMONG the selected nodes only (so the rendered graph stays connected
    // to what we returned — no dangling endpoints). One round-trip with the kept
    // key set; de-dupe undirected pairs the same way the cockpit draws them.
    const keptKeys = [...nodeMap.keys()];
    const edges = await this.edgesAmong(g, workspaceId, keptKeys);

    return { nodes: [...nodeMap.values()], edges };
  }

  /**
   * The 1..`depth` neighborhood of one node, for the cockpit's expand-on-click.
   * MATCHes the focus node by `{ key }` AND the `workspaceId` tripwire (a node
   * from another tenant — impossible via the per-workspace key, but re-asserted —
   * yields an empty graph, never a cross-tenant leak), then its variable-length
   * neighborhood, LIMITed. Returns the focus + neighbors + the edges among them,
   * all mapped to the DTO.
   *
   * @param depth hops to traverse (defaulted + clamped to [1, NEIGHBORHOOD_MAX_DEPTH]).
   * @param limit max neighbor nodes (defaulted + clamped to [1, NEIGHBORHOOD_MAX_LIMIT]).
   * @throws ServiceUnavailableException when the graph is dormant.
   */
  async getNeighborhood(
    graphKey: string,
    nodeKey: string,
    depth: number = NEIGHBORHOOD_DEFAULT_DEPTH,
    limit: number = NEIGHBORHOOD_DEFAULT_LIMIT,
  ): Promise<GraphDataDTO> {
    this.assertGraphAvailable();
    assertKey(nodeKey, 'getNeighborhood nodeKey');
    const workspaceId = workspaceIdFromKey(graphKey);
    const g = this.falkor.graph(graphKey);

    // Clamp depth/limit defensively even though the DTO validates them — this
    // method is also called by services/tests that bypass the pipe, and the depth
    // is interpolated into the pattern (it CANNOT be a Cypher param), so it MUST
    // be a vetted integer. clampInt floors + bounds it; never reaches Cypher raw.
    const d = clampInt(depth, 1, NEIGHBORHOOD_MAX_DEPTH, NEIGHBORHOOD_DEFAULT_DEPTH);
    const lim = clampInt(limit, 1, NEIGHBORHOOD_MAX_LIMIT, NEIGHBORHOOD_DEFAULT_LIMIT);

    // Focus node first (so an expand on an isolated node still returns it). The
    // tenant tripwire is on the focus MATCH; the variable-length hop stays within
    // the same per-workspace graph by construction.
    const focusReply = await g.roQuery<GraphRow>(
      `MATCH (f { key: $nodeKey, workspaceId: $workspaceId })
       RETURN f.key AS key, labels(f)[0] AS nodeLabel, f.label AS displayLabel,
              f.stage AS stage, f.weight AS weight
       LIMIT 1`,
      { params: { nodeKey, workspaceId } },
    );
    const focusRow = focusReply.data?.[0];
    if (!focusRow) {
      // Unknown / wrong-tenant key → empty graph (not an error): the cockpit just
      // shows nothing to expand.
      return { nodes: [], edges: [] };
    }

    // The neighborhood: distinct nodes reachable in 1..d hops, capped. `*1..d`
    // bounds the traversal; d is the clamped integer above (safe to interpolate).
    const neighReply = await g.roQuery<GraphRow>(
      `MATCH (f { key: $nodeKey, workspaceId: $workspaceId })-[*1..${d}]-(m)
       WHERE m.workspaceId = $workspaceId
       WITH DISTINCT m
       RETURN m.key AS key, labels(m)[0] AS nodeLabel, m.label AS displayLabel,
              m.stage AS stage, m.weight AS weight
       LIMIT $lim`,
      { params: { nodeKey, workspaceId, lim } },
    );

    const nodeMap = new Map<string, GraphNodeDTO>();
    const focusNode = rowToNode(focusRow);
    if (focusNode) nodeMap.set(focusNode.id, focusNode);
    for (const row of neighReply.data ?? []) {
      const n = rowToNode(row);
      if (n) nodeMap.set(n.id, n);
    }

    const edges = await this.edgesAmong(g, workspaceId, [...nodeMap.keys()]);
    return { nodes: [...nodeMap.values()], edges };
  }

  /**
   * Real aggregate detail for the inspector drawer, keyed on node label:
   *   - Org    → connected-people count, summed connected Deal expectedValue
   *              (the pipeline behind the org), and last touch (max incident
   *              edge `since`).
   *   - Person → interaction count (ATTENDED|EMAILED|TOUCHED_BY edges) + last
   *              touch (max `since` over those interactions).
   *   - Hub    → workspace rollup: People count, open-pipeline sum (Deals where
   *              NOT isLost), and customer count (Person stage = CUSTOMER).
   * Anything else gets a generic label/type with no lines (forward-compat).
   *
   * @throws ServiceUnavailableException when the graph is dormant.
   */
  async getNodeDetail(graphKey: string, nodeKey: string): Promise<NodeDetailDTO> {
    this.assertGraphAvailable();
    assertKey(nodeKey, 'getNodeDetail nodeKey');
    const workspaceId = workspaceIdFromKey(graphKey);
    const g = this.falkor.graph(graphKey);

    // Resolve the node's label + display first (tenant tripwire on the MATCH).
    const baseReply = await g.roQuery<{ label: string; displayLabel: string | null }>(
      `MATCH (n { key: $nodeKey, workspaceId: $workspaceId })
       RETURN labels(n)[0] AS label, n.label AS displayLabel
       LIMIT 1`,
      { params: { nodeKey, workspaceId } },
    );
    const base = baseReply.data?.[0];
    if (!base) {
      // Unknown / wrong-tenant key → a minimal, honest payload (no fabricated
      // aggregates) rather than a 404 — the cockpit drawer degrades gracefully.
      return { id: nodeKey, label: nodeKey, type: 'interaction', lines: [] };
    }

    const nodeLabel = base.label;
    const type = kindToRendererType(nodeLabel);
    const display = base.displayLabel ?? nodeKey;
    let lines: NodeDetailLine[] = [];

    if (nodeLabel === 'Org') {
      lines = await this.orgDetailLines(g, workspaceId, nodeKey);
    } else if (nodeLabel === 'Person') {
      lines = await this.personDetailLines(g, workspaceId, nodeKey);
    } else if (nodeLabel === 'Hub') {
      lines = await this.hubDetailLines(g, workspaceId);
    }

    return { id: nodeKey, label: display, type, lines };
  }

  // ── read helpers (module-internal query shapes) ─────────────────────────────

  /**
   * The graph-availability gate every read calls first. Throws the same
   * ServiceUnavailableException FalkorDbService.graph() would, but at the read
   * entry-point so the degrade-clean contract is explicit + uniform. The
   * controller does not catch it → Nest serializes it as a 503 → the frontend
   * falls back to its DB-derived graph.
   */
  private assertGraphAvailable(): void {
    if (!this.falkor.isConfigured) {
      throw new ServiceUnavailableException(
        'Knowledge graph is not available (FalkorDB dormant). The relationship ' +
          'cockpit falls back to the DB-only view.',
      );
    }
  }

  /**
   * Edges whose BOTH endpoints are in `keys` — so a returned graph never has a
   * dangling edge to a node we didn't include. One round-trip; the undirected
   * pair is de-duped (the cockpit draws edges undirected, and an UNWIND over the
   * key set would otherwise yield A→B and B→A separately).
   */
  private async edgesAmong(
    g: ReturnType<FalkorDbService['graph']>,
    workspaceId: string,
    keys: string[],
  ): Promise<GraphEdgeDTO[]> {
    if (keys.length < 2) return [];
    const reply = await g.roQuery<{ from: string; to: string }>(
      `MATCH (a)-[r { workspaceId: $workspaceId }]->(b)
       WHERE a.key IN $keys AND b.key IN $keys
       RETURN DISTINCT a.key AS from, b.key AS to`,
      { params: { workspaceId, keys } },
    );
    const seen = new Set<string>();
    const edges: GraphEdgeDTO[] = [];
    for (const row of reply.data ?? []) {
      if (!row?.from || !row?.to || row.from === row.to) continue;
      // De-dupe undirected: a stable unordered pair key.
      const pair = row.from < row.to ? `${row.from} ${row.to}` : `${row.to} ${row.from}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      edges.push({ from: row.from, to: row.to });
    }
    return edges;
  }

  /** Org aggregates: connected people, pipeline behind it, last touch. */
  private async orgDetailLines(
    g: ReturnType<FalkorDbService['graph']>,
    workspaceId: string,
    nodeKey: string,
  ): Promise<NodeDetailLine[]> {
    const peopleReply = await g.roQuery<{ n: number }>(
      `MATCH (o:Org { key: $nodeKey, workspaceId: $workspaceId })-[{ workspaceId: $workspaceId }]-(p:Person)
       RETURN count(DISTINCT p) AS n`,
      { params: { nodeKey, workspaceId } },
    );
    const dealReply = await g.roQuery<{ total: number | null; n: number }>(
      `MATCH (o:Org { key: $nodeKey, workspaceId: $workspaceId })-[{ workspaceId: $workspaceId }]-(d:Deal)
       RETURN sum(coalesce(d.expectedValue, 0)) AS total, count(DISTINCT d) AS n`,
      { params: { nodeKey, workspaceId } },
    );
    const touchReply = await g.roQuery<{ last: string | null }>(
      `MATCH (o:Org { key: $nodeKey, workspaceId: $workspaceId })-[r { workspaceId: $workspaceId }]-()
       RETURN max(r.since) AS last`,
      { params: { nodeKey, workspaceId } },
    );

    const people = numOf(peopleReply.data?.[0]?.n);
    const dealCount = numOf(dealReply.data?.[0]?.n);
    const pipeline = numOf(dealReply.data?.[0]?.total);
    const last = touchReply.data?.[0]?.last ?? null;

    return [
      { label: 'Connected people', value: formatCount(people) },
      { label: 'Open deals', value: formatCount(dealCount) },
      { label: 'Pipeline value', value: formatMoney(pipeline) },
      { label: 'Last touch', value: formatDate(last) },
    ];
  }

  /** Person aggregates: interaction count + last touch over interaction edges. */
  private async personDetailLines(
    g: ReturnType<FalkorDbService['graph']>,
    workspaceId: string,
    nodeKey: string,
  ): Promise<NodeDetailLine[]> {
    // Interactions = the relationship verbs that represent a touch with the
    // person: attended a meeting, exchanged email, was touched by a campaign.
    const reply = await g.roQuery<{ n: number; last: string | null }>(
      `MATCH (p:Person { key: $nodeKey, workspaceId: $workspaceId })
             -[r:ATTENDED|EMAILED|TOUCHED_BY { workspaceId: $workspaceId }]-()
       RETURN count(r) AS n, max(r.since) AS last`,
      { params: { nodeKey, workspaceId } },
    );
    const n = numOf(reply.data?.[0]?.n);
    const last = reply.data?.[0]?.last ?? null;
    return [
      { label: 'Interactions', value: formatCount(n) },
      { label: 'Last touch', value: formatDate(last) },
    ];
  }

  /** Hub rollup: workspace people, open pipeline (non-lost deals), customers. */
  private async hubDetailLines(
    g: ReturnType<FalkorDbService['graph']>,
    workspaceId: string,
  ): Promise<NodeDetailLine[]> {
    const peopleReply = await g.roQuery<{ n: number }>(
      `MATCH (p:Person { workspaceId: $workspaceId }) RETURN count(p) AS n`,
      { params: { workspaceId } },
    );
    const pipelineReply = await g.roQuery<{ total: number | null }>(
      `MATCH (d:Deal { workspaceId: $workspaceId })
       WHERE coalesce(d.isLost, false) = false
       RETURN sum(coalesce(d.expectedValue, 0)) AS total`,
      { params: { workspaceId } },
    );
    const customerReply = await g.roQuery<{ n: number }>(
      `MATCH (p:Person { workspaceId: $workspaceId })
       WHERE p.stage = 'CUSTOMER'
       RETURN count(p) AS n`,
      { params: { workspaceId } },
    );

    const people = numOf(peopleReply.data?.[0]?.n);
    const pipeline = numOf(pipelineReply.data?.[0]?.total);
    const customers = numOf(customerReply.data?.[0]?.n);

    return [
      { label: 'People', value: formatCount(people) },
      { label: 'Customers', value: formatCount(customers) },
      { label: 'Open pipeline', value: formatMoney(pipeline) },
    ];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// read caps + row mapping (module-private; the cockpit projection floor)
// ─────────────────────────────────────────────────────────────────────────────

/** Top-level constellation caps (per the brief): orgs 10, people 28. */
const WORKSPACE_ORG_CAP = 10;
const WORKSPACE_PERSON_CAP = 28;

/**
 * A node row as the read Cypher RETURNs it — scalar columns, not a node object.
 * `key` is the FalkorDB node key (→ DTO `id`); `nodeLabel` is the Cypher label
 * (→ render type); `displayLabel` is the cheap display string; `stage`/`weight`
 * are optional tints/sizes. We RETURN scalars so the mapping doesn't depend on
 * the client's node-object deserialization shape.
 */
interface GraphRow {
  key: string;
  nodeLabel: string | null;
  displayLabel: string | null;
  stage: string | null;
  weight: number | null;
}

/** The funnel stages a node may carry (matches Stage); used to filter `stage`. */
const STAGE_SET: ReadonlySet<string> = new Set<Stage>(['LEAD', 'PROSPECT', 'CUSTOMER']);

/**
 * Map a scalar query row → a GraphNodeDTO. Drops rows without a usable `key`
 * (defensive). The label collapses via kindToRendererType (unknown → the inert
 * 'interaction' shape); `stage` is only carried when it's a real funnel stage,
 * and `weight` only when it's a finite number (0 stays meaningful for sizing).
 */
function rowToNode(row: GraphRow | undefined | null): GraphNodeDTO | null {
  if (!row || typeof row.key !== 'string' || !row.key) return null;
  const node: GraphNodeDTO = {
    id: row.key,
    label: row.displayLabel ?? row.key,
    type: kindToRendererType(row.nodeLabel ?? ''),
  };
  if (typeof row.stage === 'string' && STAGE_SET.has(row.stage)) {
    node.stage = row.stage as Stage;
  }
  if (typeof row.weight === 'number' && Number.isFinite(row.weight)) {
    node.weight = row.weight;
  }
  return node;
}

/** Coerce a (possibly null/Float) aggregate to a finite number, defaulting 0. */
function numOf(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Floor + bound an integer into [min,max], falling back to `fallback` on NaN. */
function clampInt(v: number, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// ── display formatters (the backend pre-formats; the frontend renders verbatim) ─

/** A plain integer count (e.g. `3`). */
function formatCount(n: number): string {
  return String(Math.trunc(numOf(n)));
}

/** A USD-ish money string (e.g. `$1,500`). Whole-dollar; the cockpit shows a
 *  headline figure, not ledger precision (the ledger SoR is Accounting-Ops). */
function formatMoney(n: number): string {
  const v = Math.round(numOf(n));
  return `$${v.toLocaleString('en-US')}`;
}

/** An ISO timestamp → `YYYY-MM-DD`, or `—` when there's no touch yet. */
function formatDate(iso: string | null | undefined): string {
  if (!iso || typeof iso !== 'string') return '—';
  // Keep just the date part of an ISO-8601 string; if it isn't ISO, show as-is.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

// ─────────────────────────────────────────────────────────────────────────────
// internal guards + helpers (module-private; the injection-safety + tenancy floor)
// ─────────────────────────────────────────────────────────────────────────────

/** The labels we maintain `key`/`workspaceId` indexes on (every real node label;
 *  Hub is a singleton root so it doesn't need one, but indexing it is harmless). */
function indexedLabels(): NodeLabel[] {
  return [
    'Person',
    'Org',
    'Deal',
    'Meeting',
    'Email',
    'Invoice',
    'Campaign',
    'Project',
    'Doc',
    'Product',
    'LeadSource',
    'Hub',
  ];
}

/** Allow-list gate for a node label before it is interpolated into Cypher. */
function assertLabel(label: string): asserts label is NodeLabel {
  if (!isNodeLabel(label)) {
    throw new Error(`Invalid graph node label: ${JSON.stringify(label)}`);
  }
}

/** Allow-list gate for an edge type before it is interpolated into Cypher. */
function assertEdgeType(edgeType: string): asserts edgeType is EdgeType {
  if (!isEdgeType(edgeType)) {
    throw new Error(`Invalid graph edge type: ${JSON.stringify(edgeType)}`);
  }
}

/** A node `key` must be a non-empty string (it's the MERGE identity). */
function assertKey(key: unknown, what: string): asserts key is string {
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error(`${what} must be a non-empty string`);
  }
}

/**
 * Derive the tenant id from a graph key produced by graphKeyFor — strip the
 * `cust_ops:ws:` prefix. This keeps the redundant `workspaceId` stamp in lockstep
 * with the graph it's written into WITHOUT re-importing the prefix literal: the
 * key already passed the chokepoint, so its tail IS the canonical workspace id.
 */
function workspaceIdFromKey(graphKey: string): string {
  const idx = graphKey.lastIndexOf(':');
  const id = idx >= 0 ? graphKey.slice(idx + 1) : graphKey;
  if (!id) throw new Error('graphKey has no workspace segment');
  return id;
}

/**
 * Drop `undefined` prop values (FalkorDB rejects an undefined param) and reserved
 * keys a caller must not override — `key`/`createdAt`/`since` are owned by the
 * primitives; `workspaceId`/`updatedAt` are stamped explicitly. Returns a plain
 * map safe to pass as `+= $props`.
 */
function sanitizeProps(props: GraphProps): GraphProps {
  const reserved = new Set(['key', 'createdAt', 'since', 'workspaceId', 'updatedAt']);
  const out: GraphProps = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (reserved.has(k)) continue;
    out[k] = v;
  }
  return out;
}

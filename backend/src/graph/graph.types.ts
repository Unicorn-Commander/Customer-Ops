/**
 * The Customer-Ops knowledge-graph vocabulary + the wire DTOs.
 *
 * The graph is a per-workspace relationship knowledge graph (one FalkorDB graph
 * per workspace — see graph-key.ts). This file is the single source of truth for
 * WHAT can be a node, HOW nodes connect, the universal properties every node/edge
 * carries, and the projection the frontend cockpit renders.
 *
 * Customer-Ops OWNS the relationship topology; it FEDERATES the entity detail
 * (Contact-Ops owns people/orgs, Accounting-Ops owns invoices, Meeting-Ops owns
 * meetings, …). So the graph stores SKELETON nodes — a stable `key` (the foreign
 * id in the owning system) + a cheap display `label` — never the federated body.
 * The render type collapses this rich label set down to the four shapes the
 * <KnowledgeGraph/> SVG knows how to draw.
 */

import type { Stage } from './graph.stage';

// ─────────────────────────────────────────────────────────────────────────────
// NODE LABELS — the Cypher node labels. The graph's "kinds".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The node labels (Cypher `:Label`). `Hub` is the synthetic workspace root every
 * graph hangs off (the cockpit's center). The rest mirror the federated domains
 * Customer-Ops stitches together.
 */
export const NODE_LABELS = [
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
] as const;

export type NodeLabel = (typeof NODE_LABELS)[number];

/** Runtime set for cheap validation of a label coming off the wire / a query. */
export const NODE_LABEL_SET: ReadonlySet<string> = new Set(NODE_LABELS);

export function isNodeLabel(value: unknown): value is NodeLabel {
  return typeof value === 'string' && NODE_LABEL_SET.has(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// EDGE TYPES — the Cypher relationship types. The graph's "verbs".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The relationship types (Cypher `-[:TYPE]->`). Semantic, directional verbs:
 *   - WORKS_AT      (:Person)-[:WORKS_AT]->(:Org)
 *   - IS_CONTACT    (:Hub)-[:IS_CONTACT]->(:Person)        — in the cockpit
 *   - OWNS_DEAL     (:Person|:Org)-[:OWNS_DEAL]->(:Deal)
 *   - ATTENDED      (:Person)-[:ATTENDED]->(:Meeting)
 *   - STAKEHOLDER_ON(:Person)-[:STAKEHOLDER_ON]->(:Deal|:Project)
 *   - DECISION_MAKER(:Person)-[:DECISION_MAKER]->(:Deal|:Org)
 *   - BILLED_FOR    (:Person|:Org)-[:BILLED_FOR]->(:Invoice)
 *   - PAID          (:Person|:Org)-[:PAID]->(:Invoice)
 *   - ENROLLED_IN   (:Person)-[:ENROLLED_IN]->(:Campaign)
 *   - TOUCHED_BY    (:Person)-[:TOUCHED_BY]->(:Campaign|:Email)
 *   - EMAILED       (:Person)-[:EMAILED]->(:Person)
 *   - THREAD_WITH   (:Person)-[:THREAD_WITH]->(:Email)
 *   - MENTIONED_IN  (:Person|:Org)-[:MENTIONED_IN]->(:Meeting|:Doc)
 *   - REFERRED_BY   (:Person)-[:REFERRED_BY]->(:Person|:Org)
 *   - SOURCED_FROM  (:Person)-[:SOURCED_FROM]->(:LeadSource)
 *   - STAGE_EVENT   (:Deal|:Person)-[:STAGE_EVENT]->(:Deal)   — funnel movement
 */
export const EDGE_TYPES = [
  'WORKS_AT',
  'IS_CONTACT',
  'OWNS_DEAL',
  'ATTENDED',
  'STAKEHOLDER_ON',
  'DECISION_MAKER',
  'BILLED_FOR',
  'PAID',
  'ENROLLED_IN',
  'TOUCHED_BY',
  'EMAILED',
  'THREAD_WITH',
  'MENTIONED_IN',
  'REFERRED_BY',
  'SOURCED_FROM',
  'STAGE_EVENT',
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

export const EDGE_TYPE_SET: ReadonlySet<string> = new Set(EDGE_TYPES);

export function isEdgeType(value: unknown): value is EdgeType {
  return typeof value === 'string' && EDGE_TYPE_SET.has(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL PROPERTIES — stamped on EVERY node + edge by the write primitives.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The props every NODE carries, regardless of label. `key` is the natural id in
 * the OWNING system (a Contact-Ops person_id, an AO invoice id, …) and is what
 * MERGE de-dupes on within a graph. `workspaceId` is the redundant tenant stamp
 * (defense-in-depth alongside the per-workspace graph key). `label` is the cheap
 * display string the cockpit shows — the federated body is never copied in.
 */
export interface UniversalNodeProps {
  /** Natural id in the owning system; unique within a graph. MERGE key. */
  key: string;
  /** Redundant tenant stamp (graph key already isolates; this re-asserts it). */
  workspaceId: string;
  /** Cheap display label for the cockpit (NOT the federated detail). */
  label?: string;
  /** ISO-8601; set ON CREATE only. */
  createdAt?: string;
  /** ISO-8601; set on every write. */
  updatedAt?: string;
}

/**
 * The props every EDGE carries. `since` dates the relationship; `weight` drives
 * the cockpit's visual emphasis (edge thickness / node size); `workspaceId` is
 * the same redundant tenant stamp as on nodes.
 */
export interface UniversalEdgeProps {
  workspaceId: string;
  /** ISO-8601; when this relationship was first observed (set ON CREATE). */
  since?: string;
  /** Relative strength of the relationship (cockpit emphasis). */
  weight?: number;
  /** ISO-8601; set on every write. */
  updatedAt?: string;
}

/**
 * A Cypher-serializable property value. Mirrors FalkorDB's `QueryParam`
 * (null | string | number | boolean | nested map | array) — a graph property
 * CANNOT be an arbitrary object, only these JSON-ish scalars/containers. Typing
 * props this way (instead of `unknown`) makes them pass straight into the client's
 * `{ params }` and rejects a non-serializable value at the call site.
 */
export type GraphParamValue = null | string | number | boolean | GraphProps | GraphParamValue[];

/** A map of Cypher-serializable property values. Matches FalkorDB `QueryParams`. */
export interface GraphProps {
  [key: string]: GraphParamValue;
}

/** Arbitrary extra props a caller hands the write primitives (label-specific). */
export type NodeProps = GraphProps;
export type EdgeProps = GraphProps;

// ─────────────────────────────────────────────────────────────────────────────
// RENDER MAPPING — collapse the rich label set to the 4 shapes the SVG draws.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The renderer's node type (matches frontend/components/dashboard/KnowledgeGraph
 * `GraphNodeType`): the FOUR visual shapes the SVG knows. Many labels collapse to
 * one shape.
 */
export type RendererNodeType = 'hub' | 'org' | 'person' | 'interaction';

/**
 * Map a node label → the renderer's visual type. The contract the backend must
 * honor (per the brief):
 *   Hub                                                        → 'hub'
 *   Org                                                        → 'org'
 *   Person, Deal                                               → 'person'
 *   Meeting, Email, Invoice, Campaign, Project, Doc,
 *     Product, LeadSource                                      → 'interaction'
 *
 * Deal→'person' is deliberate: a deal renders as an actor in the relationship
 * orbit (it's owned BY and worked BY people), not as a passive interaction event.
 */
const LABEL_TO_RENDERER: Record<NodeLabel, RendererNodeType> = {
  Hub: 'hub',
  Org: 'org',
  Person: 'person',
  Deal: 'person',
  Meeting: 'interaction',
  Email: 'interaction',
  Invoice: 'interaction',
  Campaign: 'interaction',
  Project: 'interaction',
  Doc: 'interaction',
  Product: 'interaction',
  LeadSource: 'interaction',
};

/**
 * Collapse a node label to its renderer type. An unknown label degrades to
 * 'interaction' (the inert event shape) rather than throwing — a forward-compat
 * label from a newer writer still draws as a generic node instead of breaking the
 * whole graph render.
 */
export function kindToRendererType(label: string): RendererNodeType {
  return LABEL_TO_RENDERER[label as NodeLabel] ?? 'interaction';
}

// ─────────────────────────────────────────────────────────────────────────────
// WIRE DTOs — exactly the shape <KnowledgeGraph/> consumes (frontend contract).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One graph node as the cockpit renders it. MUST stay structurally identical to
 * the frontend `GraphNode` (frontend/components/dashboard/KnowledgeGraph.tsx):
 *   { id, label, type, stage?, weight? }
 */
export interface GraphNodeDTO {
  /** Stable node id the SVG keys on (we use the node `key`). */
  id: string;
  /** Human display label. */
  label: string;
  /** The renderer's visual type. */
  type: RendererNodeType;
  /** Funnel stage tint (people/deals carrying a relationship stage). */
  stage?: Stage;
  /** Relative weight → node size (orgs/deals). */
  weight?: number;
}

/** One graph edge as the cockpit renders it. Matches the frontend `GraphEdge`. */
export interface GraphEdgeDTO {
  from: string;
  to: string;
}

/** The full graph payload. Matches the frontend `GraphData`. */
export interface GraphDataDTO {
  nodes: GraphNodeDTO[];
  edges: GraphEdgeDTO[];
}

/**
 * One labelled fact line in the node-detail drawer — a flat `{ label, value }`
 * pair the cockpit renders verbatim (both already display-ready strings; the
 * backend formats counts/money/dates into the `value` so the frontend stays a
 * dumb renderer).
 */
export interface NodeDetailLine {
  label: string;
  value: string;
}

/**
 * The node-detail payload the cockpit's inspector consumes when a node is
 * focused. MUST stay structurally identical to the frontend `NodeDetail`:
 *   { id, label, type, lines: Array<{ label, value }> }
 *
 * `id` is the FalkorDB node `key`; `type` is the same four-shape renderer type
 * as the graph nodes. `lines` are the real aggregates computed from the
 * persisted graph (connected-people / pipeline / last-touch …) — never fixtures.
 */
export interface NodeDetailDTO {
  /** The FalkorDB node `key` (same id space as GraphNodeDTO.id). */
  id: string;
  /** Human display label. */
  label: string;
  /** The renderer's visual type. */
  type: RendererNodeType;
  /** Ordered, display-ready aggregate lines for the inspector. */
  lines: NodeDetailLine[];
}

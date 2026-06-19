/**
 * Live FalkorDB knowledge-graph data layer (Phase 5).
 *
 * Mirrors the backend's workspace-scoped graph surface
 * (`/workspaces/:workspaceId/graph`). The backend projects the relationship
 * graph out of FalkorDB and returns the SAME `GraphData` shape the 3D renderer
 * already consumes, so the explorer is untouched — only the data source moves
 * from a client-side projection to the real graph store.
 *
 * Node `id` is the backend's STABLE key (e.g. `person:<contactId>`,
 * `org:<orgId>`, `hub`). Drill-down / detail use that key directly; callers must
 * never reconstruct it on the client.
 *
 * Every fetch THROWS on a non-2xx response (apiGet's contract). Callers decide
 * how to degrade — the /dashboard/graph page falls back to the local
 * `deriveGraph` projection when the graph is dormant (503) or unreachable, and
 * the explorer keeps the current view when a drill/detail call fails.
 */

import { apiGet } from './api';
import type { GraphData, GraphNode } from '@/components/dashboard/KnowledgeGraph';

/** A node inspection result, fetched live from the graph store. The renderer's
 *  detail panel consumes `lines` directly. */
export interface NodeDetail {
  id: string;
  label: string;
  type: GraphNode['type'];
  lines: Array<{ label: string; value: string }>;
}

function base(ws: string): string {
  return `/workspaces/${encodeURIComponent(ws)}/graph`;
}

/** The workspace's full relationship graph (hub → orgs → people → interactions). */
export async function fetchWorkspaceGraph(ws: string): Promise<GraphData> {
  return apiGet<GraphData>(base(ws));
}

/**
 * The neighborhood sub-graph around a node, by its backend key. `depth` is the
 * hop radius; `limit` caps the returned node count (the backend trims to keep
 * the constellation legible). Returns the same `GraphData` shape so it can be
 * pushed straight onto the explorer's drill stack.
 */
export async function fetchNeighborhood(
  ws: string,
  nodeKey: string,
  depth = 1,
  limit = 50,
): Promise<GraphData> {
  const params = new URLSearchParams({ depth: String(depth), limit: String(limit) });
  return apiGet<GraphData>(
    `${base(ws)}/nodes/${encodeURIComponent(nodeKey)}/neighborhood?${params.toString()}`,
  );
}

/** A single node's inspection detail, by its backend key. */
export async function fetchNodeDetail(ws: string, nodeKey: string): Promise<NodeDetail> {
  return apiGet<NodeDetail>(`${base(ws)}/nodes/${encodeURIComponent(nodeKey)}`);
}

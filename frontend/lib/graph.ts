/**
 * Build the relationship knowledge graph from the cockpit's customer rows:
 * hub → orgs (federated `currentOrgName`) → people. Colored by funnel stage.
 * A thin projection — the canonical entities live in Contact-Ops.
 */
import { contactLabel, type CustomerRow } from './customers';
import type { GraphData, GraphNode, GraphEdge } from '@/components/dashboard/KnowledgeGraph';

const MAX_ORGS = 8;
const MAX_ROWS = 16;

export function deriveGraph(rows: CustomerRow[]): GraphData {
  const nodes: GraphNode[] = [{ id: 'hub', label: 'Your book', type: 'hub' }];
  const edges: GraphEdge[] = [];
  const orgIds = new Map<string, string>();
  let oi = 0;

  rows.slice(0, MAX_ROWS).forEach((r, i) => {
    const orgName = r.contact?.currentOrgName?.trim();
    let anchor = 'hub';
    if (orgName) {
      let orgId = orgIds.get(orgName);
      if (!orgId && oi < MAX_ORGS) {
        orgId = `o${oi++}`;
        orgIds.set(orgName, orgId);
        nodes.push({ id: orgId, label: orgName, type: 'org', stage: r.stage, weight: 2 });
        edges.push({ from: 'hub', to: orgId });
      }
      if (orgId) anchor = orgId;
    }
    const pId = `p${i}`;
    nodes.push({ id: pId, label: contactLabel(r), type: 'person', stage: r.stage });
    edges.push({ from: anchor, to: pId });
  });

  return { nodes, edges };
}

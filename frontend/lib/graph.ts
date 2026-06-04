/**
 * Build the relationship knowledge graph from the cockpit's customer rows:
 * hub → orgs (federated `currentOrgName`) → people. Colored by funnel stage.
 * A thin projection — the canonical entities live in Contact-Ops.
 *
 * Deterministic by construction: rows are sorted into a stable order before the
 * graph is laid out, so SSR/CSR agree and the same book always renders the same
 * constellation. Orgs are weighted by member count and take the most-advanced
 * stage among their people (a single won customer warms the whole org green).
 */
import { contactLabel, type CustomerRow, type Stage } from './customers';
import type { GraphData, GraphNode, GraphEdge } from '@/components/dashboard/KnowledgeGraph';

const MAX_ORGS = 10;
const MAX_PEOPLE = 28;

// Funnel progression: later = more advanced. Used both to pick an org's headline
// stage and to order rows so the most valuable relationships anchor the graph.
const STAGE_RANK: Record<Stage, number> = { LEAD: 0, PROSPECT: 1, CUSTOMER: 2 };

function moreAdvanced(a: Stage | undefined, b: Stage): Stage {
  if (!a) return b;
  return STAGE_RANK[b] > STAGE_RANK[a] ? b : a;
}

/** A stable, value-weighted ordering: customers/prospects first, then by expected
 *  value (desc), then contactId — fully deterministic (no Date/Math.random). */
function orderRows(rows: CustomerRow[]): CustomerRow[] {
  return [...rows].sort((a, b) => {
    const r = STAGE_RANK[b.stage] - STAGE_RANK[a.stage];
    if (r !== 0) return r;
    const va = Number(a.expectedValue ?? 0) || 0;
    const vb = Number(b.expectedValue ?? 0) || 0;
    if (vb !== va) return vb - va;
    return a.contactId.localeCompare(b.contactId);
  });
}

export function deriveGraph(rows: CustomerRow[]): GraphData {
  const live = rows.filter((r) => !r.isLost);
  const ordered = orderRows(live);

  const hub: GraphNode = { id: 'hub', label: 'Your book', type: 'hub' };
  const nodes: GraphNode[] = [hub];
  const edges: GraphEdge[] = [];

  // First pass: discover orgs in deterministic order + tally members/stage.
  interface OrgAgg { id: string; label: string; stage?: Stage; count: number }
  const orgs = new Map<string, OrgAgg>();
  let oi = 0;
  for (const r of ordered) {
    const orgName = r.contact?.currentOrgName?.trim();
    if (!orgName) continue;
    let agg = orgs.get(orgName);
    if (!agg) {
      if (oi >= MAX_ORGS) continue; // overflow people attach to the hub instead
      agg = { id: `o${oi++}`, label: orgName, count: 0 };
      orgs.set(orgName, agg);
    }
    agg.count += 1;
    agg.stage = moreAdvanced(agg.stage, r.stage);
  }

  // Emit org nodes (weight scales with member count, lightly compressed so a
  // mega-org doesn't dwarf the rest of the constellation).
  for (const agg of orgs.values()) {
    nodes.push({
      id: agg.id,
      label: agg.label,
      type: 'org',
      stage: agg.stage,
      weight: Math.min(4, 1 + Math.round(Math.log2(agg.count + 1))),
    });
    edges.push({ from: 'hub', to: agg.id });
  }

  // Second pass: people, anchored to their org (if it made the cut) else the hub.
  let pi = 0;
  for (const r of ordered) {
    if (pi >= MAX_PEOPLE) break;
    const orgName = r.contact?.currentOrgName?.trim();
    const anchor = (orgName && orgs.get(orgName)?.id) || 'hub';
    const pId = `p${pi++}`;
    nodes.push({ id: pId, label: contactLabel(r), type: 'person', stage: r.stage });
    edges.push({ from: anchor, to: pId });
  }

  return { nodes, edges };
}

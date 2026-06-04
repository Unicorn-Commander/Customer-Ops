/**
 * Multi-level relationship graph for the explorer: a root book → orgs → people →
 * interactions. Double-clicking any entity drills into its own sub-graph. Sample
 * data today; binds to live Contact-Ops / Meeting-Ops / AO signal on deploy.
 */
import { SAMPLE_GRAPH } from './sample';
import type { GraphData, GraphNode, GraphEdge } from '@/components/dashboard/KnowledgeGraph';

export const ROOT_GRAPH: GraphData = SAMPLE_GRAPH;

const IX_LABEL: Record<string, string[]> = {
  meeting: ['Discovery call', 'Strategy review', 'Kickoff meeting'],
  email: ['Intro email', 'Follow-up email', 'Proposal sent'],
  invoice: ['Invoice #1042', 'Invoice #1043', 'Deposit invoice'],
  campaign: ['Spring campaign', 'Re-engage sequence', 'Newsletter'],
};
const IX_KINDS = ['meeting', 'email', 'invoice', 'campaign'] as const;

/** The sub-graph for an entity: its people (orgs) + a halo of interactions. */
export function buildSubGraph(node: GraphNode, root: GraphData = ROOT_GRAPH): GraphData | null {
  if (node.type === 'hub') return root;
  if (node.type === 'interaction') return null;

  const nodes: GraphNode[] = [{ id: node.id, label: node.label, type: node.type, stage: node.stage, weight: 3 }];
  const edges: GraphEdge[] = [];

  const people =
    node.type === 'org'
      ? root.edges
          .filter((e) => e.from === node.id)
          .map((e) => root.nodes.find((n) => n.id === e.to))
          .filter((n): n is GraphNode => !!n && n.type === 'person')
      : [];
  people.forEach((p) => {
    nodes.push({ ...p });
    edges.push({ from: node.id, to: p.id });
  });

  const seed = node.id.charCodeAt(node.id.length - 1);
  const count = 4 + (seed % 3);
  for (let i = 0; i < count; i++) {
    const kind = IX_KINDS[(seed + i) % IX_KINDS.length];
    const labels = IX_LABEL[kind];
    const id = `${node.id}-ix${i}`;
    nodes.push({ id, label: labels[i % labels.length], type: 'interaction', stage: node.stage });
    const anchor = people.length ? people[i % people.length].id : node.id;
    edges.push({ from: anchor, to: id });
  }
  return { nodes, edges };
}

export interface NodeDetail {
  title: string;
  kind: string;
  stage?: GraphNode['stage'];
  canDrill: boolean;
  lines: { label: string; value: string }[];
}

const STAGE_LABEL: Record<NonNullable<GraphNode['stage']>, string> = {
  LEAD: 'Lead', PROSPECT: 'Prospect', CUSTOMER: 'Customer',
};

export function nodeDetail(node: GraphNode): NodeDetail {
  const seed = node.id.charCodeAt(node.id.length - 1);
  if (node.type === 'hub') {
    return {
      title: node.label, kind: 'Your book', canDrill: false,
      lines: [
        { label: 'Relationships', value: '243' },
        { label: 'Open pipeline', value: '$410,000' },
        { label: 'Customers', value: '12' },
      ],
    };
  }
  if (node.type === 'org') {
    return {
      title: node.label, kind: 'Organization', stage: node.stage, canDrill: true,
      lines: [
        { label: 'Stage', value: node.stage ? STAGE_LABEL[node.stage] : '—' },
        { label: 'People', value: String(2 + (seed % 3)) },
        { label: 'Open value', value: `$${40 + (seed % 9) * 12}k` },
        { label: 'Last touch', value: `${1 + (seed % 6)}d ago` },
      ],
    };
  }
  if (node.type === 'person') {
    return {
      title: node.label, kind: 'Person', stage: node.stage, canDrill: true,
      lines: [
        { label: 'Stage', value: node.stage ? STAGE_LABEL[node.stage] : '—' },
        { label: 'Interactions', value: String(3 + (seed % 5)) },
        { label: 'Last touch', value: `${1 + (seed % 12)}h ago` },
      ],
    };
  }
  return {
    title: node.label, kind: 'Interaction', stage: node.stage, canDrill: false,
    lines: [{ label: 'Type', value: node.label }, { label: 'When', value: 'Recently' }],
  };
}

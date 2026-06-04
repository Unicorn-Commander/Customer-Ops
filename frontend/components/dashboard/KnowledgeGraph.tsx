import type { Stage } from '@/lib/customers';

export type GraphNodeType = 'hub' | 'org' | 'person' | 'interaction';
export interface GraphNode {
  id: string;
  label: string;
  type: GraphNodeType;
  stage?: Stage;
  /** Relative weight → node size (orgs). */
  weight?: number;
}
export interface GraphEdge { from: string; to: string }
export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[] }

const W = 840;
const H = 440;
const CX = W / 2;
const CY = H / 2 + 6;

function stageVar(stage?: Stage, alpha?: number): string {
  const v =
    stage === 'LEAD' ? '--co-stage-lead' :
    stage === 'PROSPECT' ? '--co-stage-prospect' :
    stage === 'CUSTOMER' ? '--co-stage-customer' :
    '--co-accent';
  return alpha === undefined ? `rgb(var(${v}))` : `rgb(var(${v}) / ${alpha})`;
}

/** Deterministic hub → orgs (inner ring) → people (orbiting their org) layout.
 *  No randomness, so SSR and client agree. */
function layout(data: GraphData): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const hub = data.nodes.find((n) => n.type === 'hub');
  if (hub) pos.set(hub.id, { x: CX, y: CY });

  const orgs = data.nodes.filter((n) => n.type === 'org');
  orgs.forEach((o, i) => {
    const a = (-90 + (360 / Math.max(orgs.length, 1)) * i) * (Math.PI / 180);
    pos.set(o.id, { x: CX + Math.cos(a) * 250, y: CY + Math.sin(a) * 150 });
  });

  const persons = data.nodes.filter((n) => n.type === 'person');
  persons.forEach((p, i) => {
    const orgEdge = data.edges.find((e) => (e.to === p.id && pos.has(e.from)) || (e.from === p.id && pos.has(e.to)));
    const anchorId = orgEdge ? (orgEdge.to === p.id ? orgEdge.from : orgEdge.to) : hub?.id;
    const anchor = (anchorId && pos.get(anchorId)) || { x: CX, y: CY };
    const out = Math.atan2(anchor.y - CY, anchor.x - CX);
    const spread = ((i % 3) - 1) * 0.5;
    const a = out + spread;
    pos.set(p.id, { x: anchor.x + Math.cos(a) * 64, y: anchor.y + Math.sin(a) * 50 });
  });
  return pos;
}

/** KnowledgeGraph — the relationship constellation. People ↔ orgs ↔ your book,
 *  colored by funnel stage. Presentational + deterministic. */
export function KnowledgeGraph({ data }: { data: GraphData }) {
  const pos = layout(data);
  const byId = new Map(data.nodes.map((n) => [n.id, n]));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" role="img" aria-label="Relationship knowledge graph">
      <defs>
        <radialGradient id="kg-core" cx="50%" cy="40%" r="65%">
          <stop offset="0%" stopColor="white" stopOpacity="0.9" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Edges */}
      <g>
        {data.edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const target = byId.get(e.to);
          const mx = (a.x + b.x) / 2 + (a.y - b.y) * 0.12;
          const my = (a.y + b.y) / 2 + (b.x - a.x) * 0.12;
          return (
            <path
              key={i}
              d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
              fill="none"
              style={{ stroke: stageVar(target?.stage, 0.28) }}
              strokeWidth={1.25}
            />
          );
        })}
      </g>

      {/* Nodes */}
      <g>
        {data.nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          const isHub = n.type === 'hub';
          const isOrg = n.type === 'org';
          const r = isHub ? 26 : isOrg ? 9 + Math.min(8, (n.weight ?? 1) * 2) : 5;
          const color = isHub ? 'rgb(var(--co-accent))' : stageVar(n.stage);
          const delay = `${(p.x + p.y) % 1700}ms`;
          return (
            <g key={n.id}>
              {/* halo */}
              <circle cx={p.x} cy={p.y} r={r * 2.4} style={{ fill: isHub ? 'rgb(var(--co-accent) / 0.22)' : stageVar(n.stage, 0.2), filter: 'blur(8px)', animationDelay: delay, transformBox: 'fill-box', transformOrigin: 'center' }} className="animate-bloom" />
              {/* core */}
              <circle cx={p.x} cy={p.y} r={r} style={{ fill: color }} />
              <circle cx={p.x} cy={p.y} r={r} fill="url(#kg-core)" />
              <circle cx={p.x} cy={p.y} r={r} fill="none" style={{ stroke: 'rgb(255 255 255 / 0.5)' }} strokeWidth={isHub ? 1.25 : 0.75} />
              {/* labels for hub + orgs */}
              {(isHub || isOrg) && (
                <text
                  x={p.x}
                  y={isHub ? p.y + r + 16 : p.y - r - 7}
                  textAnchor="middle"
                  style={{ fill: isHub ? 'rgb(var(--co-text-primary))' : 'rgb(var(--co-text-secondary))' }}
                  fontSize={isHub ? 13 : 10.5}
                  fontWeight={isHub ? 700 : 500}
                >
                  {n.label}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

'use client';

import { Fragment, useEffect, useState } from 'react';
import { Waypoints, ChevronRight, ArrowLeft, X, MousePointerClick, Network, RefreshCw } from 'lucide-react';
import { KnowledgeGraph3D } from './KnowledgeGraph3D';
import { ROOT_GRAPH } from '@/lib/graph-explore';
import { fetchNeighborhood, fetchNodeDetail, type NodeDetail } from '@/lib/graph-api';
import { StageBadge } from '@/components/ui';
import { cn } from '@/components/ui/cn';
import type { GraphData, GraphNode } from './KnowledgeGraph';

interface Level { label: string; data: GraphData }

export interface GraphExplorerProps {
  /** The top-level book graph. Defaults to the sample (so /graph-preview keeps
   *  working); the live route passes the workspace's graph from FalkorDB. */
  root?: GraphData;
  /** The caller's workspace id. Present only on the live route — when set, drill
   *  and node-detail hit the backend graph surface. Absent on /graph-preview, so
   *  the explorer renders the sample root with a lightweight local detail and no
   *  network calls (and no drill). */
  workspaceId?: string;
}

/** A human label for a node type, for the detail header. */
const TYPE_LABEL: Record<GraphNode['type'], string> = {
  hub: 'Your book',
  org: 'Organization',
  person: 'Person',
  interaction: 'Interaction',
};

/** Whether a node can be drilled into a sub-graph. Interactions are leaves. */
function canDrill(type: GraphNode['type']): boolean {
  return type !== 'interaction';
}

/** The lightweight detail shown in preview (no backend) — no fabricated metrics,
 *  just the node's own identity. The live route replaces this with the real
 *  FalkorDB-backed detail. */
function localDetail(node: GraphNode): NodeDetail {
  return { id: node.id, label: node.label, type: node.type, lines: [] };
}

/** The interactive 3D relationship explorer: click to inspect, double-click to
 *  drill into an entity's own sub-graph, breadcrumb to climb back out. Live data
 *  (drill + detail) comes from the backend graph store when a workspace is set. */
export function GraphExplorer({ root = ROOT_GRAPH, workspaceId }: GraphExplorerProps) {
  // The breadcrumb label for level 0 is the hub node's label (live graphs may
  // carry a workspace-specific name); fall back to "Your book".
  const rootLabel = root.nodes.find((n) => n.type === 'hub')?.label ?? 'Your book';
  const [stack, setStack] = useState<Level[]>([{ label: rootLabel, data: root }]);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [drilling, setDrilling] = useState(false);
  const current = stack[stack.length - 1];

  // If the live root changes identity (data finished loading / workspace switch),
  // reset the explorer to the new book so we never drill against a stale graph.
  useEffect(() => {
    setStack([{ label: root.nodes.find((n) => n.type === 'hub')?.label ?? 'Your book', data: root }]);
    setSelected(null);
    setDetail(null);
  }, [root]);

  // Click → inspect. Fetch the node's detail from the backend (live route); in
  // preview (no workspace) show the lightweight local detail. On error keep the
  // selection but degrade to the local detail rather than blanking the panel.
  const select = (node: GraphNode) => {
    setSelected(node);
    if (!workspaceId) {
      setDetail(localDetail(node));
      return;
    }
    setDetail(null);
    const key = node.id;
    fetchNodeDetail(workspaceId, key)
      .then((d) => {
        // Ignore a stale response if the selection changed meanwhile.
        setSelected((cur) => {
          if (cur && cur.id === key) setDetail(d);
          return cur;
        });
      })
      .catch(() => {
        setSelected((cur) => {
          if (cur && cur.id === key) setDetail(localDetail(node));
          return cur;
        });
      });
  };

  // Double-click → drill into the node's neighborhood (live route only). On error
  // keep the current view. Preview has no backend, so drill is a no-op there.
  const drill = (node: GraphNode) => {
    if (!canDrill(node.type)) return;
    if (!workspaceId) return;
    setDrilling(true);
    fetchNeighborhood(workspaceId, node.id)
      .then((sub) => {
        if (sub && sub.nodes.length > 0) {
          setStack((s) => [...s, { label: node.label, data: sub }]);
          setSelected(null);
          setDetail(null);
        }
      })
      .catch(() => {
        /* keep the current view on error */
      })
      .finally(() => setDrilling(false));
  };

  const detailBody = detail && selected && (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-tertiary">{TYPE_LABEL[detail.type]}</div>
          <h3 className="mt-0.5 truncate text-lg font-semibold tracking-tight text-primary">{detail.label}</h3>
        </div>
        <button
          type="button"
          onClick={() => { setSelected(null); setDetail(null); }}
          aria-label="Close details"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {selected.stage && <div className="mt-2"><StageBadge stage={selected.stage} /></div>}

      {detail.lines.length > 0 && (
        <dl className="mt-4 space-y-2.5">
          {detail.lines.map((l) => (
            <div key={l.label} className="flex items-center justify-between gap-3 border-b border-subtle pb-2 last:border-0">
              <dt className="text-xs text-tertiary">{l.label}</dt>
              <dd className="truncate font-mono text-sm font-medium text-primary tabular-nums">{l.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {workspaceId && canDrill(detail.type) && (
        <button
          type="button"
          onClick={() => drill(selected)}
          disabled={drilling}
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-token bg-gradient-to-br from-cyan-400 to-blue-500 px-3 py-2.5 text-sm font-semibold text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.28),0_8px_24px_-8px_rgba(56,220,235,0.5)] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/60 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {drilling
            ? <><RefreshCw className="h-4 w-4 animate-spin" strokeWidth={2.4} /> Opening…</>
            : <><Network className="h-4 w-4" strokeWidth={2.4} /> Open its knowledge graph</>}
        </button>
      )}
    </>
  );

  return (
    <div className="mx-auto flex h-[calc(100dvh-148px)] max-w-[1320px] animate-fade-up gap-4 sm:h-[calc(100dvh-128px)] lg:h-[calc(100vh-118px)]">
      <section className="co-glass co-glass-edge relative min-w-0 flex-1 overflow-hidden">
        <div aria-hidden className="co-glow co-glow-cyan absolute -right-24 -top-28 h-72 w-96 opacity-50" />
        <div aria-hidden className="co-glow absolute -left-24 bottom-0 h-72 w-80 opacity-35" />

        <div className="absolute left-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1.5 text-xs sm:left-4 sm:top-4">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-gradient-to-br from-cyan-400 to-blue-500 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.28)]">
            <Waypoints className="h-[15px] w-[15px] text-white" strokeWidth={2.5} />
          </span>
          {stack.map((lvl, i) => (
            <Fragment key={i}>
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" />}
              <button
                type="button"
                onClick={() => { setStack((s) => s.slice(0, i + 1)); setSelected(null); setDetail(null); }}
                className={cn('max-w-[40vw] truncate rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40', i === stack.length - 1 ? 'font-semibold text-primary' : 'text-tertiary hover:text-primary')}
              >
                {lvl.label}
              </button>
            </Fragment>
          ))}
          {stack.length > 1 && (
            <button
              type="button"
              onClick={() => { setStack((s) => s.slice(0, -1)); setSelected(null); setDetail(null); }}
              className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-md border border-subtle bg-surface-raised/70 px-2 py-1 text-tertiary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
          )}
          {drilling && (
            <span className="ml-1 inline-flex shrink-0 items-center gap-1 text-[11px] text-tertiary">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Loading…
            </span>
          )}
        </div>

        {/* Legend — hidden on the smallest screens so it never collides with the
            breadcrumb; the fit/orbit controls + node colors still convey stage. */}
        <div className="absolute right-4 top-4 z-10 hidden items-center gap-3 text-[11px] text-tertiary sm:flex">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-stage-lead" />Lead</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-stage-prospect" />Prospect</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-stage-customer" />Customer</span>
        </div>
        {/* Interaction hint — concise on mobile (no hover/orbit verbs that don't
            apply to touch), full on larger pointers. */}
        <div className="absolute bottom-3 left-4 z-10 flex items-center gap-2 text-[11px] text-muted">
          <MousePointerClick className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden sm:inline">Click to inspect · double-click to dive into a sub-graph · drag to orbit</span>
          <span className="sm:hidden">Tap to inspect · double-tap to dive in</span>
        </div>

        <div className="absolute inset-0" role="img" aria-label={`Interactive 3D relationship graph for ${current.label}: ${current.data.nodes.length} entities, ${current.data.edges.length} links`}>
          <KnowledgeGraph3D data={current.data} onNodeClick={select} onNodeDoubleClick={drill} />
        </div>
      </section>

      {/* Detail: a side column on lg+, a slide-up bottom sheet on mobile (so it
          never crushes the 3D canvas to an unusable sliver). */}
      {detail && selected && (
        <>
          {/* Mobile scrim — tap to dismiss. */}
          <button
            type="button"
            aria-label="Close details"
            onClick={() => { setSelected(null); setDetail(null); }}
            className="fixed inset-0 z-40 bg-surface-base/50 backdrop-blur-sm animate-fade-up lg:hidden"
          />
          <aside
            className={cn(
              'animate-fade-up border-subtle bg-surface-raised shadow-token-lg',
              // mobile: bottom sheet
              'fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto rounded-t-token-xl border-t p-5',
              // lg+: side column
              'lg:relative lg:inset-auto lg:z-auto lg:max-h-none lg:w-[300px] lg:shrink-0 lg:overflow-visible lg:rounded-token-lg lg:border lg:shadow-token',
            )}
          >
            {/* Grab affordance (mobile only). */}
            <div aria-hidden className="mx-auto mb-3 h-1 w-9 rounded-full bg-surface-overlay lg:hidden" />
            {detailBody}
          </aside>
        </>
      )}
    </div>
  );
}

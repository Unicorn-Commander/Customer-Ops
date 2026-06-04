'use client';

import { Fragment, useEffect, useState } from 'react';
import { Waypoints, ChevronRight, ArrowLeft, X, MousePointerClick, Network } from 'lucide-react';
import { KnowledgeGraph3D } from './KnowledgeGraph3D';
import { ROOT_GRAPH, buildSubGraph, nodeDetail } from '@/lib/graph-explore';
import { StageBadge } from '@/components/ui';
import { cn } from '@/components/ui/cn';
import type { GraphData, GraphNode } from './KnowledgeGraph';

interface Level { label: string; data: GraphData }

export interface GraphExplorerProps {
  /** The top-level book graph. Defaults to the sample (so /graph-preview keeps
   *  working); the live route passes a graph derived from the workspace's rows. */
  root?: GraphData;
}

/** The interactive 3D relationship explorer: click to inspect, double-click to
 *  drill into an entity's own sub-graph, breadcrumb to climb back out. */
export function GraphExplorer({ root = ROOT_GRAPH }: GraphExplorerProps) {
  // The breadcrumb label for level 0 is the hub node's label (live graphs may
  // carry a workspace-specific name); fall back to "Your book".
  const rootLabel = root.nodes.find((n) => n.type === 'hub')?.label ?? 'Your book';
  const [stack, setStack] = useState<Level[]>([{ label: rootLabel, data: root }]);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const current = stack[stack.length - 1];

  // If the live root changes identity (data finished loading / workspace switch),
  // reset the explorer to the new book so we never drill against a stale graph.
  useEffect(() => {
    setStack([{ label: root.nodes.find((n) => n.type === 'hub')?.label ?? 'Your book', data: root }]);
    setSelected(null);
  }, [root]);

  const drill = (node: GraphNode) => {
    const sub = buildSubGraph(node, root);
    if (!sub) return;
    setStack((s) => [...s, { label: node.label, data: sub }]);
    setSelected(null);
  };
  const detail = selected ? nodeDetail(selected) : null;

  return (
    <div className="mx-auto flex h-[calc(100vh-118px)] max-w-[1320px] animate-fade-up gap-4">
      <section className="co-glass co-glass-edge relative flex-1 overflow-hidden">
        <div aria-hidden className="co-glow co-glow-cyan absolute -right-24 -top-28 h-72 w-96 opacity-50" />
        <div aria-hidden className="co-glow absolute -left-24 bottom-0 h-72 w-80 opacity-35" />

        <div className="absolute left-4 top-4 z-10 flex items-center gap-1.5 text-xs">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br from-cyan-400 to-blue-500 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.28)]">
            <Waypoints className="h-[15px] w-[15px] text-white" strokeWidth={2.5} />
          </span>
          {stack.map((lvl, i) => (
            <Fragment key={i}>
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted" />}
              <button
                onClick={() => { setStack((s) => s.slice(0, i + 1)); setSelected(null); }}
                className={cn('rounded px-1.5 py-0.5', i === stack.length - 1 ? 'font-semibold text-primary' : 'text-tertiary hover:text-primary')}
              >
                {lvl.label}
              </button>
            </Fragment>
          ))}
          {stack.length > 1 && (
            <button
              onClick={() => { setStack((s) => s.slice(0, -1)); setSelected(null); }}
              className="ml-1 inline-flex items-center gap-1 rounded-md border border-subtle bg-surface-raised/70 px-2 py-1 text-tertiary hover:text-primary"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </button>
          )}
        </div>

        <div className="absolute right-4 top-4 z-10 flex items-center gap-3 text-[11px] text-tertiary">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-stage-lead" />Lead</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-stage-prospect" />Prospect</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-stage-customer" />Customer</span>
        </div>
        <div className="absolute bottom-3 left-4 z-10 flex items-center gap-2 text-[11px] text-muted">
          <MousePointerClick className="h-3.5 w-3.5" /> Click to inspect · double-click to dive into a sub-graph · drag to orbit
        </div>

        <div className="absolute inset-0">
          <KnowledgeGraph3D data={current.data} onNodeClick={setSelected} onNodeDoubleClick={drill} />
        </div>
      </section>

      {detail && selected && (
        <aside className="w-[300px] shrink-0 animate-fade-up rounded-token-lg border border-subtle bg-surface-raised p-5 shadow-token">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-tertiary">{detail.kind}</div>
              <h3 className="mt-0.5 text-lg font-semibold tracking-tight text-primary">{detail.title}</h3>
            </div>
            <button onClick={() => setSelected(null)} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-overlay hover:text-primary">
              <X className="h-4 w-4" />
            </button>
          </div>
          {selected.stage && <div className="mt-2"><StageBadge stage={selected.stage} /></div>}

          <dl className="mt-4 space-y-2.5">
            {detail.lines.map((l) => (
              <div key={l.label} className="flex items-center justify-between border-b border-subtle pb-2 last:border-0">
                <dt className="text-xs text-tertiary">{l.label}</dt>
                <dd className="font-mono text-sm font-medium text-primary tabular-nums">{l.value}</dd>
              </div>
            ))}
          </dl>

          {detail.canDrill && (
            <button
              onClick={() => drill(selected)}
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-token bg-gradient-to-br from-cyan-400 to-blue-500 px-3 py-2.5 text-sm font-semibold text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.28),0_8px_24px_-8px_rgba(56,220,235,0.5)] transition-transform hover:-translate-y-0.5"
            >
              <Network className="h-4 w-4" strokeWidth={2.4} /> Open its knowledge graph
            </button>
          )}
        </aside>
      )}
    </div>
  );
}

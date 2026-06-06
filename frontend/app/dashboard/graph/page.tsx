'use client';

import { useEffect, useState } from 'react';
import { Waypoints, Network } from 'lucide-react';
import { GraphExplorer } from '@/components/dashboard/GraphExplorer';
import { deriveGraph } from '@/lib/graph';
import { resolveWorkspaceId, listCustomers, type CustomerRow } from '@/lib/customers';
import type { GraphData } from '@/components/dashboard/KnowledgeGraph';

type Status = 'loading' | 'ready' | 'empty' | 'error';

/**
 * The full-screen 3D relationship explorer, bound to live data.
 *
 * Resolves the caller's workspace (membership-derived; CO never mints one),
 * fetches the customer rows, and projects them into the root book graph via
 * deriveGraph. The interactive explorer + double-click drill-down then run on
 * top of that root. /graph-preview keeps the sample graph (GraphExplorer's
 * default root), so this route is the only live-data surface.
 */
export default function GraphPage() {
  const [status, setStatus] = useState<Status>('loading');
  const [root, setRoot] = useState<GraphData | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ws = await resolveWorkspaceId();
        if (cancelled) return;
        if (!ws) {
          setErrMsg('No workspace membership yet — an allow-listed user is seeded into the bootstrap workspace on first sign-in.');
          setStatus('error');
          return;
        }
        const rows: CustomerRow[] = await listCustomers(ws);
        if (cancelled) return;
        const live = rows.filter((r) => !r.isLost);
        if (live.length === 0) {
          setStatus('empty');
          return;
        }
        setRoot(deriveGraph(rows));
        setStatus('ready');
      } catch {
        if (cancelled) return;
        setErrMsg('Could not load your relationship graph. Is the backend reachable?');
        setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (status === 'ready' && root) {
    return <GraphExplorer root={root} />;
  }

  // Loading / empty / error all share the explorer's framed glass canvas so the
  // page chrome never jumps when data arrives.
  return (
    <div className="mx-auto flex h-[calc(100dvh-148px)] max-w-[1320px] animate-fade-up sm:h-[calc(100dvh-128px)] lg:h-[calc(100vh-118px)]">
      <section className="co-glass co-glass-edge relative flex flex-1 items-center justify-center overflow-hidden">
        <div aria-hidden className="co-glow co-glow-cyan absolute -right-24 -top-28 h-72 w-96 opacity-50" />
        <div aria-hidden className="co-glow absolute -left-24 bottom-0 h-72 w-80 opacity-35" />

        <div className="absolute left-4 top-4 z-10 flex items-center gap-1.5 text-xs">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br from-cyan-400 to-blue-500 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.28)]">
            <Waypoints className="h-[15px] w-[15px] text-white" strokeWidth={2.5} />
          </span>
          <span className="font-semibold text-primary">Your book</span>
        </div>

        {status === 'loading' && (
          <div className="relative flex flex-col items-center gap-4 text-center">
            <span className="relative grid h-16 w-16 place-items-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-cyan/20" />
              <span className="grid h-12 w-12 place-items-center rounded-full border border-subtle bg-surface-raised/80 backdrop-blur">
                <Network className="h-5 w-5 text-cyan" strokeWidth={2.2} />
              </span>
            </span>
            <p className="text-sm text-tertiary">Mapping your relationships…</p>
          </div>
        )}

        {status === 'empty' && (
          <div className="relative max-w-sm px-6 text-center">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-cyan-400 to-blue-500 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.28),0_12px_32px_-10px_rgba(56,220,235,0.5)]">
              <Waypoints className="h-6 w-6 text-white" strokeWidth={2.3} />
            </span>
            <h2 className="mt-4 text-lg font-semibold tracking-tight text-primary">Your relationships will appear here as a graph</h2>
            <p className="mt-2 text-sm leading-relaxed text-tertiary">
              As you add leads, work them through outreach, and convert prospects into customers, they
              cluster into an interactive constellation — orgs, people, and the interactions between them.
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="relative max-w-md px-6 text-center text-sm text-tertiary">
            {errMsg}
          </div>
        )}
      </section>
    </div>
  );
}

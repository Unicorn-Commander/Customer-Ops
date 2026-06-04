'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useWorkspace } from '@/lib/useWorkspace';
import {
  addNote,
  getCustomer360,
  markLost,
  reopen,
  transitionStage,
  type Customer360,
  type Stage,
} from '@/lib/customers';
import { Customer360View, type Customer360Handlers } from '@/components/dashboard/customer360/Customer360View';
import {
  Customer360Error,
  Customer360NotFound,
  Customer360Skeleton,
} from '@/components/dashboard/customer360/states';

/**
 * Customer-360 page — the THIN live wrapper for the relationship cockpit. It
 * resolves the workspace, loads the federated `Customer360` snapshot, wires the
 * mutating action handlers (stage transitions, mark-lost / re-open, add-note),
 * and renders loading / error / not-found states. All presentation lives in
 * `Customer360View` and its `components/dashboard/customer360/*` panels.
 *
 * Federation + entitlement affordances are carried inside the snapshot's panels;
 * the relationship AGENTS are draft-only + human-in-the-loop (run from the agents
 * panel) — nothing here auto-sends, posts, or moves a stage without the operator.
 */
export default function Customer360Page() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { workspaceId, loading: wsLoading, error: wsError } = useWorkspace();

  const [data, setData] = useState<Customer360 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    try {
      setData(await getCustomer360(workspaceId, id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspaceId, id]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── mutating actions (each refreshes the snapshot on success) ──
  const withBusy = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (!workspaceId) return;
      setBusy(true);
      setError(null);
      try {
        await fn();
        await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, load],
  );

  const handlers: Customer360Handlers = {
    onTransition: (to: Stage) => void withBusy(() => transitionStage(workspaceId!, id, to)),
    onMarkLost: () => {
      const reason = window.prompt('Reason for marking this relationship lost?');
      if (!reason) return;
      void withBusy(() => markLost(workspaceId!, id, reason));
    },
    onReopen: () => void withBusy(() => reopen(workspaceId!, id)),
    onAddNote: (body: string) => withBusy(() => addNote(workspaceId!, id, body)),
    // Agents/panels already refresh themselves; this re-pulls the timeline + panels.
    onChanged: () => load(),
  };

  // ── states ──
  if (wsError) return <Customer360Error message={wsError} />;
  if (error && !data) return <Customer360Error message={error} onRetry={() => void load()} />;
  if (!data && (wsLoading || !workspaceId || !error)) return <Customer360Skeleton />;
  if (!data) return <Customer360NotFound />;

  return (
    <>
      {/* A non-fatal error after the first successful load (e.g. a failed action). */}
      {error && (
        <div className="mx-auto mb-4 max-w-[1200px]">
          <p className="rounded-token border border-danger/30 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger">
            {error}
          </p>
        </div>
      )}
      <Customer360View
        data={data}
        workspaceId={workspaceId}
        customerId={id}
        busy={busy}
        handlers={handlers}
      />
    </>
  );
}

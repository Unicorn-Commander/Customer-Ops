'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Flag } from 'lucide-react';
import { useWorkspace } from '@/lib/useWorkspace';
import { useOverlay } from '@/lib/useOverlay';
import { Button } from '@/components/ui';
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
  const { workspaceId, canWrite, loading: wsLoading, error: wsError } = useWorkspace();

  const [data, setData] = useState<Customer360 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [markLostOpen, setMarkLostOpen] = useState(false);

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
    onMarkLost: () => setMarkLostOpen(true),
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
          <p role="alert" className="rounded-token border border-danger/30 bg-danger-subtle px-3.5 py-2.5 text-sm text-danger">
            {error}
          </p>
        </div>
      )}
      <Customer360View
        data={data}
        canWrite={canWrite}
        workspaceId={workspaceId}
        customerId={id}
        busy={busy}
        handlers={handlers}
      />
      {markLostOpen && (
        <MarkLostModal
          busy={busy}
          onCancel={() => setMarkLostOpen(false)}
          onConfirm={(reason) => {
            setMarkLostOpen(false);
            void withBusy(() => markLost(workspaceId!, id, reason));
          }}
        />
      )}
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Mark-lost confirm — a themed modal with an optional reason, replacing the
   native window.prompt. Mirrors the Relations Officer Confirm/Cancel language:
   the operator decides, with a labeled reason field.
   ─────────────────────────────────────────────────────────────────────── */

function MarkLostModal({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const headingId = useId();
  const reasonId = useId();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const { panelRef, onKeyDown } = useOverlay({ onClose: onCancel, initialFocusRef: reasonRef });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onKeyDown={onKeyDown}
    >
      <div className="absolute inset-0" onClick={onCancel} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="relative w-full max-w-md rounded-token-lg border border-subtle bg-surface-raised p-6 text-secondary shadow-token-lg"
      >
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-token bg-danger-subtle text-danger">
            <Flag className="h-4 w-4" strokeWidth={2.4} />
          </span>
          <div>
            <h3 id={headingId} className="text-base font-semibold text-primary">Mark relationship lost?</h3>
            <p className="mt-0.5 text-xs text-tertiary">It moves out of the active funnel — you can re-open it later.</p>
          </div>
        </div>

        <label htmlFor={reasonId} className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-tertiary">
          Reason <span className="font-normal normal-case text-muted">· optional</span>
        </label>
        <textarea
          ref={reasonRef}
          id={reasonId}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Why is this relationship lost? (e.g. went with a competitor)"
          className="w-full resize-y rounded-token border border-subtle bg-surface-overlay px-3 py-2 text-[13px] text-primary placeholder:text-muted focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
        />

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => onConfirm(reason.trim())}
            disabled={busy}
            leading={<Flag className="h-4 w-4" strokeWidth={2.4} />}
          >
            Mark lost
          </Button>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useWorkspace } from '@/lib/useWorkspace';
import {
  contactLabel,
  CustomerRow,
  getPipeline,
  money,
  PipelineBoard,
  Stage,
  STAGES,
  STAGE_LABEL,
  transitionStage,
} from '@/lib/customers';
import { PriorityTag } from '@/components/Badges';

/**
 * Pipeline kanban board. Three lanes (lead/prospect/customer); drag a card to a
 * lane to move the relationship through the funnel. The funnel rules are
 * enforced SERVER-SIDE (forward one step at a time, no skipping qualification) —
 * an illegal drop is rejected and the board reloads to its true state, with the
 * reason surfaced. Contact labels are federated from Contact-Ops.
 */
export default function PipelinePage() {
  const router = useRouter();
  const { workspaceId, loading: wsLoading, error: wsError } = useWorkspace();
  const [board, setBoard] = useState<PipelineBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<Stage | null>(null);
  const [overLane, setOverLane] = useState<Stage | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    try {
      setBoard(await getPipeline(workspaceId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onDrop = async (toStage: Stage) => {
    setOverLane(null);
    if (!workspaceId || !dragId || dragFrom === null) return;
    const id = dragId;
    const from = dragFrom;
    setDragId(null);
    setDragFrom(null);
    if (from === toStage) return; // dropped back in the same lane

    setBusy(true);
    setError(null);
    try {
      await transitionStage(workspaceId, id, toStage);
      await load();
    } catch (e) {
      // Funnel rule rejection (e.g. LEAD→CUSTOMER skip) or any error: reload to
      // the true server state and show why.
      setError((e as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="co-pagehead">
        <div>
          <h1>Pipeline</h1>
          <p>
            Drag a card to move a relationship through the funnel. Forward one
            step at a time — qualification can’t be skipped (enforced server-side).
          </p>
        </div>
      </div>

      {board && (
        <div className="co-stats">
          <div className="co-stat">
            <div className="v">{board.totals.count}</div>
            <div className="k">Open relationships</div>
          </div>
          <div className="co-stat">
            <div className="v">{money(board.totals.expectedValue)}</div>
            <div className="k">Open pipeline value</div>
          </div>
          {board.lanes.map((l) => (
            <div className="co-stat" key={l.stage}>
              <div className="v">{l.count}</div>
              <div className="k">{STAGE_LABEL[l.stage]}</div>
            </div>
          ))}
        </div>
      )}

      {(wsError || error) && <p className="co-error">{wsError || error}</p>}
      {!wsError && (wsLoading || board === null) && <p className="co-muted">Loading…</p>}

      {board && (
        <div className="co-board">
          {STAGES.map((stage) => {
            const lane = board.lanes.find((l) => l.stage === stage)!;
            return (
              <div
                key={stage}
                className={`co-lane ${overLane === stage ? 'is-dragover' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (overLane !== stage) setOverLane(stage);
                }}
                onDragLeave={() => overLane === stage && setOverLane(null)}
                onDrop={() => onDrop(stage)}
              >
                <div className="co-lane__head">
                  <span className="co-lane__title">{STAGE_LABEL[stage]}</span>
                  <span className="co-lane__meta">
                    {lane.count} · {money(lane.expectedValue)}
                  </span>
                </div>
                <div className="co-cardlist">
                  {lane.cards.length === 0 && <div className="co-empty">Drop here</div>}
                  {lane.cards.map((c) => (
                    <Card
                      key={c.id}
                      row={c}
                      busy={busy}
                      onDragStart={() => {
                        setDragId(c.id);
                        setDragFrom(stage);
                      }}
                      onOpen={() => router.push(`/dashboard/customers/${c.id}`)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function Card({
  row,
  busy,
  onDragStart,
  onOpen,
}: {
  row: CustomerRow;
  busy: boolean;
  onDragStart: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className="co-card-mini"
      draggable={!busy}
      onDragStart={onDragStart}
      onDoubleClick={onOpen}
      title="Drag to move stage · double-click to open 360"
    >
      <div className="co-card-mini__name">{contactLabel(row)}</div>
      <div className="co-card-mini__sub">
        {row.contact?.currentOrgName ?? row.contact?.primaryEmail ?? row.contactId}
      </div>
      <div className="co-card-mini__foot">
        <span className="co-muted" style={{ fontSize: 12 }}>
          {money(row.expectedValue, row.currency ?? 'USD')}
        </span>
        <PriorityTag priority={row.priority} />
      </div>
    </div>
  );
}

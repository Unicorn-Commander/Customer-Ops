'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Filter, RotateCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui';
import { IconTile } from '@/components/ui/IconTile';
import { PipelineBoard } from '@/components/dashboard/PipelineBoard';
import { useWorkspace } from '@/lib/useWorkspace';
import {
  getPipeline, money, transitionStage,
  type CustomerRow, type PipelineBoard as Board, type PipelineLane, type Stage,
} from '@/lib/customers';

/**
 * Pipeline — the kanban funnel cockpit. Three lanes (Lead → Prospect → Customer);
 * drag a card to a lane to move the relationship forward. The funnel rules are
 * enforced SERVER-SIDE (forward one step at a time, qualification can't be
 * skipped) — an illegal/failed drop rolls the board back to its true state and
 * surfaces the reason. Contact labels are federated from Contact-Ops.
 *
 * This page is the thin live wrapper: resolve workspace → getPipeline → render
 * the presentational <PipelineBoard/>; the move is applied OPTIMISTICALLY (the
 * card jumps lanes and the lane tallies recompute instantly) then reconciled
 * against transitionStage().
 */
export default function PipelinePage() {
  const router = useRouter();
  const { workspaceId, canWrite, loading: wsLoading, error: wsError } = useWorkspace();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // The last known-good server board — the rollback target for a rejected move.
  const truthRef = useRef<Board | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    setRefreshing(true);
    try {
      const next = await getPipeline(workspaceId);
      truthRef.current = next;
      setBoard(next);
    } catch (e) {
      setError(messageOf(e, 'Could not load the pipeline. Is the backend reachable?'));
    } finally {
      setRefreshing(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onTransition = useCallback(
    async (id: string, from: Stage, to: Stage) => {
      if (!workspaceId || !board) return;
      // 1) Optimistic: move the card + recompute the two affected lanes now.
      const optimistic = moveCard(board, id, from, to);
      if (!optimistic) return;
      setBoard(optimistic);
      setPendingId(id);
      setError(null);
      setNotice(null);
      // 2) Reconcile with the server (it owns the funnel rules).
      try {
        await transitionStage(workspaceId, id, to);
        // Pull the authoritative board (timestamps, derived fields, true tallies).
        const fresh = await getPipeline(workspaceId);
        truthRef.current = fresh;
        setBoard(fresh);
      } catch (e) {
        // Illegal/failed move → roll back to truth + explain.
        setBoard(truthRef.current ?? board);
        setError(messageOf(e, 'That move was rejected. The funnel only advances one step at a time.'));
      } finally {
        setPendingId(null);
      }
    },
    [workspaceId, board],
  );

  const totals = board?.totals;

  return (
    <div className="mx-auto max-w-[1280px] animate-fade-up space-y-5">
      {/* ---- Page header ---- */}
      <header className="relative overflow-hidden rounded-token-xl border border-subtle bg-surface-raised/60 px-5 py-4">
        <div aria-hidden className="co-glow absolute -left-12 -top-16 h-40 w-64 opacity-60" />
        <div aria-hidden className="co-glow co-glow-cyan absolute -right-14 -top-20 h-40 w-64 opacity-40" />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <IconTile icon={Filter} gradient="from-amber-400 to-orange-500" size="lg" />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-tertiary">
                Customer-Ops · Funnel
              </p>
              <h1 className="text-xl font-semibold tracking-tight text-primary">Pipeline</h1>
              <p className="mt-0.5 text-xs leading-relaxed text-tertiary">
                {canWrite ? "Drag a card to move a relationship forward one step at a time." : "View relationships by stage. Your workspace access is read-only."}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-4">
            {totals && (
              <div className="hidden items-center gap-4 sm:flex">
                <Tally label="In flight" value={String(totals.count)} />
                <span aria-hidden className="h-8 w-px bg-[rgb(var(--co-edge))]/60" />
                <Tally label="Pipeline value" value={money(totals.expectedValue)} accent />
              </div>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void load()}
              disabled={refreshing || !workspaceId}
              leading={<RotateCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} strokeWidth={2.4} />}
            >
              Refresh
            </Button>
          </div>
        </div>
      </header>

      {/* ---- Inline notices (rejected move / soft errors) ---- */}
      {error && board && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-token-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.4} />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="rounded-token-lg border border-subtle bg-surface-overlay px-4 py-2.5 text-sm text-tertiary">
          {notice}
        </div>
      )}

      {/* ---- Body: error / loading / empty / board ---- */}
      {wsError || (error && !board) ? (
        <ErrorState message={wsError || error || ''} onRetry={() => void load()} retrying={refreshing} />
      ) : wsLoading || board === null ? (
        <BoardSkeleton />
      ) : isBoardEmpty(board) ? (
        <EmptyState onAddRelationship={() => router.push('/dashboard/customers')} />
      ) : (
        <PipelineBoard
          board={board}
          readOnly={!canWrite}
          pendingId={pendingId}
          onTransition={onTransition}
          onOpen={(id) => router.push(`/dashboard/customers/${id}`)}
        />
      )}
    </div>
  );
}

/* ── header tallies ──────────────────────────────────────────────────────── */

function Tally({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="text-right">
      <div className={`font-mono text-base font-semibold tabular-nums ${accent ? 'text-accent' : 'text-primary'}`}>
        {value}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-tertiary">{label}</div>
    </div>
  );
}

/* ── states ──────────────────────────────────────────────────────────────── */

function BoardSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {[0, 1, 2].map((lane) => (
        <div key={lane} className="flex min-h-[26rem] flex-col rounded-token-xl border border-subtle bg-surface-raised/60">
          <div className="flex items-center gap-2.5 border-b border-subtle px-3.5 py-3.5">
            <div className="h-7 w-7 animate-pulse rounded-[9px] bg-surface-overlay" />
            <div className="space-y-1.5">
              <div className="h-3 w-20 animate-pulse rounded bg-surface-overlay" />
              <div className="h-2.5 w-16 animate-pulse rounded bg-surface-overlay" />
            </div>
          </div>
          <div className="space-y-2.5 p-3">
            {Array.from({ length: [3, 2, 1][lane] }).map((_, i) => (
              <div key={i} className="space-y-2.5 rounded-token-lg border border-subtle bg-surface-raised p-3">
                <div className="h-3.5 w-2/3 animate-pulse rounded bg-surface-overlay" />
                <div className="h-2.5 w-1/2 animate-pulse rounded bg-surface-overlay" />
                <div className="flex justify-between pt-1">
                  <div className="h-3.5 w-14 animate-pulse rounded bg-surface-overlay" />
                  <div className="h-4 w-12 animate-pulse rounded-full bg-surface-overlay" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onAddRelationship }: { onAddRelationship: () => void }) {
  return (
    <div className="relative overflow-hidden rounded-token-xl border border-subtle bg-surface-raised/60 px-6 py-16 text-center">
      <div aria-hidden className="co-glow absolute left-1/2 -top-10 h-40 w-72 -translate-x-1/2 opacity-50" />
      <div className="relative mx-auto max-w-md">
        <div className="mx-auto w-fit">
          <IconTile icon={Sparkles} gradient="from-amber-400 to-orange-500" size="lg" glow />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-primary">Your funnel is empty</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-tertiary">
          Add a relationship to start working it through the funnel — source a lead, qualify it to a
          prospect, then convert. Contacts federate in from Contact-Ops.
        </p>
        <div className="mt-5 flex justify-center">
          <Button glow leading={<Sparkles className="h-4 w-4" strokeWidth={2.4} />} onClick={onAddRelationship}>
            Add a relationship
          </Button>
        </div>
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry, retrying }: { message: string; onRetry: () => void; retrying: boolean }) {
  return (
    <div className="mx-auto max-w-md rounded-token-xl border border-danger/30 bg-surface-raised/60 px-6 py-12 text-center">
      <div className="mx-auto grid h-11 w-11 place-items-center rounded-[13px] bg-danger-subtle">
        <AlertTriangle className="h-5 w-5 text-danger" strokeWidth={2.4} />
      </div>
      <h2 className="mt-3.5 text-base font-semibold text-primary">Couldn&rsquo;t load the pipeline</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-tertiary">{message}</p>
      <div className="mt-5 flex justify-center">
        <Button
          variant="secondary"
          onClick={onRetry}
          disabled={retrying}
          leading={<RotateCw className={`h-4 w-4 ${retrying ? 'animate-spin' : ''}`} strokeWidth={2.4} />}
        >
          {retrying ? 'Retrying…' : 'Try again'}
        </Button>
      </div>
    </div>
  );
}

/* ── pure helpers ────────────────────────────────────────────────────────── */

function isBoardEmpty(board: Board): boolean {
  return board.lanes.every((l) => l.cards.length === 0);
}

function messageOf(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : '';
  return m && m.trim() ? m : fallback;
}

/** Sum a lane's expected value as a decimal STRING (money is never float). */
function sumExpected(cards: CustomerRow[]): string {
  // Work in integer cents to avoid float drift, then re-render as a decimal.
  const cents = cards.reduce((acc, c) => acc + Math.round(Number(c.expectedValue ?? '0') * 100), 0);
  return (cents / 100).toFixed(4);
}

/**
 * Optimistically move a card between lanes and recompute both lanes' tallies.
 * Returns a fresh board, or null if the source card isn't found.
 */
function moveCard(board: Board, id: string, from: Stage, to: Stage): Board | null {
  const src = board.lanes.find((l) => l.stage === from);
  const card = src?.cards.find((c) => c.id === id);
  if (!src || !card) return null;

  const moved: CustomerRow = { ...card, stage: to };

  const lanes: PipelineLane[] = board.lanes.map((lane) => {
    if (lane.stage === from) {
      const cards = lane.cards.filter((c) => c.id !== id);
      return { ...lane, cards, count: cards.length, expectedValue: sumExpected(cards) };
    }
    if (lane.stage === to) {
      const cards = [moved, ...lane.cards];
      return { ...lane, cards, count: cards.length, expectedValue: sumExpected(cards) };
    }
    return lane;
  });

  // Totals are stage-agnostic (a move doesn't add/remove a relationship), so the
  // board-level count/value are unchanged — keep them as-is.
  return { lanes, totals: board.totals };
}

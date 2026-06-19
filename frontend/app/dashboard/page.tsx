'use client';

import { useEffect, useState } from 'react';
import { CockpitDashboard, type AttentionItem, type ActivityItem } from '@/components/dashboard/CockpitDashboard';
import {
  resolveWorkspaceId, getPipeline, listCustomers, contactLabel,
  type PipelineBoard, type CustomerRow, type Stage,
} from '@/lib/customers';
import { getStoredUser, ApiError, type CustomerOpsUser } from '@/lib/api';
import { deriveGraph } from '@/lib/graph';

const STAGE_VERB: Record<Stage, string> = {
  LEAD: 'is a new lead', PROSPECT: 'is now a prospect', CUSTOMER: 'is now a customer',
};

function rel(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return 'Yesterday';
  return `${Math.floor(s / 86400)}d ago`;
}

function deriveAttention(rows: CustomerRow[]): AttentionItem[] {
  const now = Date.now();
  return rows
    .filter((r) => !r.isLost && (r.priority === 'HIGH' || (r.nextActionAt && new Date(r.nextActionAt).getTime() < now)))
    .slice(0, 6)
    .map((r) => ({
      id: r.id,
      name: contactLabel(r),
      stage: r.stage,
      priority: r.priority,
      note: r.nextActionAt && new Date(r.nextActionAt).getTime() < now ? 'Next action overdue' : 'Flagged high priority',
    }));
}

function deriveActivity(rows: CustomerRow[]): ActivityItem[] {
  return [...rows]
    .sort((a, b) => new Date(b.lastStageChangeAt).getTime() - new Date(a.lastStageChangeAt).getTime())
    .slice(0, 6)
    .map((r) => ({ id: r.id, name: contactLabel(r), stage: r.stage, text: STAGE_VERB[r.stage], when: rel(r.lastStageChangeAt) }));
}

export default function DashboardHome() {
  const [board, setBoard] = useState<PipelineBoard | null>(null);
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const user = getStoredUser<CustomerOpsUser>();

  useEffect(() => {
    (async () => {
      try {
        const ws = await resolveWorkspaceId();
        if (!ws) {
          setError('No workspace membership yet — an allow-listed user is seeded into the bootstrap workspace on first sign-in.');
          return;
        }
        const [b, c] = await Promise.all([getPipeline(ws), listCustomers(ws)]);
        setBoard(b);
        setRows(c);
      } catch (err) {
        // A 401 means the session expired — the API client is already clearing
        // it and bouncing to sign-in, so don't flash a "backend down" message.
        if (err instanceof ApiError && err.status === 401) return;
        setError('Could not load the cockpit. Is the backend reachable?');
      }
    })();
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-md rounded-token-lg border border-subtle bg-surface-raised p-8 text-center text-sm text-tertiary">
        {error}
      </div>
    );
  }
  if (!board) {
    return (
      <div className="mx-auto max-w-[1200px] space-y-6">
        <div className="h-36 animate-pulse rounded-token-xl border border-subtle bg-surface-raised/60" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-28 animate-pulse rounded-token-lg border border-subtle bg-surface-raised" />)}
        </div>
        <div className="h-72 animate-pulse rounded-token-lg border border-subtle bg-surface-raised" />
      </div>
    );
  }

  return (
    <CockpitDashboard
      userName={user?.firstName || 'there'}
      board={board}
      attention={deriveAttention(rows)}
      activity={deriveActivity(rows)}
      graph={deriveGraph(rows)}
    />
  );
}

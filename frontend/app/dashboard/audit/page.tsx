'use client';

import { useCallback, useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { TR, TD } from '@/components/ui/Table';
import { useWorkspace } from '@/lib/useWorkspace';
import { relativeTime } from '@/lib/leads';
import { getAuditTrail, type AuditAction, type AuditLogRow, type AuditPage } from '@/lib/audit';
import {
  OverviewHeader, SummaryRibbon, RibbonStat, BreakdownTile, OverviewTableCard, OverviewEmpty, OverviewError,
} from '@/components/dashboard/overview/OverviewShell';

/**
 * Audit trail — the command-center "System" surface that lists every recorded
 * action across the workspace, append-only and newest-first. Reads the backend
 * audit endpoint (the immutable log written as a side effect of every mutating
 * action). Unlike the other overview surfaces these rows do NOT belong to a
 * customer, so they render with the raw Table primitives instead of the
 * customer-deep-linking OverviewRow.
 */

const COLUMNS = [
  { key: 'action', label: 'Action' },
  { key: 'resource', label: 'Resource' },
  { key: 'target', label: 'Target' },
  { key: 'actor', label: 'Actor' },
  { key: 'details', label: 'Details' },
  { key: 'when', label: 'When' },
];

/** Action verb → semantic badge variant, per the surface spec. */
const ACTION_VARIANT: Record<AuditAction, BadgeVariant> = {
  CREATE: 'success',
  UPDATE: 'info',
  DELETE: 'danger',
  EXECUTE: 'accent',
  LOGIN: 'neutral',
  LOGOUT: 'neutral',
  EXPORT: 'warning',
  IMPORT: 'warning',
  READ: 'neutral',
};

/** Compact, single-line render of a row's `details` object, or an em dash. */
function DetailsCell({ details }: { details: AuditLogRow['details'] }) {
  const entries = details ? Object.entries(details) : [];
  if (entries.length === 0) return <span className="text-muted">—</span>;
  return (
    <span className="text-xs text-tertiary">
      {entries.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ')}
    </span>
  );
}

export default function AuditPage() {
  const { workspaceId, loading: wsLoading, error: wsError } = useWorkspace();
  const [data, setData] = useState<AuditPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    setRefreshing(true);
    try {
      setData(await getAuditTrail(workspaceId, { take: 100 }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const loading = wsLoading || (data === null && !error && !wsError);
  const fatalError = wsError || error;
  const total = data?.total ?? 0;
  const logs = data?.logs ?? [];

  // Client-side tally of the loaded page by action, for the breakdown tile.
  const tally = logs.reduce<Record<string, number>>((acc, l) => {
    acc[l.action] = (acc[l.action] ?? 0) + 1;
    return acc;
  }, {});
  const breakdown = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, label: key, count }));

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-up space-y-5">
      <OverviewHeader
        icon={ScrollText}
        gradient="from-slate-400 to-slate-600"
        eyebrow="Customer-Ops · System"
        title="Audit trail"
        description="Every recorded action across your workspace — append-only, newest first."
        onRefresh={() => void load()}
        refreshing={refreshing}
        refreshDisabled={!workspaceId}
      />

      {/* ── Summary ribbon ── */}
      <SummaryRibbon>
        <RibbonStat label="Events" value={total} loading={loading} />
        <BreakdownTile label="By action" entries={breakdown} loading={loading} />
      </SummaryRibbon>

      {/* ── Error ── */}
      {fatalError && (
        <OverviewError message={fatalError} onRetry={() => void load()} retrying={refreshing} canRetry={!wsError} />
      )}

      {/* ── Table ── */}
      {!fatalError && (
        <OverviewTableCard
          columns={COLUMNS}
          loading={loading}
          isEmpty={logs.length === 0}
          empty={
            <OverviewEmpty icon={ScrollText} gradient="from-slate-400 to-slate-600" title="No activity yet">
              No actions have been recorded in this workspace yet.
            </OverviewEmpty>
          }
          footer={
            <span>
              <span className="font-mono font-semibold tabular-nums text-secondary">{logs.length}</span>
              {` of `}
              <span className="font-mono font-semibold tabular-nums text-secondary">{total}</span>
              {` events`}
            </span>
          }
        >
          {logs.map((l) => (
            <TR key={l.id}>
              <TD><Badge variant={ACTION_VARIANT[l.action] ?? 'neutral'}>{l.action}</Badge></TD>
              <TD mono><span className="text-secondary">{l.resource}</span></TD>
              <TD mono>{l.resourceId ?? <span className="text-muted">—</span>}</TD>
              <TD><span className="text-tertiary">{l.userId ?? 'system'}</span></TD>
              <TD><DetailsCell details={l.details} /></TD>
              <TD><span className="text-tertiary">{relativeTime(l.timestamp)}</span></TD>
            </TR>
          ))}
        </OverviewTableCard>
      )}
    </div>
  );
}

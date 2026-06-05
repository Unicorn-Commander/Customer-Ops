'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { LeadIngestion } from '@/components/dashboard/LeadIngestion';
import { useWorkspace } from '@/lib/useWorkspace';
import {
  getIntakeStats, listIntakes, ingestLead, resolvePending, discardIntake,
  type IntakeStats, type LeadIntake, type IngestLeadInput,
} from '@/lib/leads';

/**
 * Lead Ingestion — the live observability + control surface for the Phase-6
 * `ingest_lead` pipeline. THIN wrapper: resolve the workspace, load the intake
 * stats + the recent intakes once, render the presentational <LeadIngestion>,
 * and wire its three actions (resolvePending / ingestLead / discardIntake) back
 * to lib/leads.ts with a refetch after each.
 *
 * Identity resolution + provisional staging are owned by the backend +
 * Contact-Ops; this page only observes the queue and nudges it.
 */

// Pull a generous recent window for the table + client-side source breakdown.
const PAGE_LIMIT = 200;

export default function LeadsPage() {
  const { workspaceId, loading: wsLoading, error: wsError } = useWorkspace();
  const [stats, setStats] = useState<IntakeStats | null>(null);
  const [intakes, setIntakes] = useState<LeadIntake[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    setRefreshing(true);
    try {
      const [s, page] = await Promise.all([
        getIntakeStats(workspaceId),
        listIntakes(workspaceId, { limit: PAGE_LIMIT }),
      ]);
      setStats(s);
      setIntakes(page.items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Actions (each returns its result so the screen can show the outcome,
  //    then refetches so the KPIs + queue + table reconcile to server truth) ──

  const onResolvePending = useCallback(async () => {
    if (!workspaceId) throw new Error('No workspace.');
    const res = await resolvePending(workspaceId, { scope: 'pending_and_failed' });
    await load();
    return res;
  }, [workspaceId, load]);

  const onIngest = useCallback(async (body: IngestLeadInput) => {
    if (!workspaceId) throw new Error('No workspace.');
    const res = await ingestLead(workspaceId, body);
    await load();
    return res;
  }, [workspaceId, load]);

  const onDiscard = useCallback(async (id: string) => {
    if (!workspaceId) return;
    await discardIntake(workspaceId, id);
    await load();
  }, [workspaceId, load]);

  const loading = wsLoading || (stats === null && intakes === null && !error && !wsError);
  const fatalError = wsError || error;

  // Fatal error (workspace or first load failed with nothing to show yet).
  if (fatalError && stats === null) {
    return (
      <div className="mx-auto max-w-[1280px] animate-fade-up">
        <div className="flex items-start gap-3 rounded-token-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">Couldn&rsquo;t load lead ingestion</p>
            <p className="mt-0.5 break-words text-danger/85">{fatalError}</p>
          </div>
          {!wsError && (
            <Button variant="secondary" size="sm" className="ml-auto shrink-0" onClick={() => void load()}>
              Retry
            </Button>
          )}
        </div>
      </div>
    );
  }

  // While the very first load is in flight we still have no stats; render the
  // screen with a zeroed stats object + the loading flag so it streams skeletons.
  const safeStats: IntakeStats = stats ?? {
    total: 0,
    byStatus: { PENDING: 0, RESOLVED: 0, FAILED: 0, DISCARDED: 0 },
    coReachable: true,
  };

  return (
    <LeadIngestion
      stats={safeStats}
      intakes={intakes ?? []}
      coReachable={safeStats.coReachable}
      loading={loading}
      refreshing={refreshing}
      onRefresh={() => void load()}
      onResolvePending={onResolvePending}
      onIngest={onIngest}
      onDiscard={onDiscard}
    />
  );
}

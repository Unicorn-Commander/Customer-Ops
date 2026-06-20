'use client';

import { useCallback, useEffect, useState } from 'react';
import { Megaphone, AtSign, Share2 } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { TD } from '@/components/ui/Table';
import { useWorkspace } from '@/lib/useWorkspace';
import { outreachStatusLabel } from '@/lib/customers';
import { relativeTime } from '@/lib/leads';
import { getOutreachOverview, type OutreachOverview } from '@/lib/overview';
import {
  OverviewHeader, SummaryRibbon, RibbonStat, BreakdownTile, OverviewTableCard, OverviewEmpty, OverviewError,
} from '@/components/dashboard/overview/OverviewShell';
import { OverviewRow } from '@/components/dashboard/overview/OverviewRow';
import { StatusPill } from '@/components/dashboard/customer360/shared';

/**
 * Outreach — the command-center "across the workspace" surface for campaigns.
 * Reads the backend outreach overview (the latest touch per customer joined with
 * the Outreach app's view) and lists one row per touch. Each row deep-links to
 * that customer's 360. The Outreach app is the campaign SoR; this is a read-only
 * at-a-glance projection that degrades clean (empty) when Outreach is dormant.
 */

const COLUMNS = [
  { key: 'contact', label: 'Contact' },
  { key: 'channel', label: 'Channel' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'status', label: 'Status' },
  { key: 'synced', label: 'Last synced' },
  { key: 'open', label: '' }, // chevron
];

/** Channel → a small icon badge (email / social). */
function ChannelBadge({ channel }: { channel: 'email' | 'social' }) {
  return channel === 'email' ? (
    <Badge variant="info"><AtSign className="h-3 w-3" strokeWidth={2.5} aria-hidden /> Email</Badge>
  ) : (
    <Badge variant="accent"><Share2 className="h-3 w-3" strokeWidth={2.5} aria-hidden /> Social</Badge>
  );
}

const OUTREACH_LABEL: Record<string, string> = {
  replied: 'Replied', clicked: 'Clicked', opened: 'Opened', delivered: 'Delivered',
  sent: 'Sent', scheduled: 'Scheduled', queued: 'Queued', bounced: 'Bounced', failed: 'Failed',
};

export default function OutreachPage() {
  const { workspaceId, loading: wsLoading, error: wsError } = useWorkspace();
  const [data, setData] = useState<OutreachOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    setRefreshing(true);
    try {
      setData(await getOutreachOverview(workspaceId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const loading = wsLoading || (data === null && !error && !wsError);
  const fatalError = wsError || error;
  const summary = data?.summary;
  const items = data?.items ?? [];

  const breakdown = Object.entries(summary?.byStatus ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, label: OUTREACH_LABEL[key] ?? key, count }));

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-up space-y-5">
      <OverviewHeader
        icon={Megaphone}
        gradient="from-fuchsia-500 to-pink-500"
        eyebrow="Customer-Ops · Across the workspace"
        title="Outreach"
        description="Every outreach touch across your workspace — live status from the Outreach app."
        onRefresh={() => void load()}
        refreshing={refreshing}
        refreshDisabled={!workspaceId}
      />

      {/* ── Summary ribbon ── */}
      <SummaryRibbon>
        <RibbonStat label="Touches" value={summary?.count ?? 0} accent loading={loading} />
        <BreakdownTile label="By status" entries={breakdown} loading={loading} />
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
          isEmpty={items.length === 0}
          empty={
            <OverviewEmpty icon={Megaphone} gradient="from-fuchsia-500 to-pink-500" title="No outreach yet">
              No outreach touches yet.
            </OverviewEmpty>
          }
          footer={
            <span>
              <span className="font-mono font-semibold tabular-nums text-secondary">{items.length}</span>
              {` touch${items.length === 1 ? '' : 'es'}`}
            </span>
          }
        >
          {items.map((it, i) => {
            const name = it.contactName ?? `contact ${it.customerId.slice(0, 8)}…`;
            return (
              <OverviewRow key={`${it.customerId}:${it.channel}:${it.createdAt}:${i}`} customerId={it.customerId} name={name}>
                <TD><ChannelBadge channel={it.channel} /></TD>
                <TD>{it.campaignName ? <span className="text-secondary">{it.campaignName}</span> : <span className="text-muted">—</span>}</TD>
                <TD><StatusPill status={outreachStatusLabel(it.lastStatus)} /></TD>
                <TD><span className="text-tertiary">{relativeTime(it.lastPolledAt)}</span></TD>
              </OverviewRow>
            );
          })}
        </OverviewTableCard>
      )}
    </div>
  );
}

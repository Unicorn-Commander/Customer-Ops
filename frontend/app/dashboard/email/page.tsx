'use client';

import { useCallback, useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { TD } from '@/components/ui/Table';
import { useWorkspace } from '@/lib/useWorkspace';
import { emailStatusLabel } from '@/lib/customers';
import { relativeTime } from '@/lib/leads';
import { getEmailOverview, type EmailOverview } from '@/lib/overview';
import {
  OverviewHeader, SummaryRibbon, RibbonStat, OverviewTableCard, OverviewEmpty, OverviewError,
} from '@/components/dashboard/overview/OverviewShell';
import { OverviewRow } from '@/components/dashboard/overview/OverviewRow';
import { StatusPill } from '@/components/dashboard/customer360/shared';

/**
 * Email — the command-center "across the workspace" surface for outbound mail.
 * Reads the backend email overview (every send/draft joined with Email-Ops's
 * view) and lists one row per message. Each row deep-links to that customer's
 * 360. Email-Ops is the mailbox SoR; this is a read-only at-a-glance projection
 * that degrades clean (empty) when Email-Ops is dormant.
 */

const COLUMNS = [
  { key: 'contact', label: 'Contact' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'ref', label: 'Ref' },
  { key: 'created', label: 'Created' },
  { key: 'open', label: '' }, // chevron
];

/** Outbound mode → a calm send/draft badge. */
function TypeBadge({ type }: { type: 'send' | 'draft' }) {
  return type === 'send'
    ? <Badge variant="info">Sent</Badge>
    : <Badge variant="neutral">Draft</Badge>;
}

export default function EmailPage() {
  const { workspaceId, loading: wsLoading, error: wsError } = useWorkspace();
  const [data, setData] = useState<EmailOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    setRefreshing(true);
    try {
      setData(await getEmailOverview(workspaceId));
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

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-up space-y-5">
      <OverviewHeader
        icon={Mail}
        gradient="from-sky-400 to-indigo-500"
        eyebrow="Customer-Ops · Across the workspace"
        title="Email"
        description="Every email sent or drafted across your workspace — live status from Email-Ops."
        onRefresh={() => void load()}
        refreshing={refreshing}
        refreshDisabled={!workspaceId}
      />

      {/* ── Summary ribbon ── */}
      <SummaryRibbon>
        <RibbonStat label="Messages" value={summary?.count ?? 0} loading={loading} />
        <RibbonStat label="Sent" value={summary?.byType.send ?? 0} accent loading={loading} />
        <RibbonStat label="Drafts" value={summary?.byType.draft ?? 0} loading={loading} />
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
            <OverviewEmpty icon={Mail} gradient="from-sky-400 to-indigo-500" title="No email yet">
              No emails sent or drafted yet.
            </OverviewEmpty>
          }
          footer={
            <span>
              <span className="font-mono font-semibold tabular-nums text-secondary">{items.length}</span>
              {` message${items.length === 1 ? '' : 's'}`}
            </span>
          }
        >
          {items.map((it) => {
            const name = it.contactName ?? `contact ${it.customerId.slice(0, 8)}…`;
            return (
              <OverviewRow key={`${it.customerId}:${it.externalRef}`} customerId={it.customerId} name={name}>
                <TD><TypeBadge type={it.type} /></TD>
                <TD><StatusPill status={emailStatusLabel(it.lastStatus)} /></TD>
                <TD><span className="truncate font-mono text-xs text-tertiary">{it.externalRef}</span></TD>
                <TD><span className="text-tertiary">{relativeTime(it.createdAt)}</span></TD>
              </OverviewRow>
            );
          })}
        </OverviewTableCard>
      )}
    </div>
  );
}

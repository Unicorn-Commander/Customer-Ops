'use client';

import { useCallback, useEffect, useState } from 'react';
import { Receipt } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { TD } from '@/components/ui/Table';
import { useWorkspace } from '@/lib/useWorkspace';
import { money } from '@/lib/customers';
import { relativeTime } from '@/lib/leads';
import { getInvoicesOverview, type InvoiceOverview } from '@/lib/overview';
import {
  OverviewHeader, SummaryRibbon, RibbonStat, BreakdownTile, OverviewTableCard, OverviewEmpty, OverviewError,
} from '@/components/dashboard/overview/OverviewShell';
import { OverviewRow } from '@/components/dashboard/overview/OverviewRow';

/**
 * Invoices — the command-center "across the workspace" surface for AR. Reads the
 * backend invoices overview (every invoice link joined with Accounting-Ops's
 * live, polled status) and lists one row per customer. Each row deep-links to
 * that customer's 360. Customer-Ops never holds the ledger — AO is the SoR; this
 * is a read-only at-a-glance projection that degrades clean (empty) when AO is
 * dormant. Money stays a decimal STRING; `money()` formats it for display.
 */

const COLUMNS = [
  { key: 'contact', label: 'Contact' },
  { key: 'invoice', label: 'Invoice #' },
  { key: 'status', label: 'Status' },
  { key: 'amount', label: 'Amount', align: 'right' as const },
  { key: 'balance', label: 'Balance due', align: 'right' as const },
  { key: 'synced', label: 'Last synced' },
  { key: 'open', label: '' }, // chevron
];

/** AO status → colored badge, per the surface spec:
 *  paid = green · sent/partial = amber · void/draft (+ unknown) = muted. */
function InvoiceStatusBadge({ status }: { status: string | null }) {
  const s = (status ?? '').toLowerCase();
  if (s === 'paid') return <Badge variant="success">Paid</Badge>;
  if (s === 'partial') return <Badge variant="warning">Partially paid</Badge>;
  if (s === 'sent') return <Badge variant="warning">Sent</Badge>;
  if (s === 'void') return <Badge variant="neutral">Void</Badge>;
  if (s === 'draft') return <Badge variant="neutral">Draft</Badge>;
  return <Badge variant="neutral">{status ?? 'Pending'}</Badge>;
}

const STATUS_LABEL: Record<string, string> = {
  paid: 'Paid', partial: 'Partial', sent: 'Sent', void: 'Void', draft: 'Draft',
};
const STATUS_DOT: Record<string, string> = {
  paid: 'bg-success', partial: 'bg-warning', sent: 'bg-warning', void: 'bg-muted', draft: 'bg-muted',
};

export default function InvoicesPage() {
  const { workspaceId, loading: wsLoading, error: wsError } = useWorkspace();
  const [data, setData] = useState<InvoiceOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    setRefreshing(true);
    try {
      setData(await getInvoicesOverview(workspaceId));
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
    .map(([key, count]) => ({
      key,
      label: STATUS_LABEL[key] ?? key,
      count,
      dot: STATUS_DOT[key] ?? 'bg-muted',
    }));

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-up space-y-5">
      <OverviewHeader
        icon={Receipt}
        gradient="from-emerald-400 to-teal-500"
        eyebrow="Customer-Ops · Across the workspace"
        title="Invoices"
        description="Every invoice across your workspace — live status from Accounting-Ops."
        onRefresh={() => void load()}
        refreshing={refreshing}
        refreshDisabled={!workspaceId}
      />

      {/* ── Summary ribbon ── */}
      <SummaryRibbon>
        <RibbonStat label="Invoices" value={summary?.count ?? 0} loading={loading} />
        <RibbonStat
          label="Outstanding"
          value={money(summary?.totalOutstanding ?? '0', summary?.currency ?? 'USD')}
          accent
          loading={loading}
        />
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
            <OverviewEmpty icon={Receipt} gradient="from-emerald-400 to-teal-500" title="No invoices yet">
              No invoices linked yet — they appear as you bill customers.
            </OverviewEmpty>
          }
          footer={
            <span>
              <span className="font-mono font-semibold tabular-nums text-secondary">{items.length}</span>
              {` invoice${items.length === 1 ? '' : 's'}`}
            </span>
          }
        >
          {items.map((it) => {
            const sub = it.contactOrg ?? null;
            const name = it.contactName ?? `contact ${it.customerId.slice(0, 8)}…`;
            return (
              <OverviewRow key={`${it.customerId}:${it.invoiceNumber ?? it.createdAt}`} customerId={it.customerId} name={name} sub={sub}>
                <TD>{it.invoiceNumber ? <span className="font-mono text-secondary">{it.invoiceNumber}</span> : <span className="text-muted">—</span>}</TD>
                <TD><InvoiceStatusBadge status={it.lastStatus} /></TD>
                <TD align="right" mono>
                  {it.totalAmount !== null ? <span className="text-primary">{money(it.totalAmount, it.currency)}</span> : <span className="text-muted">—</span>}
                </TD>
                <TD align="right" mono>
                  {it.lastBalanceDue !== null && it.lastStatus !== 'paid' && it.lastStatus !== 'void'
                    ? <span className="text-warning">{money(it.lastBalanceDue, it.currency)}</span>
                    : <span className="text-muted">—</span>}
                </TD>
                <TD><span className="text-tertiary">{relativeTime(it.lastPolledAt)}</span></TD>
              </OverviewRow>
            );
          })}
        </OverviewTableCard>
      )}
    </div>
  );
}

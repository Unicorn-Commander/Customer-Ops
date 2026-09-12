/**
 * The Quotes panel on the relationship page — the doorway to the composer.
 *
 * A quote is commercial paper about a relationship, so it lives here next to
 * the invoices and the projects: the number, what it is worth, which version
 * is current, where it stands, and the timeline of what the client did with
 * it. Opening it goes to the composer; the share link goes to `/q/:token`.
 *
 * Driven by the mock store while L1 builds the data layer (see lib/quotes/draft).
 */

'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { ArrowUpRight, FileSignature, Link2 } from 'lucide-react';

import { Badge, Button, cn } from '@/components/ui';
import { PanelSection } from '@/components/dashboard/customer360/shared';
import { seedRecord } from '@/lib/quotes/draft';
import { FIXTURE_TOKEN_CURRENT } from '@/lib/quotes/quotes-render/fixtures/orderpad.fixture';
import { computeQuote, formatMoney, withDerivedAmounts, type QuoteStatus } from '@/lib/quotes/quotes-render/quote-model';

import { QuoteTimeline } from './QuoteTimeline';

const STATUS_TONE: Record<QuoteStatus, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  sent: 'accent',
  viewed: 'accent',
  accepted: 'success',
  declined: 'danger',
  expired: 'warning',
  voided: 'danger',
};

export function QuotesPanel({ customerId }: { workspaceId?: string | null; customerId: string }) {
  // The mock: one quote on this relationship. L1 swaps this for the list call.
  const record = useMemo(() => seedRecord(), []);
  const totals = useMemo(
    () =>
      computeQuote({
        currency: record.quote.currency,
        lines: withDerivedAmounts(record.lines),
        option_groups: record.quote.option_groups,
        tax_estimate_cents: record.quote.tax_estimate_cents,
      }),
    [record],
  );
  const q = record.quote;
  const composerHref = `/dashboard/customers/${customerId}/quotes/${q.id}`;
  const shareHref = `/q/${FIXTURE_TOKEN_CURRENT}`;

  return (
    <PanelSection
      icon={FileSignature}
      gradient="from-amber-500 to-rose-500"
      title="Quotes & proposals"
      subtitle="Customer-Ops is the system of record"
      tag={<Badge variant="neutral">mock · lane L2</Badge>}
    >
      <article className="rounded-token border border-subtle bg-surface-overlay/50 p-3">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12px] tabular-nums text-tertiary">{q.number}</span>
              <Badge variant={STATUS_TONE[q.status]} dot>
                {q.status}
              </Badge>
              <span className="font-mono text-[11px] text-muted">v{q.current_version_no}</span>
            </div>
            <h4 className="mt-1 text-[14px] font-semibold leading-snug text-primary">{q.title}</h4>
            <p className="mt-1 text-[12.5px] text-secondary">
              Valid until {q.valid_until} · {record.recipients.length} recipient{record.recipients.length === 1 ? '' : 's'}
              {q.delivery_partner ? ` · with ${q.delivery_partner.label}` : ''}
            </p>
          </div>
          <dl className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-1 text-right sm:grid-cols-3">
            {[
              { label: 'One-time', value: totals.one_time_cents },
              { label: 'Milestones', value: totals.milestone_cents },
              { label: 'Year one', value: totals.year_one_cents },
            ].map((f) => (
              <div key={f.label}>
                <dt className="text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted">{f.label}</dt>
                <dd className={cn('font-mono text-[13px] tabular-nums', f.label === 'Year one' ? 'text-primary' : 'text-secondary')}>
                  {formatMoney(f.value, q.currency)}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link href={composerHref}>
            <Button size="sm" variant="secondary" leading={<ArrowUpRight className="h-4 w-4" strokeWidth={2.4} />}>
              Open the composer
            </Button>
          </Link>
          <a href={shareHref} target="_blank" rel="noreferrer">
            <Button size="sm" variant="ghost" leading={<Link2 className="h-4 w-4" strokeWidth={2.4} />}>
              Client view
            </Button>
          </a>
        </div>
      </article>

      <div className="mt-3 border-t border-subtle pt-3">
        <span className="mb-2 block text-[10px] font-medium uppercase tracking-[0.16em] text-muted">Quote timeline</span>
        <QuoteTimeline events={record.events} limit={4} />
      </div>
    </PanelSection>
  );
}

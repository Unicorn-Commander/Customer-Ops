/**
 * The composer page: edit on the left, the real document on the right.
 *
 * Two columns on a wide screen so the studio never writes blind — every change
 * lands in the same template the client will open. Below `xl` the two become a
 * segmented control, because a composer that is unusable on a laptop is a
 * composer nobody checks before sending.
 *
 * The store is the lane's mock of contract §1 + Amendment 01 (lib/quotes/draft);
 * the money is `computeQuote`, the document is `renderQuoteDocument`. When L1
 * lands, the store is the only thing that changes.
 */

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AlertTriangle, ArrowLeft, RotateCcw, Save } from 'lucide-react';

import { Badge, Button, cn } from '@/components/ui';
import { QuoteComposer } from '@/components/quotes/QuoteComposer';
import { QuotePreview, type PreviewMode } from '@/components/quotes/QuotePreview';
import { QuoteTimeline } from '@/components/quotes/QuoteTimeline';
import { Segmented } from '@/components/quotes/parts';
import { useQuoteDraft } from '@/lib/quotes/draft';
import { FIXTURE_TOKEN_CURRENT } from '@/lib/quotes/quotes-render/fixtures/orderpad.fixture';
import { formatMoney } from '@/lib/quotes/quotes-render/quote-model';

type Pane = 'compose' | 'preview' | 'timeline';

export default function QuoteComposerPage() {
  const params = useParams<{ id: string; quoteId: string }>();
  const customerId = params?.id ?? '';
  const quoteId = params?.quoteId ?? 'draft';
  const draft = useQuoteDraft(quoteId);
  const [pane, setPane] = useState<Pane>('compose');
  const [mode, setMode] = useState<PreviewMode>('client');

  const { record, totals, problems, dirty, reset } = draft;
  const errors = problems.filter((p) => p.level === 'error');
  const warns = problems.filter((p) => p.level === 'warn');

  return (
    <div className="co-ambient co-ambient-grid min-h-screen">
      <div className="mx-auto w-full max-w-[1680px] px-4 py-5 sm:px-6">
        <header className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
          <Link
            href={`/dashboard/customers/${customerId}`}
            className="inline-flex items-center gap-1.5 rounded-token px-1.5 py-1 text-[12.5px] text-tertiary transition-colors duration-fast hover:text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={2.4} />
            Relationship
          </Link>
          <div className="min-w-0 flex-1">
            <span className="block font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
              {record.quote.number} · v{record.quote.current_version_no} · {record.quote.status}
            </span>
            <h1 className="truncate text-[19px] font-semibold leading-tight text-primary">{record.quote.title}</h1>
          </div>
          <dl className="flex shrink-0 items-center gap-x-6">
            {[
              { label: 'Due on acceptance', value: totals.deposit_cents },
              { label: 'Year one', value: totals.year_one_cents },
            ].map((f) => (
              <div key={f.label} className="text-right">
                <dt className="text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted">{f.label}</dt>
                <dd className="font-mono text-[15px] tabular-nums text-primary">{formatMoney(f.value, record.quote.currency)}</dd>
              </div>
            ))}
          </dl>
          <div className="flex items-center gap-2">
            <Badge variant={dirty ? 'warning' : 'neutral'} dot={dirty}>
              {dirty ? 'Local draft' : 'Seeded from the fixture'}
            </Badge>
            <Button size="sm" variant="ghost" leading={<RotateCcw className="h-4 w-4" strokeWidth={2.4} />} onClick={reset} disabled={!dirty}>
              Reset
            </Button>
            <Button size="sm" variant="secondary" leading={<Save className="h-4 w-4" strokeWidth={2.4} />} disabled title="Sending is lane L1 (send_quote → Email-Ops draft → approval)">
              Send…
            </Button>
          </div>
        </header>

        {errors.length || warns.length ? (
          <div
            role="status"
            className={cn(
              'mb-4 rounded-token border px-3 py-2.5 text-[12.5px]',
              errors.length ? 'border-danger/50 bg-danger-subtle text-primary' : 'border-warning/45 bg-warning-subtle text-secondary',
            )}
          >
            <span className="mb-1 flex items-center gap-1.5 font-medium">
              <AlertTriangle className={cn('h-3.5 w-3.5', errors.length ? 'text-danger' : 'text-warning')} strokeWidth={2.4} />
              {errors.length ? `${errors.length} thing${errors.length === 1 ? '' : 's'} would stop this being sent` : 'Worth a look before sending'}
            </span>
            <ul className="ml-5 list-disc space-y-0.5">
              {[...errors, ...warns].map((p, i) => (
                <li key={i}>{p.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mb-3 xl:hidden">
          <Segmented
            ariaLabel="Composer pane"
            value={pane}
            onChange={setPane}
            options={[
              { value: 'compose', label: 'Compose' },
              { value: 'preview', label: 'Preview' },
              { value: 'timeline', label: 'Timeline' },
            ]}
          />
        </div>

        <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
          <div className={cn(pane === 'compose' ? 'block' : 'hidden', 'xl:block')}>
            <QuoteComposer draft={draft} />
          </div>
          <div className={cn(pane === 'compose' ? 'hidden' : 'block', 'xl:block xl:sticky xl:top-4 xl:h-[calc(100vh-2rem)]')}>
            <div className={cn(pane === 'timeline' ? 'hidden' : 'block', 'h-full xl:block')}>
              <QuotePreview record={record} mode={mode} onMode={setMode} shareUrl={`/q/${FIXTURE_TOKEN_CURRENT}`} />
            </div>
            <div className={cn(pane === 'timeline' ? 'block' : 'hidden', 'rounded-token-lg border border-subtle bg-surface-raised p-4 shadow-token xl:hidden')}>
              <QuoteTimeline events={record.events} />
            </div>
          </div>
        </div>

        <section className="mt-4 hidden rounded-token-lg border border-subtle bg-surface-raised p-4 shadow-token xl:block">
          <span className="mb-2 block text-[10px] font-medium uppercase tracking-[0.16em] text-muted">Timeline · append-only</span>
          <QuoteTimeline events={record.events} limit={6} />
        </section>
      </div>
    </div>
  );
}

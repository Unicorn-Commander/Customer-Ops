/**
 * Studio / Client preview.
 *
 * The member sees the very document the share link renders — the same template
 * function, not an approximation — inside an iframe so the document's own
 * stylesheet (which styles bare `p`, `ul`, `table`) cannot leak into the
 * cockpit and the cockpit's cannot leak into it.
 *
 * Two views, one record:
 *   CLIENT  — exactly what `/q/:token` renders. No basis notes, no split, no
 *             costs, no recipient addresses. This is the check before sending.
 *   STUDIO  — the same document with the margin basis notes and the internal
 *             band appended. Members only, never a share link.
 *
 * The brand theme is resolved server-side from Brand-Ops. When a session token
 * is present the preview asks the API so the real tokens apply; otherwise it
 * renders with the considered default and says so.
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, ExternalLink, RefreshCw } from 'lucide-react';

import { Badge, Button, cn } from '@/components/ui';
import { API_BASE, getToken } from '@/lib/api';
import { DEFAULT_THEME, resolveBrandTheme } from '@/lib/quotes/brand-ops/brand-tokens';
import type { QuoteTheme } from '@/lib/quotes/brand-ops/brand-ops.types';
import type { QuoteRecord } from '@/lib/quotes/quotes-render/quote-model';
import { toQuoteView, toStudioOverlay, type AcceptanceState } from '@/lib/quotes/quotes-render/quote-view';
import { renderQuoteDocument, type PageSize } from '@/lib/quotes/quotes-render/template/document';

import { Segmented } from './parts';

export type PreviewMode = 'client' | 'studio';

const STATES: ReadonlyArray<{ value: AcceptanceState; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'superseded', label: 'Superseded' },
  { value: 'expired', label: 'Expired' },
  { value: 'declined', label: 'Declined' },
];

/** Ask Brand-Ops (through the API) for this brand's theme; null when we cannot. */
function useBrandTheme(brandSlug: string | null): { theme: QuoteTheme; live: boolean } {
  const [live, setLive] = useState<QuoteTheme | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLive(null);
    const token = getToken();
    if (!brandSlug || !token) return;
    fetch(`${API_BASE}/quotes-render/theme?brand=${encodeURIComponent(brandSlug)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j?.theme) setLive(j.theme as QuoteTheme);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [brandSlug]);
  const fallback = useMemo(() => resolveBrandTheme(null, brandSlug), [brandSlug]);
  return { theme: live ?? fallback ?? DEFAULT_THEME, live: live !== null };
}

export function QuotePreview({
  record,
  mode,
  onMode,
  shareUrl,
}: {
  record: QuoteRecord;
  mode: PreviewMode;
  onMode: (m: PreviewMode) => void;
  shareUrl: string | null;
}) {
  const [state, setState] = useState<AcceptanceState>('open');
  const [pageSize, setPageSize] = useState<PageSize>('letter');
  const [nonce, setNonce] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const { theme, live } = useBrandTheme(record.quote.brand_slug);

  const html = useMemo(() => {
    const view = toQuoteView(record, {
      state,
      version: { no: record.quote.current_version_no, disposition: state === 'accepted' ? 'accepted' : state === 'superseded' ? 'superseded' : 'current' },
      state_at: state === 'open' ? null : record.quote.updated_at,
      accepted_by: state === 'accepted' ? { name: 'Jordan Mercer', email: 'preview@example.com', title: 'Operations lead' } : null,
      now: record.quote.updated_at,
    });
    return renderQuoteDocument(view, {
      mode: 'web',
      pageSize,
      theme,
      acceptUrl: null,
      confirmUrl: null,
      pdfUrl: null,
      preview: mode,
      studio: mode === 'studio' ? toStudioOverlay(record) : null,
    });
  }, [record, mode, state, pageSize, theme]);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-token-lg border border-subtle bg-surface-raised shadow-token">
      <header className="flex flex-wrap items-center gap-2 border-b border-subtle px-3 py-2.5">
        <Segmented
          ariaLabel="Preview audience"
          value={mode}
          onChange={onMode}
          options={[
            { value: 'client', label: 'Client view' },
            { value: 'studio', label: 'Studio view' },
          ]}
        />
        <select
          aria-label="Preview state"
          className="rounded-token border border-subtle bg-surface-overlay px-2 py-1.5 text-[12px] text-secondary focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          value={state}
          onChange={(e) => setState(e.target.value as AcceptanceState)}
        >
          {STATES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Page size"
          className="rounded-token border border-subtle bg-surface-overlay px-2 py-1.5 text-[12px] text-secondary focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/30"
          value={pageSize}
          onChange={(e) => setPageSize(e.target.value as PageSize)}
        >
          <option value="letter">Letter</option>
          <option value="a4">A4</option>
        </select>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant={mode === 'studio' ? 'warning' : 'neutral'}>
            {mode === 'studio' ? 'Internal notes visible' : 'Exactly what the client sees'}
          </Badge>
          {record.quote.brand_slug ? (
            <Badge variant={live ? 'success' : 'neutral'} title={live ? 'Brand-Ops tokens applied' : 'Brand-Ops not reached — considered default'}>
              {live ? `brand · ${record.quote.brand_slug}` : 'default palette'}
            </Badge>
          ) : null}
          <button
            type="button"
            aria-label="Re-render the preview"
            title="Re-render"
            onClick={() => setNonce((n) => n + 1)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-token border border-subtle text-tertiary transition-colors duration-fast hover:text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={2.4} />
          </button>
          <Button
            size="sm"
            variant="ghost"
            leading={<Download className="h-4 w-4" strokeWidth={2.4} />}
            onClick={() => frame.current?.contentWindow?.print()}
          >
            Print / PDF
          </Button>
          {shareUrl ? (
            <a
              href={shareUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-token px-2 py-1.5 text-[12px] text-tertiary transition-colors duration-fast hover:text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={2.4} />
              Share link
            </a>
          ) : null}
        </div>
      </header>
      <iframe
        ref={frame}
        // `nonce` remounts the frame when the member asks for a fresh render.
        key={nonce}
        title={`${mode === 'studio' ? 'Studio' : 'Client'} preview of ${record.quote.number}`}
        srcDoc={html}
        // NOT a trust boundary. `allow-same-origin` together with `allow-scripts`
        // is documented as removing the sandbox's protection — same-origin
        // script can reach out of the frame. Both are needed here (the
        // document's own progressive-enhancement script, and same-origin so the
        // toolbar's print() works), and the content is our own template rendered
        // from this member's own draft, so the frame is a STYLE boundary: it
        // keeps the document's bare `p`/`table`/`a` rules out of the cockpit and
        // the cockpit's out of the document. If a quote ever renders
        // third-party HTML this must become a srcdoc frame WITHOUT
        // allow-same-origin, printing via postMessage. See docs/quotes/RENDER.md.
        sandbox="allow-same-origin allow-scripts allow-modals allow-popups"
        className={cn('min-h-[560px] w-full flex-1 rounded-b-token-lg border-0 bg-white')}
      />
    </div>
  );
}

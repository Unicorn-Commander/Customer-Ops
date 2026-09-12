/**
 * `/q/:token` — the public share page. A server-rendered document, not an app.
 *
 * It asks Customer-Ops for the client-safe `QuoteView` + theme as data, then
 * renders the SAME template the PDF prints (vendored under `lib/quotes/`,
 * byte-identical to the backend's copy — `mirror.spec.ts` fails the build if
 * they drift). The acceptance POSTs go to the sibling route handlers, which
 * forward the binding cookie to the API.
 *
 * No AppShell, no auth, no cockpit chrome: the reader is the client.
 */

import { cache } from 'react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { renderQuoteDocumentParts } from '@/lib/quotes/quotes-render/template/document';
import { resolveQuote } from '@/lib/quotes/source';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ token: string }> };

/**
 * One lookup per request. `generateMetadata` and the page both need the view,
 * and a lookup RECORDS a client view on the timeline — without this the
 * timeline would show two opens for every one.
 */
const getQuote = cache(async (token: string) => {
  const h = await headers();
  return resolveQuote(token, {
    cookie: h.get('cookie') ?? undefined,
    ua: h.get('user-agent') ?? undefined,
    ip: h.get('x-forwarded-for') ?? undefined,
  });
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { token } = await params;
  const { quote } = await getQuote(token);
  // A share link is private paper: never indexed, never previewed.
  const robots = { index: false, follow: false, nocache: true };
  if (!quote) return { title: 'Quote link', robots };
  return { title: `${quote.view.number} · ${quote.view.title}`, robots };
}

export default async function PublicQuotePage({ params }: Params) {
  const { token } = await params;
  const { quote } = await getQuote(token);
  if (!quote) notFound();

  const base = `/q/${encodeURIComponent(token)}`;
  const parts = renderQuoteDocumentParts(quote.view, {
    mode: 'web',
    theme: quote.theme,
    acceptUrl: `${base}/accept`,
    confirmUrl: `${base}/accept/confirm`,
    pdfUrl: `${base}/pdf`,
    bindUrl: `${base}/bind`,
  });

  return (
    <>
      {parts.fontStylesheet ? (
        <>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
          <link rel="stylesheet" href={parts.fontStylesheet} />
        </>
      ) : null}
      <style dangerouslySetInnerHTML={{ __html: parts.css }} />
      {/* The cockpit's own body paint must not show through the document. */}
      <style dangerouslySetInnerHTML={{ __html: 'body{background:var(--q-paper);margin:0}.q-body{min-height:100vh}' }} />
      {/*
        The document's own progressive-enhancement script owns this subtree: it
        runs inline, before hydration, and paints the option selection, the live
        ledger and the sticky total. React must not diff what it finds against
        the string it sent — the mutation is the point.
      */}
      <div className="q-body" suppressHydrationWarning dangerouslySetInnerHTML={{ __html: parts.html }} />
      {parts.script ? <script dangerouslySetInnerHTML={{ __html: parts.script }} /> : null}
    </>
  );
}

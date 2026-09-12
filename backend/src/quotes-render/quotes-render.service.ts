/**
 * QuotesRenderService — resolves a token or a studio record into the rendered
 * document (HTML) or the PDF, with the brand theme applied. The public path
 * never sees a StudioOverlay; the studio path builds one from the record.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrandOpsPort } from '../brand-ops/brand-ops.port';
import { resolveBrandTheme } from '../brand-ops/brand-tokens';
import type { QuoteTheme } from '../brand-ops/brand-ops.types';
import { QuotePdfService } from './quote-pdf.service';
import { toQuoteView, toStudioOverlay, type AcceptanceState, type QuoteView } from './quote-view';
import type { QuoteRecord } from './quote-model';
import { QuotePublicSource, type RequestMeta } from './quotes-render.port';
import { renderQuoteDocument, type PageSize } from './template/document';
import { esc } from './template/html';

export interface DocumentLinks {
  accept: string;
  confirm: string;
  pdf: string;
}

export interface PublicRender {
  status: 200 | 404;
  html: string;
  view: QuoteView | null;
}

@Injectable()
export class QuotesRenderService {
  private readonly logger = new Logger(QuotesRenderService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly source: QuotePublicSource,
    private readonly brand: BrandOpsPort,
    private readonly pdf: QuotePdfService,
  ) {}

  async theme(brandSlug: string | null): Promise<QuoteTheme> {
    if (!brandSlug) return resolveBrandTheme(null, null);
    try {
      return resolveBrandTheme(await this.brand.getBrandTokens(brandSlug), brandSlug);
    } catch (err) {
      this.logger.warn(`Brand-Ops theme lookup failed for ${brandSlug}: ${(err as Error).message}`);
      return resolveBrandTheme(null, brandSlug);
    }
  }

  /**
   * The client-safe view + the resolved theme for a token, as DATA. This is
   * what the Next.js share route consumes: it server-renders the SAME template
   * (vendored byte-identically under frontend/lib/quotes) rather than proxying
   * markup, so the page keeps its own document shell and the PDF and the page
   * still come from one source. Null when the token does not resolve.
   */
  async resolvePublic(token: string, meta: RequestMeta): Promise<{ view: QuoteView; theme: QuoteTheme } | null> {
    const found = await this.source.lookup(token, meta);
    if (!found.found) return null;
    return { view: found.view, theme: await this.theme(found.view.brand_slug) };
  }

  /** The public share page for a token (200) or the styled not-found page (404). */
  async renderPublic(token: string, meta: RequestMeta, links: DocumentLinks): Promise<PublicRender> {
    const found = await this.source.lookup(token, meta);
    if (!found.found) return { status: 404, html: this.notFoundPage(), view: null };
    const theme = await this.theme(found.view.brand_slug);
    const html = renderQuoteDocument(found.view, {
      mode: 'web',
      theme,
      acceptUrl: links.accept,
      confirmUrl: links.confirm,
      pdfUrl: links.pdf,
    });
    return { status: 200, html, view: found.view };
  }

  /** The PDF for a token: null when the token is unknown. */
  async renderPublicPdf(token: string, meta: RequestMeta, pageSize: PageSize): Promise<{ pdf: Buffer; filename: string } | null> {
    const found = await this.source.lookup(token, { ...meta });
    if (!found.found) return null;
    const theme = await this.theme(found.view.brand_slug);
    const html = renderQuoteDocument(found.view, { mode: 'print', pageSize, theme, acceptUrl: null, confirmUrl: null, pdfUrl: null });
    const pdf = await this.pdf.render(this.job(found.view, html, pageSize));
    const suffix = found.view.acceptance.state === 'accepted' ? '-accepted' : '';
    return { pdf, filename: `${found.view.number}-v${found.view.version.no}${suffix}.pdf` };
  }

  /** Studio / client preview of a live record (member surface). */
  async renderPreview(record: QuoteRecord, mode: 'client' | 'studio', opts: { brandSlug?: string | null; state?: AcceptanceState; pageSize?: PageSize; pdf?: boolean } = {}): Promise<{ html: string; view: QuoteView; pdf?: Buffer }> {
    const slug = opts.brandSlug === undefined ? record.quote.brand_slug : opts.brandSlug;
    const view = toQuoteView(record, this.previewState(record, opts.state));
    const theme = await this.theme(slug);
    const pageSize = opts.pageSize ?? 'letter';
    if (opts.pdf) {
      const html = renderQuoteDocument(view, { mode: 'print', pageSize, theme, acceptUrl: null, confirmUrl: null, pdfUrl: null, studio: mode === 'studio' ? toStudioOverlay(record) : null });
      const pdf = await this.pdf.render(this.job(view, html, pageSize));
      return { html, view, pdf };
    }
    const html = renderQuoteDocument(view, {
      mode: 'web',
      pageSize,
      theme,
      acceptUrl: null,
      confirmUrl: null,
      pdfUrl: null,
      preview: mode,
      studio: mode === 'studio' ? toStudioOverlay(record) : null,
    });
    return { html, view };
  }

  private previewState(record: QuoteRecord, override?: AcceptanceState) {
    const q = record.quote;
    const state: AcceptanceState = override ?? (q.status === 'accepted' ? 'accepted' : q.status === 'draft' ? 'draft' : q.status === 'declined' ? 'declined' : q.status === 'expired' ? 'expired' : q.status === 'voided' ? 'voided' : 'open');
    return {
      state,
      state_at: state === 'accepted' ? q.accepted_at ?? new Date().toISOString() : null,
      accepted_by: state === 'accepted' ? q.accepted_by ?? { name: 'Preview acceptor', email: 'preview@example.com', title: 'Title' } : null,
      version: { no: q.current_version_no, disposition: state === 'accepted' ? ('accepted' as const) : state === 'superseded' ? ('superseded' as const) : ('current' as const) },
    };
  }

  private job(view: QuoteView, html: string, pageSize: PageSize) {
    return {
      html,
      pageSize,
      headerLeft: `${view.number} · ${view.title}`,
      footerLeft: `${view.vendor.label} · version ${view.version.no} · valid until ${view.valid_until}`,
    };
  }

  pdfAvailable(): boolean {
    return this.pdf.isAvailable();
  }

  /** A quiet, on-theme not-found page — no hint whether a token ever existed. */
  notFoundPage(): string {
    const theme = resolveBrandTheme(null, null);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Quote link</title><style>${esc('')}:root{--p:${theme.light.paper};--i:${theme.light.ink};--m:${theme.light.muted}}@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--p:${theme.dark.paper};--i:${theme.dark.ink};--m:${theme.dark.muted}}}:root[data-theme="dark"]{--p:${theme.dark.paper};--i:${theme.dark.ink};--m:${theme.dark.muted}}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--p);color:var(--i);font-family:"Instrument Sans","Helvetica Neue",Arial,sans-serif;padding:24px}main{max-width:52ch}h1{font-family:"Instrument Serif","Iowan Old Style",Georgia,serif;font-weight:400;font-size:40px;line-height:1.05;margin:0 0 14px;text-wrap:balance}p{color:var(--m);font-size:16px;line-height:1.5;margin:0}</style></head><body><main><h1>This quote link does not resolve.</h1><p>It may have been mistyped, withdrawn, or replaced by a newer version. Ask the sender for the current link.</p></main></body></html>`;
  }
}

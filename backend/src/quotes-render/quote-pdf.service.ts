/**
 * QuotePdfService — HTML → PDF through puppeteer-core driving the container's
 * (or the developer's) Chromium. Chosen over @react-pdf/renderer because the
 * PDF must be the SAME template as the page: one HTML document, one CSS, one
 * print stylesheet; the browser's print engine does the pagination.
 *
 * Executable resolution: QUOTES_CHROMIUM_PATH, else the first known path that
 * exists. Missing everywhere → `PdfUnavailableError` (503) and the HTML page
 * still serves. The render waits for `load`, then for the web faces under a
 * budget (QUOTES_PDF_FONT_WAIT_MS) — never for the network to go idle, so an
 * unreachable font CDN degrades the typeface instead of killing the PDF.
 *
 * The browser is launched lazily and reused; each render gets its own page.
 * Running header (quote number · page x of y) and footer come from Puppeteer's
 * header/footer templates, which only see inline styles.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import type { PageSize } from './template/document';

export class PdfUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfUnavailableError';
  }
}

export interface PdfJob {
  html: string;
  pageSize: PageSize;
  /** Running-header text (left). */
  headerLeft: string;
  /** Running-footer text (left). */
  footerLeft: string;
}

const CANDIDATES = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

type Browser = { newPage: () => Promise<Page>; close: () => Promise<void>; connected?: boolean; isConnected?: () => boolean };
type Page = {
  setContent: (html: string, opts: Record<string, unknown>) => Promise<void>;
  emulateMediaType: (t: string) => Promise<void>;
  evaluate: (fn: string) => Promise<unknown>;
  pdf: (opts: Record<string, unknown>) => Promise<Uint8Array>;
  close: () => Promise<void>;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

@Injectable()
export class QuotePdfService implements OnModuleDestroy {
  private readonly logger = new Logger(QuotePdfService.name);
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;

  constructor(private readonly config: ConfigService) {}

  /** The Chromium binary this process would use, or null. */
  executablePath(): string | null {
    const configured = this.config.get<string>('QUOTES_CHROMIUM_PATH')?.trim();
    if (configured) return existsSync(configured) ? configured : null;
    return CANDIDATES.find((p) => existsSync(p)) ?? null;
  }

  isAvailable(): boolean {
    return this.executablePath() !== null;
  }

  private async launch(): Promise<Browser> {
    if (this.browser && (this.browser.connected ?? this.browser.isConnected?.() ?? true)) return this.browser;
    if (this.launching) return this.launching;
    const exe = this.executablePath();
    if (!exe) throw new PdfUnavailableError('No Chromium found: set QUOTES_CHROMIUM_PATH (apk add chromium in the image).');
    this.launching = (async () => {
      let puppeteer: { launch: (o: Record<string, unknown>) => Promise<Browser> };
      try {
        puppeteer = (await import('puppeteer-core')) as unknown as typeof puppeteer;
      } catch (err) {
        throw new PdfUnavailableError(`puppeteer-core is not installed: ${(err as Error).message}`);
      }
      const b = await puppeteer.launch({
        executablePath: exe,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none', '--disable-gpu'],
      });
      this.browser = b;
      this.logger.log(`PDF renderer ready (${exe})`);
      return b;
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  async render(job: PdfJob): Promise<Buffer> {
    const browser = await this.launch();
    const page = await browser.newPage();
    try {
      await page.emulateMediaType('print');
      // `load` only — NOT networkidle0. The document links a font stylesheet,
      // and a renderer that waits for a third-party CDN to go idle stops
      // producing PDFs the moment that CDN is slow, blocked by egress rules, or
      // simply absent (the dogfood ring has no outbound internet). The layout is
      // complete at `load`; the faces are waited for separately, with a budget.
      await page.setContent(job.html, { waitUntil: 'load', timeout: 20_000 });
      // Give the web faces a bounded chance to arrive. If they do not, the
      // document prints in its fallback stack — degraded typography, but a PDF.
      const fontBudget = Number(this.config.get('QUOTES_PDF_FONT_WAIT_MS') ?? 6_000);
      await Promise.race([
        page.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => false),
        new Promise((resolve) => setTimeout(resolve, fontBudget)),
      ]);
      const style = 'font-family:Menlo,Consolas,monospace;font-size:7.5px;letter-spacing:.12em;text-transform:uppercase;color:#6a655b;width:100%;padding:0 16mm;display:flex;justify-content:space-between;align-items:center;';
      const bytes = await page.pdf({
        format: job.pageSize === 'a4' ? 'A4' : 'Letter',
        printBackground: true,
        preferCSSPageSize: false,
        displayHeaderFooter: true,
        headerTemplate: `<div style="${style}"><span>${escapeHtml(job.headerLeft)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
        footerTemplate: `<div style="${style}"><span>${escapeHtml(job.footerLeft)}</span><span>Amounts exclude tax; tax is applied on the invoice.</span></div>`,
        margin: { top: '20mm', bottom: '20mm', left: '16mm', right: '16mm' },
      });
      return Buffer.from(bytes);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }
}

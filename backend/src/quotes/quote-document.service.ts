import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { BrandOpsPort } from '../brand-ops/brand-ops.port';
import { resolveBrandTheme } from '../brand-ops/brand-tokens';
import { QuotePdfService } from '../quotes-render/quote-pdf.service';
import { renderQuoteDocument } from '../quotes-render/template/document';
import { QuotesLifecycleService } from './quotes-lifecycle.service';

@Injectable()
export class QuoteDocumentService {
  constructor(
    private readonly lifecycle: QuotesLifecycleService,
    private readonly brand: BrandOpsPort,
    private readonly pdf: QuotePdfService,
  ) {}
  async render(
    user: User,
    workspace: string | undefined,
    id: string,
    format: 'html' | 'pdf' = 'html',
  ) {
    const view = await this.lifecycle.preview(user, workspace, id);
    const tokens = view.brand_slug
      ? await this.brand.getBrandTokens(view.brand_slug).catch(() => null)
      : null;
    const html = renderQuoteDocument(view, {
      mode: format === 'pdf' ? 'print' : 'web',
      theme: resolveBrandTheme(tokens, view.brand_slug),
      acceptUrl: null,
      confirmUrl: null,
      pdfUrl: null,
      preview: 'client',
    });
    if (format === 'html') return { content_type: 'text/html', html };
    const bytes = await this.pdf.render({
      html,
      pageSize: 'letter',
      headerLeft: view.number,
      footerLeft: `Version ${view.version.no}`,
    });
    return { content_type: 'application/pdf', base64: bytes.toString('base64') };
  }
}

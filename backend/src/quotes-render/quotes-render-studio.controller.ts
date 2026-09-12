/**
 * The MEMBER render surface — preview a live record as the client (or the
 * studio, with internal margin notes) and export the PDF. Guarded by the
 * house JwtAuthGuard; the dev bootstrap mounts the same handlers unguarded
 * under a different class so production never carries a bypass flag.
 *
 *   POST quotes-render/preview      { record, mode, brand_slug?, state? } → text/html
 *   POST quotes-render/preview.pdf  { record, mode, page_size? }          → application/pdf
 *   GET  quotes-render/brands                                             → { brands, configured }
 *   GET  quotes-render/theme?brand=slug                                   → { brand, theme }
 *   GET  quotes-render/health                                             → { pdf: boolean, brand_ops: SeamHealth }
 */

import { Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BrandOpsPort } from '../brand-ops/brand-ops.port';
import { PdfUnavailableError } from './quote-pdf.service';
import { PreviewBodySchema } from './quotes-render.dto';
import { QuotesRenderService } from './quotes-render.service';
import type { QuoteRecord } from './quote-model';

export class QuotesRenderStudioHandlers {
  constructor(
    protected readonly render: QuotesRenderService,
    protected readonly brand: BrandOpsPort,
  ) {}

  protected async previewHandler(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const parsed = PreviewBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).type('application/problem+json').send(JSON.stringify({ type: 'about:blank', title: 'Bad preview body', status: 400, detail: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }));
      return;
    }
    const { record, mode, brand_slug, state, page_size } = parsed.data;
    const out = await this.render.renderPreview(record as QuoteRecord, mode, { brandSlug: brand_slug, state, pageSize: page_size });
    res.status(200).type('html').send(out.html);
  }

  protected async previewPdfHandler(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const parsed = PreviewBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).type('application/problem+json').send(JSON.stringify({ type: 'about:blank', title: 'Bad preview body', status: 400, detail: 'record is malformed' }));
      return;
    }
    const { record, mode, brand_slug, state, page_size } = parsed.data;
    try {
      const out = await this.render.renderPreview(record as QuoteRecord, mode, { brandSlug: brand_slug, state, pageSize: page_size, pdf: true });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${out.view.number}-v${out.view.version.no}-preview.pdf"`);
      res.status(200).send(out.pdf);
    } catch (err) {
      if (err instanceof PdfUnavailableError) {
        res.status(503).type('application/problem+json').send(JSON.stringify({ type: 'about:blank', title: 'PDF renderer unavailable', status: 503, detail: err.message }));
        return;
      }
      throw err;
    }
  }

  protected async brandsHandler(): Promise<{ configured: boolean; brands: string[] }> {
    return { configured: this.brand.isConfigured(), brands: await this.brand.listBrands() };
  }

  /**
   * The resolved theme for one brand slug, so the composer's preview paints
   * with the SAME tokens the server will use at render time instead of
   * guessing. Degrade-clean: an unknown or unreachable brand yields the
   * considered default, never an error.
   */
  protected async themeHandler(req: Request): Promise<{ brand: string | null; theme: unknown }> {
    const raw = typeof req.query?.brand === 'string' ? req.query.brand.trim() : '';
    const slug = /^[a-z0-9][a-z0-9-]{0,63}$/i.test(raw) ? raw : null;
    return { brand: slug, theme: await this.render.theme(slug) };
  }

  protected async healthHandler(): Promise<{ pdf: boolean; brand_ops: unknown }> {
    return { pdf: this.render.pdfAvailable(), brand_ops: await this.brand.ping() };
  }
}

@ApiTags('quotes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('quotes-render')
export class QuotesRenderStudioController extends QuotesRenderStudioHandlers {
  @Post('preview')
  preview(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.previewHandler(req, res);
  }

  @Post('preview.pdf')
  previewPdf(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.previewPdfHandler(req, res);
  }

  @Get('brands')
  brands() {
    return this.brandsHandler();
  }

  @Get('theme')
  theme(@Req() req: Request) {
    return this.themeHandler(req);
  }

  @Get('health')
  health() {
    return this.healthHandler();
  }
}

/** DEV ONLY — mounted by dev-main.ts, never by AppModule. */
@ApiExcludeController()
@Controller('quotes-render')
export class QuotesRenderDevStudioController extends QuotesRenderStudioHandlers {
  @Post('preview')
  preview(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.previewHandler(req, res);
  }

  @Post('preview.pdf')
  previewPdf(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.previewPdfHandler(req, res);
  }

  @Get('brands')
  brands() {
    return this.brandsHandler();
  }

  @Get('theme')
  theme(@Req() req: Request) {
    return this.themeHandler(req);
  }

  @Get('health')
  health() {
    return this.healthHandler();
  }
}

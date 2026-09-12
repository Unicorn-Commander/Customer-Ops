import { Module } from '@nestjs/common';
import { BrandOpsModule } from '../brand-ops/brand-ops.module';
import { FixtureQuoteSource } from './fixtures/fixture-source';
import { QuotePdfService } from './quote-pdf.service';
import { QuotesRenderPublicController } from './quotes-render.controller';
import { QuotesRenderStudioController } from './quotes-render-studio.controller';
import { QuotesRenderService } from './quotes-render.service';
import { QuotePublicSource } from './quotes-render.port';

/**
 * Quotes & Proposals — the RENDER module (lane L2, "the look").
 *
 * Server-renders the client document (HTML) and the PDF from a typed QuoteView,
 * with Brand-Ops tokens applied as CSS variables. The data layer is reached
 * ONLY through `QuotePublicSource`; this module binds the fixture source so it
 * runs against the Order Pad proposal. L1 wires the real repository by
 * swapping that one provider and adds this module to AppModule's imports.
 */
@Module({
  imports: [BrandOpsModule],
  controllers: [QuotesRenderPublicController, QuotesRenderStudioController],
  providers: [QuotesRenderService, QuotePdfService, { provide: QuotePublicSource, useClass: FixtureQuoteSource }],
  exports: [QuotesRenderService, QuotePublicSource],
})
export class QuotesRenderModule {}

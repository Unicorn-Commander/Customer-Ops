import { DynamicModule, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { BrandOpsModule } from '../brand-ops/brand-ops.module';
import { M1QuotePublicSource } from '../quotes/quote-public.source';
import { QuotePdfService } from './quote-pdf.service';
import { QuotesRenderPublicController } from './quotes-render.controller';
import { QuotesRenderStudioController } from './quotes-render-studio.controller';
import { QuotesRenderService } from './quotes-render.service';
import { QuotePublicSource } from './quotes-render.port';

/** Production registration never binds FixtureQuoteSource; dev-main owns it. */
@Module({})
export class QuotesRenderModule {
  static register(enabled: boolean): DynamicModule {
    if (!enabled) return { module: QuotesRenderModule };
    return {
      module: QuotesRenderModule,
      imports: [AuthModule, WorkspaceModule, BrandOpsModule],
      controllers: [QuotesRenderPublicController, QuotesRenderStudioController],
      providers: [
        QuotesRenderService,
        QuotePdfService,
        { provide: QuotePublicSource, useClass: M1QuotePublicSource },
      ],
      exports: [QuotesRenderService, QuotePublicSource],
    };
  }
}

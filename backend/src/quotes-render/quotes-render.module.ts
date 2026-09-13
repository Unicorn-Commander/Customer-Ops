import { DynamicModule, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { BrandOpsModule } from '../brand-ops/brand-ops.module';
import { PersistedQuotePublicSource } from '../quotes/quote-public.source';
import { QuotesModule } from '../quotes/quotes.module';
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
      imports: [AuthModule, WorkspaceModule, BrandOpsModule, QuotesModule.register(true)],
      controllers: [QuotesRenderPublicController, QuotesRenderStudioController],
      providers: [
        QuotesRenderService,
        QuotePdfService,
        { provide: QuotePublicSource, useClass: PersistedQuotePublicSource },
      ],
      exports: [QuotesRenderService, QuotePublicSource],
    };
  }
}

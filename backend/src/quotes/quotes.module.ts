import { DynamicModule, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { QuotesService } from './quotes.service';
import { QuotesController } from './quotes.controller';
import { EmailOpsModule } from '../email-ops/email-ops.module';
import { ContactOpsModule } from '../contact-ops/contact-ops.module';
import { QuotesLifecycleService } from './quotes-lifecycle.service';
import { QuotePresentationService } from './quote-presentation.service';
import { QuotesJobsService } from './quotes-jobs.service';
import { QuotesLetterheadController } from './quotes-letterhead.controller';
import { QuotesLifecycleController } from './quotes-lifecycle.controller';
import { BrandOpsModule } from '../brand-ops/brand-ops.module';
import { QuotePdfService } from '../quotes-render/quote-pdf.service';
import { QuoteDocumentService } from './quote-document.service';
const enabledModule = {
  imports: [
    AuthModule,
    WorkspaceModule,
    PrismaModule,
    AuditModule,
    EmailOpsModule,
    ContactOpsModule,
    BrandOpsModule,
  ],
  providers: [
    QuoteDocumentService,
    QuotePdfService,
    QuotesService,
    QuotesLifecycleService,
    QuotePresentationService,
    QuotesJobsService,
  ],
  controllers: [QuotesController, QuotesLifecycleController, QuotesLetterheadController],
  exports: [QuoteDocumentService, QuotesService, QuotesLifecycleService],
};
@Module({})
export class QuotesModule {
  static register(enabled: boolean): DynamicModule {
    return enabled ? { module: QuotesModule, ...enabledModule } : { module: QuotesModule };
  }
}

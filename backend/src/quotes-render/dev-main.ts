/**
 * Local proof bootstrap — boots ONLY the render module (no Prisma, no auth)
 * so the public page, the studio preview and the PDF can be exercised against
 * the fixture. Never used in a deploy.
 *
 *   npx ts-node -r tsconfig-paths/register src/quotes-render/dev-main.ts
 *   → http://localhost:3212/api/v1/public/quotes/fx-orderpad/document
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { NestExpressApplication } from '@nestjs/platform-express';
import { FederationAuthModule } from '../common/federation/federation-auth.module';
import { BrandOpsModule } from '../brand-ops/brand-ops.module';
import { FixtureQuoteSource } from './fixtures/fixture-source';
import { QuotePdfService } from './quote-pdf.service';
import { QuotesRenderPublicController } from './quotes-render.controller';
import { QuotesRenderDevStudioController } from './quotes-render-studio.controller';
import { QuotesRenderService } from './quotes-render.service';
import { QuotePublicSource } from './quotes-render.port';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ThrottlerModule.forRoot([{ name: 'short', ttl: 60_000, limit: 200 }, { name: 'long', ttl: 3_600_000, limit: 5000 }]),
    FederationAuthModule,
    BrandOpsModule,
  ],
  controllers: [QuotesRenderPublicController, QuotesRenderDevStudioController],
  providers: [QuotesRenderService, QuotePdfService, { provide: QuotePublicSource, useClass: FixtureQuoteSource }],
})
class QuotesRenderDevModule {}

async function main() {
  const app = await NestFactory.create<NestExpressApplication>(QuotesRenderDevModule);
  app.set('trust proxy', 1);
  app.enableCors({ origin: true, credentials: true });
  app.setGlobalPrefix('api/v1');
  const port = Number(app.get(ConfigService).get('QUOTES_RENDER_DEV_PORT') ?? 3212);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`quotes-render dev server: http://localhost:${port}/api/v1/public/quotes/fx-orderpad/document`);
}

void main();

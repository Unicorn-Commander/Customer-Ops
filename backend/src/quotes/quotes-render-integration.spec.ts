import { Module, UnauthorizedException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { BrandOpsModule } from '../brand-ops/brand-ops.module';
import { BrandOpsPort } from '../brand-ops/brand-ops.port';
import { QuotePublicSource } from '../quotes-render/quotes-render.port';
import { QuotesRenderModule } from '../quotes-render/quotes-render.module';
import { PersistedQuotePublicSource } from './quote-public.source';
import { QuotesModule } from './quotes.module';
import { QuotesLifecycleService } from './quotes-lifecycle.service';
import { quotesEnabled } from './quotes-enabled';

@Module({})
class EmptyModule {}
@Module({
  providers: [{ provide: BrandOpsPort, useValue: { getBrandTokens: async () => null } }],
  exports: [BrandOpsPort],
})
class LocalBrandModule {}

@Module({
  providers: [
    {
      provide: QuotesLifecycleService,
      useValue: {
        lookup: async () => ({ found: false }),
        begin: async () => ({ ok: false, status: 404, code: 'QUOTE_NOT_FOUND' }),
        confirm: async () => ({ ok: false, status: 404, code: 'QUOTE_NOT_FOUND' }),
      },
    },
  ],
  exports: [QuotesLifecycleService],
})
class LocalQuotesModule {}
async function boot(enabled: boolean) {
  const registration = QuotesRenderModule.register(enabled);
  if (enabled)
    registration.imports = registration.imports!.map((entry: any) =>
      entry.module === QuotesModule ? LocalQuotesModule : entry,
    );
  const builder = Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), registration],
  });
  if (enabled) {
    builder
      .overrideModule(AuthModule)
      .useModule(EmptyModule)
      .overrideModule(WorkspaceModule)
      .useModule(EmptyModule)
      .overrideModule(BrandOpsModule)
      .useModule(LocalBrandModule)
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate() {
          throw new UnauthorizedException();
        },
      })
      .overrideGuard(WorkspaceMembershipGuard)
      .useValue({ canActivate: () => false });
  }
  const module = await builder.compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  return { app, base: await app.getUrl() };
}

describe('Production renderer binding at Amendment 04 routes', () => {
  it('registers no render/public routes or source when disabled by default', async () => {
    const { app, base } = await boot(quotesEnabled(undefined));
    try {
      expect(() => app.get(QuotePublicSource)).toThrow();
      for (const path of [
        '/api/v1/public/quotes/fx-orderpad/view',
        '/api/v1/public/quotes/fx-orderpad/bind',
        '/api/v1/quotes-render/health',
      ])
        expect((await fetch(base + path)).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('never resolves fixture tokens or accepts fixture codes in the enabled production module', async () => {
    const { app, base } = await boot(quotesEnabled('1'));
    const root = base + '/api/v1/public/quotes/fx-orderpad';
    try {
      expect(app.get(QuotePublicSource)).toBeInstanceOf(PersistedQuotePublicSource);
      for (const suffix of ['', '/view', '/document', '/pdf'])
        expect((await fetch(root + suffix)).status).toBe(404);
      expect((await fetch(base + '/api/v1/quotes-render/health')).status).toBe(401);
      expect((await fetch(root + '/bind')).status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

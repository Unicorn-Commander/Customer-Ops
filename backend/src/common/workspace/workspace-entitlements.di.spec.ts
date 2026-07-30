import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../../auth/auth.module';
import { PatService } from '../../auth/pat/pat.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkspaceContextService } from './workspace-context.service';
import { WorkspaceEntitlementsResolver } from './workspace-entitlements.resolver';
import { WorkspaceModule } from './workspace.module';

/**
 * DI wiring guard for the server-side entitlement resolver.
 *
 * WorkspaceEntitlementsResolver is injected with `@Optional()` into both
 * PatService and WorkspaceContextService (so unit specs can construct them with
 * the original deps). That is a SILENT-DEGRADATION hazard: if the provider ever
 * stops being registered/exported — a module refactor, a circular import, a
 * dropped `exports` entry — Nest injects `undefined`, both call sites fall back
 * to the mint snapshot / the bare `entitlementCache` read, and the PAT lane goes
 * back to being unrevocable WITHOUT A SINGLE UNIT TEST FAILING.
 *
 * This asserts the real container actually hands both consumers a live resolver.
 */
describe('WorkspaceEntitlementsResolver — DI wiring', () => {
  it('the container injects it into BOTH PatService and WorkspaceContextService', async () => {
    const mod = await Test.createTestingModule({
      // ignoreEnvFile: never read a deployment .env in a unit test.
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        WorkspaceModule,
        AuthModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({ workspace: {}, workspaceEntitlement: {}, personalAccessToken: {} })
      .compile();

    expect(mod.get(WorkspaceEntitlementsResolver)).toBeInstanceOf(WorkspaceEntitlementsResolver);

    // The @Optional() deps must be POPULATED, not undefined.
    expect((mod.get(PatService) as any).workspaceEntitlements).toBeInstanceOf(
      WorkspaceEntitlementsResolver,
    );
    expect((mod.get(WorkspaceContextService) as any).entitlementsResolver).toBeInstanceOf(
      WorkspaceEntitlementsResolver,
    );

    await mod.close();
  });

  it('defaults the revocation window to 60s when unconfigured', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        WorkspaceModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({ workspace: {}, workspaceEntitlement: {} })
      .compile();

    expect(mod.get(WorkspaceEntitlementsResolver).cacheTtlMs).toBe(60_000);
    await mod.close();
  });
});

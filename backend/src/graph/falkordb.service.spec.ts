import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FalkorDbService } from './falkordb.service';

/**
 * FalkorDbService is the graph plane's transport. The contract that matters most
 * for the foundation is DEGRADE-CLEAN: with FALKORDB_URL unset the service is
 * DORMANT — onModuleInit must NOT connect and must NOT throw (the app boots),
 * isConfigured is false, graph() throws ServiceUnavailable (callers fall back to
 * DB-only), and onModuleDestroy is a no-op. These never touch the real falkordb
 * client (connect is only reached when a URL is set — that path is proven live,
 * not unit-mocked), mirroring the federation clients' dormant-path specs.
 */
function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

describe('FalkorDbService (dormant when FALKORDB_URL unset)', () => {
  it('onModuleInit does not connect or throw when FALKORDB_URL is unset', async () => {
    const svc = new FalkorDbService(makeConfig({}));
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(svc.isConfigured).toBe(false);
  });

  it('treats a blank/whitespace FALKORDB_URL as unset (dormant)', async () => {
    const svc = new FalkorDbService(makeConfig({ FALKORDB_URL: '   ' }));
    await svc.onModuleInit();
    expect(svc.isConfigured).toBe(false);
  });

  it('graph() throws ServiceUnavailableException while dormant', async () => {
    const svc = new FalkorDbService(makeConfig({}));
    await svc.onModuleInit();
    expect(() => svc.graph('cust_ops:ws:0190a000-7e57-7000-8000-00000000c007')).toThrow(
      ServiceUnavailableException,
    );
  });

  it('onModuleDestroy is a safe no-op when never connected', async () => {
    const svc = new FalkorDbService(makeConfig({}));
    await svc.onModuleInit();
    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
    expect(svc.isConfigured).toBe(false);
  });

  it('isConfigured is false before onModuleInit runs', () => {
    const svc = new FalkorDbService(makeConfig({ FALKORDB_URL: 'redis://host:6379' }));
    // Not yet initialized → not connected.
    expect(svc.isConfigured).toBe(false);
  });
});

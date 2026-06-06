import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UcRegistryClient } from './uc-registry.client';
import { isUuidV7 } from './uuidv7';

/**
 * UcRegistryClient is the workspace-id mint seam for self-serve onboarding. The
 * load-bearing guarantee: it is DEGRADE-CLEAN. uc-registry is OPTIONAL — when
 * UC_REGISTRY_URL is unset, unreachable, errors, or returns an unusable id, the
 * client falls back to a locally-generated uuidv7 (with a WARN) and NEVER throws.
 * When the registry IS reachable, its canonical id is used verbatim.
 */
function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

const REQ = { displayName: "Dana's Workspace", slug: 'dana-abc12345', ownerUcUid: 'kc-dana' };

describe('UcRegistryClient', () => {
  const origFetch = global.fetch;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    // Silence + capture the Nest logger so the degrade WARNs are assertable and
    // don't spam the test output.
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  it('uses the uc-registry id when the registry mints one (source = uc-registry)', async () => {
    const minted = '0190a000-7e57-7000-8000-00000000beef';
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ workspace_id: minted }),
    })) as any;
    global.fetch = fetchFn;

    const client = new UcRegistryClient(makeConfig({ UC_REGISTRY_URL: 'https://registry.test' }));
    const res = await client.mintWorkspaceId(REQ);

    expect(res).toEqual({ workspaceId: minted, source: 'uc-registry' });
    // POSTed to the canonical create-workspace path with the suite snake_case body.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://registry.test/api/v1/workspaces');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({
      display_name: REQ.displayName,
      slug: REQ.slug,
      owner_uc_uid: 'kc-dana',
    });
  });

  it('forwards UC_REGISTRY_TOKEN as a bearer when set, omits it otherwise', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: '0190a000-7e57-7000-8000-0000000000aa' }),
    })) as any;
    global.fetch = fetchFn;

    const withTok = new UcRegistryClient(
      makeConfig({ UC_REGISTRY_URL: 'https://registry.test', UC_REGISTRY_TOKEN: 'tok' }),
    );
    await withTok.mintWorkspaceId(REQ);
    expect(fetchFn.mock.calls[0][1].headers['Authorization']).toBe('Bearer tok');

    fetchFn.mockClear();
    const noTok = new UcRegistryClient(makeConfig({ UC_REGISTRY_URL: 'https://registry.test' }));
    await noTok.mintWorkspaceId(REQ);
    expect(fetchFn.mock.calls[0][1].headers['Authorization']).toBeUndefined();
  });

  it('falls back to a local uuidv7 when UC_REGISTRY_URL is unset (no fetch)', async () => {
    const fetchFn = jest.fn();
    global.fetch = fetchFn as any;

    const client = new UcRegistryClient(makeConfig({}));
    const res = await client.mintWorkspaceId(REQ);

    expect(res.source).toBe('local-fallback');
    expect(isUuidV7(res.workspaceId)).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled(); // unconfigured => never calls out
  });

  it('falls back to a local uuidv7 (with a WARN) when uc-registry is unreachable', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as any;

    const client = new UcRegistryClient(makeConfig({ UC_REGISTRY_URL: 'https://registry.test' }));
    const res = await client.mintWorkspaceId(REQ);

    expect(res.source).toBe('local-fallback');
    expect(isUuidV7(res.workspaceId)).toBe(true);
    // The degrade is loud: a transport WARN + a "using local id" WARN.
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('transport error'))).toBe(true);
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes('locally-generated workspace id')),
    ).toBe(true);
  });

  it('falls back when uc-registry returns a non-2xx', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as any;
    const client = new UcRegistryClient(makeConfig({ UC_REGISTRY_URL: 'https://registry.test' }));
    const res = await client.mintWorkspaceId(REQ);
    expect(res.source).toBe('local-fallback');
    expect(isUuidV7(res.workspaceId)).toBe(true);
  });

  it('falls back when uc-registry returns a body with no usable uuidv7', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ workspace_id: 'not-a-v7' }),
    })) as any;
    const client = new UcRegistryClient(makeConfig({ UC_REGISTRY_URL: 'https://registry.test' }));
    const res = await client.mintWorkspaceId(REQ);
    expect(res.source).toBe('local-fallback');
    expect(isUuidV7(res.workspaceId)).toBe(true);
  });
});

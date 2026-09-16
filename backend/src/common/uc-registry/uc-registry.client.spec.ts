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

// A canonical caller-minted v7 the client should register (and keep on degrade).
const SUPPLIED_ID = '0190a000-7e57-7000-8000-00000000da7a';
const REQ = {
  workspaceId: SUPPLIED_ID,
  displayName: "Dana's Workspace",
  slug: 'dana-abc12345',
  ownerUcUid: 'kc-dana',
};

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

  it('registers the supplied id and uses the registry-confirmed id (source = uc-registry)', async () => {
    // The registry echoes the supplied workspace_id back (idempotent record).
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ workspace_id: SUPPLIED_ID }),
    })) as any;
    global.fetch = fetchFn;

    const client = new UcRegistryClient(makeConfig({ UC_REGISTRY_URL: 'https://registry.test' }));
    const res = await client.mintWorkspaceId(REQ);

    expect(res).toEqual({ workspaceId: SUPPLIED_ID, source: 'uc-registry' });
    // POSTed to the REAL registry mint path (no /api/v1) with the real
    // WorkspaceCreate body: our supplied id, slug, display_name, the §5 isolation
    // defaults, active status, and the owner as a members[] row (no scalar owner).
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://registry.test/workspaces');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      workspace_id: SUPPLIED_ID,
      display_name: REQ.displayName,
      slug: REQ.slug,
      isolation_mode: 'standard',
      isolation_tier: 'shared',
      status: 'active',
      members: [{ user_key: 'kc-dana', role: 'owner', is_default: true }],
    });
    // The legacy (wrong) field must NOT be present.
    expect(body).not.toHaveProperty('owner_uc_uid');
  });

  it('preserves the suite default for an additional workspace in the actual request body', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ workspace_id: SUPPLIED_ID }),
    })) as any;
    global.fetch = fetchFn;
    const client = new UcRegistryClient(makeConfig({ UC_REGISTRY_URL: 'https://registry.test' }));
    await client.mintWorkspaceId({ ...REQ, ownerIsDefault: false });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).members).toEqual([
      { user_key: 'kc-dana', role: 'owner', is_default: false },
    ]);
  });

  it('mints its own v7 when no workspaceId is supplied, and registers THAT', async () => {
    let sent: string | undefined;
    const fetchFn = jest.fn(async (_url: string, init: any) => {
      sent = JSON.parse(init.body).workspace_id;
      return { ok: true, status: 201, json: async () => ({ workspace_id: sent }) };
    }) as any;
    global.fetch = fetchFn;

    const { workspaceId, ...rest } = REQ;
    void workspaceId;
    const client = new UcRegistryClient(makeConfig({ UC_REGISTRY_URL: 'https://registry.test' }));
    const res = await client.mintWorkspaceId(rest);

    expect(res.source).toBe('uc-registry');
    expect(isUuidV7(res.workspaceId)).toBe(true);
    expect(res.workspaceId).toBe(sent); // registered the very id it minted
  });

  it('forwards UC_REGISTRY_TOKEN as a bearer when set, omits it otherwise', async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ workspace_id: SUPPLIED_ID }),
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

  it('falls back to the supplied id when UC_REGISTRY_URL is unset (no fetch)', async () => {
    const fetchFn = jest.fn();
    global.fetch = fetchFn as any;

    const client = new UcRegistryClient(makeConfig({}));
    const res = await client.mintWorkspaceId(REQ);

    expect(res.source).toBe('local-fallback');
    // Degrade-clean keeps the SAME supplied id (so the mirror row is consistent
    // whether or not the registry is reachable).
    expect(res.workspaceId).toBe(SUPPLIED_ID);
    expect(fetchFn).not.toHaveBeenCalled(); // unconfigured => never calls out
  });

  it('still mints a valid v7 when unconfigured AND no id supplied', async () => {
    global.fetch = jest.fn() as any;
    const { workspaceId, ...rest } = REQ;
    void workspaceId;
    const client = new UcRegistryClient(makeConfig({}));
    const res = await client.mintWorkspaceId(rest);
    expect(res.source).toBe('local-fallback');
    expect(isUuidV7(res.workspaceId)).toBe(true);
  });

  it('keeps the supplied id (with a WARN) when uc-registry is unreachable', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as any;

    const client = new UcRegistryClient(makeConfig({ UC_REGISTRY_URL: 'https://registry.test' }));
    const res = await client.mintWorkspaceId(REQ);

    expect(res.source).toBe('local-fallback');
    expect(res.workspaceId).toBe(SUPPLIED_ID);
    // The degrade is loud: a transport WARN + a "using local id" WARN.
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('register transport error'))).toBe(
      true,
    );
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes('locally-minted workspace id')),
    ).toBe(true);
  });

  it('keeps the supplied id when uc-registry returns a non-2xx', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as any;
    const client = new UcRegistryClient(makeConfig({ UC_REGISTRY_URL: 'https://registry.test' }));
    const res = await client.mintWorkspaceId(REQ);
    expect(res.source).toBe('local-fallback');
    expect(res.workspaceId).toBe(SUPPLIED_ID);
  });

  it('keeps the supplied id when uc-registry echoes no usable uuidv7', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ workspace_id: 'not-a-v7' }),
    })) as any;
    const client = new UcRegistryClient(makeConfig({ UC_REGISTRY_URL: 'https://registry.test' }));
    const res = await client.mintWorkspaceId(REQ);
    expect(res.source).toBe('local-fallback');
    expect(res.workspaceId).toBe(SUPPLIED_ID);
  });
});

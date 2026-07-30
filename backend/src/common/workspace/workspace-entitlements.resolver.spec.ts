import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementsService } from '../../entitlements/entitlements.service';
import { WorkspaceEntitlementsResolver } from './workspace-entitlements.resolver';

/**
 * WorkspaceEntitlementsResolver — the SERVER-SIDE, per-workspace entitlement
 * source that makes the PAT lane revocable and the (token, workspace) bind real.
 *
 * The properties pinned here are the ones the PAT lane depends on:
 *   * precedence: operator pin > endpoint > durable mirror > "no source"
 *   * "no row at all" is null (trust the claim) — NOT [] — so a node that never
 *     populates the mirror keeps today's behaviour exactly
 *   * an EXPIRED mirror row is INDETERMINATE and fails CLOSED ([]), never a
 *     stale grant
 *   * a DB error fails CLOSED ([]), never a widening
 *   * the cache is BOUNDED: a change at the source lands within the TTL
 */

const WS = '0190a000-7e57-7000-8000-0000000000a1';
const TTL = 60_000;

interface Stub {
  workspaces?: Record<string, unknown>; // id -> entitlementCache value
  mirror?: Record<string, { skus: string[]; expiresAt: Date | null }>;
  endpoint?: (workspaceId: string) => { featureKeys: string[] } | null;
  /**
   * The endpoint is CONFIGURED but cannot answer (401/403/404/5xx/network/timeout/
   * unparseable body). Distinct from `endpoint` being absent, which means
   * "no endpoint configured at all".
   */
  endpointUnavailable?: string;
  workspaceThrows?: boolean;
}

function build(stub: Stub) {
  const upserts: any[] = [];
  const prisma = {
    workspace: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (stub.workspaceThrows) throw new Error('connection terminated');
        if (!stub.workspaces || !(where.id in stub.workspaces)) return null;
        return { entitlementCache: stub.workspaces[where.id] };
      }),
    },
    workspaceEntitlement: {
      findUnique: jest.fn(async ({ where }: any) => stub.mirror?.[where.workspaceId] ?? null),
      upsert: jest.fn(async (args: any) => {
        upserts.push(args);
        return args.create;
      }),
    },
  } as unknown as PrismaService;

  const config = {
    get: (k: string) => (k === 'WORKSPACE_ENTITLEMENTS_TTL_MS' ? String(TTL) : undefined),
  } as unknown as ConfigService;

  const entitlements = {
    lookupWorkspace: jest.fn(async (wsId: string) => {
      if (stub.endpointUnavailable) {
        return { status: 'unavailable', reason: stub.endpointUnavailable };
      }
      if (!stub.endpoint) return { status: 'unconfigured' };
      const data = stub.endpoint(wsId);
      return data ? { status: 'ok', data } : { status: 'unconfigured' };
    }),
    toSkuList: (keys: string[]) => new EntitlementsService(config).toSkuList(keys),
  } as unknown as EntitlementsService;

  return {
    resolver: new WorkspaceEntitlementsResolver(prisma, config, entitlements),
    prisma,
    upserts,
  };
}

describe('WorkspaceEntitlementsResolver', () => {
  afterEach(() => jest.restoreAllMocks());

  it('NO source anywhere ⇒ null (trust the claim) — today’s default is unchanged', async () => {
    const { resolver } = build({});
    await expect(resolver.resolve(WS)).resolves.toEqual({
      skus: null,
      source: 'none',
      stale: false,
    });
  });

  it('the operator pin (Workspace.entitlementCache) wins over everything', async () => {
    const { resolver, prisma } = build({
      workspaces: { [WS]: ['customer-ops'] },
      mirror: { [WS]: { skus: ['email-ops'], expiresAt: null } },
      endpoint: () => ({ featureKeys: ['outreach_ops_access'] }),
    });
    const got = await resolver.resolve(WS);
    expect(got).toEqual({ skus: ['customer-ops'], source: 'operator-cache', stale: false });
    // never even asks the mirror once the operator has pinned it
    expect((prisma as any).workspaceEntitlement.findUnique).not.toHaveBeenCalled();
  });

  it('a present-but-EMPTY operator pin denies everything (not "no source")', async () => {
    const { resolver } = build({ workspaces: { [WS]: [] } });
    await expect(resolver.resolve(WS)).resolves.toMatchObject({ skus: [], source: 'operator-cache' });
  });

  it('a 200 from the endpoint is authoritative AND refreshes the durable mirror', async () => {
    const { resolver, upserts } = build({
      endpoint: () => ({ featureKeys: ['customer_ops_access', 'magic_outreach'] }),
    });
    const got = await resolver.resolve(WS);
    expect(got.source).toBe('endpoint');
    expect(got.skus).toEqual(
      expect.arrayContaining(['customer_ops_access', 'customer-ops', 'magic_outreach', 'outreach']),
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0].where).toEqual({ workspaceId: WS });
    // The persisted row is TTL-bounded so it can go stale (and then fail closed).
    expect(upserts[0].create.expiresAt.getTime() - upserts[0].create.refreshedAt.getTime()).toBe(TTL);
  });

  it('falls back to an UNEXPIRED mirror row when the endpoint cannot answer', async () => {
    const future = new Date(Date.now() + TTL);
    const { resolver } = build({ mirror: { [WS]: { skus: ['customer-ops'], expiresAt: future } } });
    await expect(resolver.resolve(WS)).resolves.toEqual({
      skus: ['customer-ops'],
      source: 'mirror',
      stale: false,
    });
  });

  it('an EXPIRED mirror row is INDETERMINATE ⇒ fails CLOSED ([]), never a stale grant', async () => {
    const past = new Date(Date.now() - 1);
    const { resolver } = build({ mirror: { [WS]: { skus: ['customer-ops'], expiresAt: past } } });
    await expect(resolver.resolve(WS)).resolves.toEqual({
      skus: [],
      source: 'stale-mirror',
      stale: true,
    });
  });

  it('a DB failure fails CLOSED ([]) — never "no source", never a widening', async () => {
    const { resolver } = build({ workspaceThrows: true });
    await expect(resolver.resolve(WS)).resolves.toEqual({
      skus: [],
      source: 'error',
      stale: true,
    });
  });

  it('an empty/blank workspace id is "no source", not an error', async () => {
    const { resolver } = build({ workspaces: { [WS]: ['customer-ops'] } });
    await expect(resolver.resolve('   ')).resolves.toMatchObject({ skus: null, source: 'none' });
  });

  it('caches within the TTL and RE-READS after it — the bounded revocation window', async () => {
    const t0 = 1_800_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);

    const workspaces: Record<string, unknown> = { [WS]: ['customer-ops'] };
    const { resolver, prisma } = build({ workspaces });

    await expect(resolver.resolve(WS)).resolves.toMatchObject({ skus: ['customer-ops'] });
    expect((prisma as any).workspace.findUnique).toHaveBeenCalledTimes(1);

    // Revoke at the source.
    workspaces[WS] = [];

    // Inside the TTL the cached answer is served (bounded staleness, by design).
    now.mockReturnValue(t0 + TTL - 1);
    await expect(resolver.resolve(WS)).resolves.toMatchObject({ skus: ['customer-ops'] });
    expect((prisma as any).workspace.findUnique).toHaveBeenCalledTimes(1);

    // At/after the TTL the source is re-read and the revocation lands.
    now.mockReturnValue(t0 + TTL);
    await expect(resolver.resolve(WS)).resolves.toMatchObject({ skus: [] });
    expect((prisma as any).workspace.findUnique).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // THE FAIL-OPEN. `source: 'none'` means "TRUST THE CLAIM" downstream, so it may
  // only ever be produced by an affirmative "nothing is configured". A configured
  // endpoint that cannot answer must NEVER reach it.
  // ---------------------------------------------------------------------------
  describe('a CONFIGURED-but-unavailable endpoint never degrades to "trust the claim"', () => {
    it.each([
      ['http 500', 'http 500'],
      ['http 401 (our own service credential is wrong)', 'http 401'],
      ['http 403', 'http 403'],
      ['http 404', 'http 404'],
      ['a network error', 'FetchError'],
      ['a timeout', 'AbortError'],
      ['an unparseable body', 'unparseable body'],
    ])('%s with no mirror row ⇒ [] (deny), NOT null', async (_label, reason) => {
      const { resolver } = build({ endpointUnavailable: reason });
      const got = await resolver.resolve(WS);
      // The whole defect in one assertion: `skus` must not be null here.
      expect(got.skus).not.toBeNull();
      expect(got).toEqual({ skus: [], source: 'source-unavailable', stale: true });
    });

    it('narrows to an UNEXPIRED mirror row rather than denying, when one exists', async () => {
      const future = new Date(Date.now() + TTL);
      const { resolver } = build({
        endpointUnavailable: 'http 500',
        mirror: { [WS]: { skus: ['customer-ops'], expiresAt: future } },
      });
      // A persisted answer carrying its own expiresAt is a legitimate narrowing —
      // it can never outlive its window.
      await expect(resolver.resolve(WS)).resolves.toEqual({
        skus: ['customer-ops'],
        source: 'mirror',
        stale: false,
      });
    });

    it('an EXPIRED mirror row still wins over the unavailable endpoint — as a DENY', async () => {
      const past = new Date(Date.now() - 1);
      const { resolver } = build({
        endpointUnavailable: 'http 500',
        mirror: { [WS]: { skus: ['customer-ops'], expiresAt: past } },
      });
      await expect(resolver.resolve(WS)).resolves.toMatchObject({
        skus: [],
        stale: true,
      });
    });

    it('the OPERATOR PIN still short-circuits an unavailable endpoint (an offline node keeps working)', async () => {
      const { resolver } = build({
        endpointUnavailable: 'AbortError',
        workspaces: { [WS]: ['customer-ops'] },
      });
      await expect(resolver.resolve(WS)).resolves.toEqual({
        skus: ['customer-ops'],
        source: 'operator-cache',
        stale: false,
      });
    });

    it('UNCONFIGURED (no endpoint at all) is still null — the shipping default is untouched', async () => {
      const { resolver } = build({});
      await expect(resolver.resolve(WS)).resolves.toEqual({
        skus: null,
        source: 'none',
        stale: false,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // The per-call max-age, i.e. how the JWT lane keeps its pre-resolver freshness.
  // ---------------------------------------------------------------------------
  describe('maxAgeMs', () => {
    it('maxAgeMs: 0 NEVER serves the cache — an operator pin edit lands immediately', async () => {
      const t0 = 1_800_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(t0); // time does not advance at all

      const workspaces: Record<string, unknown> = { [WS]: ['customer-ops'] };
      const { resolver, prisma } = build({ workspaces });

      await expect(resolver.skusFor(WS, { maxAgeMs: 0 })).resolves.toEqual(['customer-ops']);
      expect((prisma as any).workspace.findUnique).toHaveBeenCalledTimes(1);

      // Operator revokes the pin. NO time passes — well inside the 60s TTL.
      workspaces[WS] = [];

      await expect(resolver.skusFor(WS, { maxAgeMs: 0 })).resolves.toEqual([]);
      expect((prisma as any).workspace.findUnique).toHaveBeenCalledTimes(2);
    });

    it('a maxAgeMs-0 read still WARMS the cache for the lanes that accept staleness', async () => {
      const t0 = 1_800_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(t0);
      const { resolver, prisma } = build({ workspaces: { [WS]: ['customer-ops'] } });

      await resolver.skusFor(WS, { maxAgeMs: 0 });
      expect((prisma as any).workspace.findUnique).toHaveBeenCalledTimes(1);

      // The PAT lane (default TTL) reuses it — no second source read.
      await expect(resolver.skusFor(WS)).resolves.toEqual(['customer-ops']);
      expect((prisma as any).workspace.findUnique).toHaveBeenCalledTimes(1);
    });

    it('omitting maxAgeMs keeps the default TTL (the PAT lane is unchanged)', async () => {
      const t0 = 1_800_000_000_000;
      const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
      const workspaces: Record<string, unknown> = { [WS]: ['customer-ops'] };
      const { resolver, prisma } = build({ workspaces });

      await resolver.skusFor(WS);
      workspaces[WS] = [];
      now.mockReturnValue(t0 + TTL - 1);
      await expect(resolver.skusFor(WS)).resolves.toEqual(['customer-ops']);
      expect((prisma as any).workspace.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  it('invalidate() drops the cache so an operator refresh is immediate', async () => {
    const workspaces: Record<string, unknown> = { [WS]: ['customer-ops'] };
    const { resolver, prisma } = build({ workspaces });
    await resolver.resolve(WS);
    workspaces[WS] = [];
    resolver.invalidate(WS);
    await expect(resolver.resolve(WS)).resolves.toMatchObject({ skus: [] });
    expect((prisma as any).workspace.findUnique).toHaveBeenCalledTimes(2);
  });
});

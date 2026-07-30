import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementsService } from '../../entitlements/entitlements.service';
import { MembershipService } from './membership.service';
import { WorkspaceContextService } from './workspace-context.service';
import {
  ENTITLEMENTS_DEGRADED_MARKER,
  WorkspaceEntitlementsResolver,
} from './workspace-entitlements.resolver';
import { runInEntitlementRequestScope } from './entitlement-request-scope';
import { WithWorkspaceClaim } from './workspace.util';

/**
 * ROUND-3 HARDENING of the server-side workspace-entitlement lane.
 *
 * These pin the four problems the round-2 fixes themselves introduced, and the
 * one posture decision they made silently. Each `describe` names the regression
 * it exists to catch; every assertion here is written so that REVERTING the
 * corresponding production change turns it red.
 *
 *   1. REQUEST AMPLIFICATION — the JWT lane's `maxAgeMs: 0` (which is what makes
 *      an operator pin edit land on the very next request) multiplied ONE inbound
 *      request into one outbound fetch + one mirror UPSERT PER CALL SITE, and
 *      `effectiveEntitlements` has ~12 of them. Fixed with a REQUEST-SCOPED memo,
 *      not a TTL, so the freshness property survives.
 *   2. TRANSIENT-BLIP CACHE POISONING — a failed resolve was written into the
 *      shared cache at the SUCCESS TTL, so a 1s endpoint blip denied the PAT lane
 *      for a full 60s after recovery.
 *   4. DEAD AFFORDANCE — `isWorkspaceLookupConfigured()` existed with no
 *      production caller; the workspace lane now gates on it.
 *   5. OUTAGE POSTURE — fail-closed stays the DEFAULT, is now named, and is loud.
 *
 * (3 — the blank-`DEFAULT_WORKSPACE_ID` PAT brick — lives in
 * auth/pat/pat-blank-workspace.spec.ts, next to the code it protects.)
 */

const WS = '0190a000-7e57-7000-8000-0000000000a1';
const ENDPOINT = 'https://ops-center.test/api/v1/entitlements';
const TTL = 60_000;
/** Must match DEFAULT_FAILURE_TTL_MS in the resolver. */
const FAILURE_TTL = 1_000;

const user = {
  id: 'user-aaron',
  email: 'aaron@magicunicorn.tech',
  isActive: true,
} as User;

function claimUser(skus: string[]): User & Partial<WithWorkspaceClaim> {
  const u = { ...user } as User & Partial<WithWorkspaceClaim>;
  u.__entitlements = skus;
  return u;
}

interface WorldOpts {
  /** Omit to configure the service credential; false = URL only (lane inert). */
  serviceToken?: boolean;
  posture?: string;
  failureTtlMs?: string;
  /** Mirror row for WS, if any. */
  mirror?: { skus: string[]; expiresAt: Date | null };
}

function world(opts: WorldOpts = {}) {
  const upserts: any[] = [];
  const prisma = {
    workspace: {
      // No operator pin anywhere: the endpoint is the only source, which is the
      // configuration these regressions actually bite in.
      findUnique: jest.fn(async () => null),
    },
    workspaceEntitlement: {
      findUnique: jest.fn(async () => opts.mirror ?? null),
      upsert: jest.fn(async (a: any) => {
        upserts.push(a);
        return a.create;
      }),
    },
  } as unknown as PrismaService;

  const env: Record<string, string | undefined> = {
    ENTITLEMENTS_ENDPOINT_URL: ENDPOINT,
    // A dummy credential value; never logged by the code under test.
    ENTITLEMENTS_SERVICE_TOKEN: opts.serviceToken === false ? undefined : 'svc-cred',
    WORKSPACE_ENTITLEMENTS_TTL_MS: String(TTL),
    WORKSPACE_ENTITLEMENTS_OUTAGE_POSTURE: opts.posture,
    WORKSPACE_ENTITLEMENTS_FAILURE_TTL_MS: opts.failureTtlMs,
  };
  const config = {
    get: (k: string, d?: unknown) => (k in env ? env[k] : d),
  } as unknown as ConfigService;

  const entitlements = new EntitlementsService(config);
  const resolver = new WorkspaceEntitlementsResolver(prisma, config, entitlements);
  const membership = {} as unknown as MembershipService;
  const workspaces = new WorkspaceContextService(config, prisma, membership, resolver);

  return { resolver, workspaces, entitlements, prisma, upserts };
}

/** Stub `fetch`; each queued entry is one endpoint answer (or a failure). */
function stubFetch(): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ entitlements: ['customer_ops_access'] }),
  }));
  (global as any).fetch = fn;
  return fn as unknown as jest.Mock;
}

afterEach(() => {
  jest.restoreAllMocks();
  delete (global as any).fetch;
});

// ---------------------------------------------------------------------------
// 1. REQUEST AMPLIFICATION
// ---------------------------------------------------------------------------
describe('one resolve per workspace per REQUEST (not per call site)', () => {
  it('N effectiveEntitlements call sites in ONE request ⇒ exactly ONE fetch and ONE mirror UPSERT', async () => {
    const fetchMock = stubFetch();
    const { workspaces, upserts } = world();
    const u = claimUser(['customer-ops']);

    // Five of the twelve production call sites, back to back, inside one request.
    const results = await runInEntitlementRequestScope(async () => {
      const out: string[][] = [];
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        out.push(await workspaces.effectiveEntitlements(u, WS));
      }
      return out;
    });

    expect(results).toEqual(Array(5).fill(['customer-ops']));
    // THE DEFECT, in one assertion: this used to be 5.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(upserts).toHaveLength(1);
  });

  it('CONCURRENT call sites in one request collapse onto one in-flight fetch', async () => {
    const fetchMock = stubFetch();
    const { workspaces, upserts } = world();
    const u = claimUser(['customer-ops']);

    await runInEntitlementRequestScope(() =>
      Promise.all([1, 2, 3, 4, 5, 6].map(() => workspaces.effectiveEntitlements(u, WS))),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(upserts).toHaveLength(1);
  });

  it('a SECOND request RE-FETCHES — the memo buys no cross-request staleness', async () => {
    const fetchMock = stubFetch();
    const { workspaces } = world();
    const u = claimUser(['customer-ops']);

    // Time does NOT advance: well inside the 60s TTL. A time-based fix would
    // serve request #2 from cache; a request-scoped memo must not.
    const t0 = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);

    await runInEntitlementRequestScope(() => workspaces.effectiveEntitlements(u, WS));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await runInEntitlementRequestScope(() => workspaces.effectiveEntitlements(u, WS));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('the memo is scoped to the WORKSPACE too — two workspaces in one request ⇒ two fetches', async () => {
    const fetchMock = stubFetch();
    const { workspaces } = world();
    const u = claimUser(['customer-ops']);
    const other = '0190a000-7e57-7000-8000-0000000000b2';

    await runInEntitlementRequestScope(async () => {
      await workspaces.effectiveEntitlements(u, WS);
      await workspaces.effectiveEntitlements(u, other);
      await workspaces.effectiveEntitlements(u, WS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('OUTSIDE a request there is no memo — the pre-existing per-call behaviour is untouched', async () => {
    const fetchMock = stubFetch();
    const { workspaces } = world();
    const u = claimUser(['customer-ops']);
    const t0 = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);

    // This is the measurement from the report, reproduced: the JWT lane's
    // maxAgeMs-0 default means no cache, so with no request scope each call
    // re-reads the source. Middleware supplies the scope in production.
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await workspaces.effectiveEntitlements(u, WS);
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

// ---------------------------------------------------------------------------
// 2. TRANSIENT-BLIP CACHE POISONING
// ---------------------------------------------------------------------------
describe('a failed resolve is NOT cached at the success TTL', () => {
  it('a 1s blip does not deny for 60s: the PAT lane recovers within the FAILURE ttl', async () => {
    const fetchMock = stubFetch();
    const { resolver } = world();
    const t0 = 1_800_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);

    // The blip.
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'FetchError' }));
    await expect(resolver.resolve(WS)).resolves.toEqual({
      skus: [],
      source: 'source-unavailable',
      stale: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Endpoint has recovered. Inside the FAILURE window the deny is still served
    // (that window exists to collapse a burst onto one upstream attempt)…
    now.mockReturnValue(t0 + FAILURE_TTL - 1);
    await expect(resolver.resolve(WS)).resolves.toMatchObject({ skus: [], stale: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // …but it is a SECOND-scale window, not the 60s success TTL. This is the
    // whole defect: at t0+1s the lane is live again, not at t0+60s.
    now.mockReturnValue(t0 + FAILURE_TTL);
    const recovered = await resolver.resolve(WS);
    expect(recovered.source).toBe('endpoint');
    expect(recovered.skus).toEqual(expect.arrayContaining(['customer-ops']));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Belt and braces: t0+FAILURE_TTL is nowhere near the success TTL.
    expect(FAILURE_TTL).toBeLessThan(TTL);
  });

  it('a maxAgeMs-0 (JWT) failure does not poison the shared cache the PAT lane reads', async () => {
    const fetchMock = stubFetch();
    const { resolver } = world();
    const t0 = 1_800_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);

    fetchMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'FetchError' }));
    // The JWT lane reads with maxAgeMs 0 and WRITES its answer to the shared cache.
    await expect(resolver.skusFor(WS, { maxAgeMs: 0 })).resolves.toEqual([]);

    // The PAT lane (default TTL) a second later must NOT inherit that deny.
    now.mockReturnValue(t0 + FAILURE_TTL);
    await expect(resolver.skusFor(WS)).resolves.toEqual(
      expect.arrayContaining(['customer-ops']),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a SUCCESS is still cached for the full success TTL (the bounded window is unchanged)', async () => {
    const fetchMock = stubFetch();
    const { resolver } = world();
    const t0 = 1_800_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);

    await resolver.resolve(WS);
    now.mockReturnValue(t0 + TTL - 1);
    await resolver.resolve(WS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now.mockReturnValue(t0 + TTL);
    await resolver.resolve(WS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('WORKSPACE_ENTITLEMENTS_FAILURE_TTL_MS=0 means failures are never served from cache', async () => {
    const fetchMock = stubFetch();
    const { resolver } = world({ failureTtlMs: '0' });
    expect(resolver.failureTtlMs).toBe(0);
    const t0 = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(t0); // no time passes at all

    fetchMock.mockRejectedValue(Object.assign(new Error('boom'), { name: 'FetchError' }));
    await resolver.resolve(WS);
    await resolver.resolve(WS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('the failure ttl defaults to a SECOND-scale window, separate from the success ttl', () => {
    const { resolver } = world();
    expect(resolver.failureTtlMs).toBe(FAILURE_TTL);
    expect(resolver.cacheTtlMs).toBe(TTL);
    expect(resolver.failureTtlMs).toBeLessThan(resolver.cacheTtlMs);
  });
});

// ---------------------------------------------------------------------------
// 4. isWorkspaceLookupConfigured() HAS A PRODUCTION CALLER
// ---------------------------------------------------------------------------
describe('the server-side lane gates on isWorkspaceLookupConfigured(), not isConfigured()', () => {
  it('URL set but NO service credential ⇒ the resolver never attempts the lookup', async () => {
    const fetchMock = stubFetch();
    const { resolver, entitlements } = world({ serviceToken: false });
    const lookup = jest.spyOn(entitlements, 'lookupWorkspace');

    // `isConfigured()` (URL only) is TRUE here — that is exactly the footgun.
    expect(entitlements.isConfigured()).toBe(true);
    expect(entitlements.isWorkspaceLookupConfigured()).toBe(false);

    await expect(resolver.resolve(WS)).resolves.toEqual({
      skus: null,
      source: 'none',
      stale: false,
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('URL AND credential ⇒ the lookup runs and the endpoint is authoritative', async () => {
    stubFetch();
    const { resolver, entitlements } = world();
    const lookup = jest.spyOn(entitlements, 'lookupWorkspace');
    expect(entitlements.isWorkspaceLookupConfigured()).toBe(true);
    await expect(resolver.resolve(WS)).resolves.toMatchObject({ source: 'endpoint' });
    expect(lookup).toHaveBeenCalledWith(WS);
  });
});

// ---------------------------------------------------------------------------
// 5. OUTAGE POSTURE — an explicit, documented, DEFAULT-fail-closed decision
// ---------------------------------------------------------------------------
describe('WORKSPACE_ENTITLEMENTS_OUTAGE_POSTURE', () => {
  function downWorld(posture?: string) {
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValue(Object.assign(new Error('down'), { name: 'FetchError' }));
    return { ...world({ posture }), fetchMock };
  }

  it('DEFAULT (unset) is fail-CLOSED: an unreachable source denies', async () => {
    const { resolver, workspaces } = downWorld();
    expect(resolver.outagePosture).toBe('deny');
    await expect(resolver.resolve(WS)).resolves.toEqual({
      skus: [],
      source: 'source-unavailable',
      stale: true,
    });
    // …and that is what a paying JWT user actually sees on every gate.
    await expect(
      workspaces.effectiveEntitlements(claimUser(['customer-ops']), WS),
    ).resolves.toEqual([]);
  });

  it('an UNRECOGNISED posture value falls back to deny (a typo is not a licence to fail open)', async () => {
    const { resolver } = downWorld('yolo');
    expect(resolver.outagePosture).toBe('deny');
    await expect(resolver.resolve(WS)).resolves.toMatchObject({ skus: [], stale: true });
  });

  it('posture=trust-claim is the OPT-IN availability trade: the claim is honoured during an outage', async () => {
    const { resolver, workspaces } = downWorld('trust-claim');
    expect(resolver.outagePosture).toBe('trust-claim');
    const got = await resolver.resolve(WS);
    // `null` reads downstream as "no server-side opinion" ⇒ trust the claim…
    expect(got.skus).toBeNull();
    // …but it is still flagged indeterminate, so PAT MINTING keeps refusing.
    expect(got.stale).toBe(true);
    await expect(
      workspaces.effectiveEntitlements(claimUser(['customer-ops']), WS),
    ).resolves.toEqual(['customer-ops']);
  });

  it('posture=deny is accepted explicitly and behaves as the default', async () => {
    const { resolver } = downWorld('deny');
    expect(resolver.outagePosture).toBe('deny');
    await expect(resolver.resolve(WS)).resolves.toMatchObject({ skus: [], stale: true });
  });

  it('logs a LOUD, greppable line the moment it starts serving degraded answers', async () => {
    const errors: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
      errors.push(String(m));
    });
    const { resolver } = downWorld();
    await resolver.resolve(WS);

    const line = errors.find((e) => e.includes(ENTITLEMENTS_DEGRADED_MARKER));
    expect(line).toBeDefined();
    // An operator must be able to read the posture + the consequence off the log.
    expect(line).toContain('posture=deny');
    expect(line).toContain('serving DENIALS');
    expect(line).toContain('workspaceLookupConfigured=true');
  });

  it('says so when the degraded posture is the FAIL-OPEN one', async () => {
    const errors: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
      errors.push(String(m));
    });
    const { resolver } = downWorld('trust-claim');
    await resolver.resolve(WS);
    const line = errors.find((e) => e.includes(ENTITLEMENTS_DEGRADED_MARKER));
    expect(line).toContain('fail-OPEN');
  });
});

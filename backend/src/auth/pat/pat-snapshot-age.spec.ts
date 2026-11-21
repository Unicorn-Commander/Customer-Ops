import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipService } from '../../common/workspace/membership.service';
import { WorkspaceEntitlementsResolver } from '../../common/workspace/workspace-entitlements.resolver';
import { AgentInferenceClient } from '../../agents/inference/agent-inference.client';
import { PatService } from './pat.service';

/**
 * PAT entitlement snapshot age is opt-in, and a missing in-process claim is
 * not a deny. A new PAT is not immortal.
 *
 * Choice (a) from the dogfood sendback: the age cap applies only when a
 * durable source exists. `skusFor === null` and no durable owner claim means
 * keep the mint snapshot (today's behaviour) and log. The cap is off when
 * `PAT_ENTITLEMENT_SNAPSHOT_MAX_AGE_HOURS` is unset. A process-local JWT map
 * is not a durable source, so enforce + no server source + a stale snapshot +
 * no claim in this process must NOT become `[]`.
 *
 * Also pinned: open mode is a log-only no-op when the cap is on; a server-side
 * source still wins; omitted expiresAt defaults to 90 days; a legacy null
 * expiresAt still works and is logged by id once per process; 0 hours is
 * refused at startup (it would mark every snapshot stale).
 */

const WS = '0190a000-7e57-7000-8000-00000000c007';
const HOUR = 3_600_000;

const aaron = {
  id: 'user-aaron',
  email: 'aaron@example.com',
  keycloakId: 'kc-aaron',
  isActive: true,
} as User;

function payingUser(skus: string[]): User {
  return { ...aaron, __entitlements: skus } as User;
}

function configOf(env: Record<string, string> = {}): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

function harness(
  env: Record<string, string> = {},
  server: string[] | null = null,
  memberships?: { workspaceId: string; isDefault?: boolean }[],
) {
  const store: any[] = [];
  const prisma = {
    personalAccessToken: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `pat-${store.length + 1}`,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
          ...data,
        };
        store.push(row);
        return row;
      }),
      findMany: jest.fn(async () => {
        const now = Date.now();
        return store
          .filter(
            (r) =>
              r.revokedAt == null &&
              (r.expiresAt == null || new Date(r.expiresAt).getTime() > now),
          )
          .map((r) => ({ ...r, user: aaron }));
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = store.find((x) => x.id === where.id);
        Object.assign(r, data);
        return r;
      }),
    },
  } as unknown as PrismaService;
  const membership = {
    resolveAndAuthorize: jest.fn(async (_u: User, req?: string | null) => req ?? WS),
    ...(memberships
      ? { listActiveMemberships: jest.fn(async () => memberships) }
      : {}),
  } as unknown as MembershipService;
  const resolver = {
    skusFor: jest.fn(async () => server),
    resolve: jest.fn(async () => ({ skus: server, source: server ? 'operator-cache' : 'none', stale: false })),
  } as unknown as WorkspaceEntitlementsResolver;
  const service = new PatService(prisma, membership, resolver, configOf(env));
  return { service, store };
}

function enforceGate(): AgentInferenceClient {
  return new AgentInferenceClient(
    configOf({ AGENT_INFERENCE_BASE_URL: 'https://gateway.example.com', UC_ENTITLEMENT_MODE: 'enforce' }),
  );
}

describe('PAT entitlement snapshot age and default expiry', () => {
  let warns: string[];

  beforeEach(() => {
    warns = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: any) => {
      warns.push(String(m));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('honours a fresh snapshot when there is no server-side source (paying org, enforce)', async () => {
    const { service } = harness();
    const minted = await service.create(payingUser(['customer-ops']), { name: 'agent' });
    const resolved = await service.findByPlaintext(minted.plaintext);
    expect(resolved!.entitlements).toEqual(['customer-ops']);
    const decision = enforceGate().checkEntitlement(
      { workspaceId: WS, ucUid: 'kc-aaron', entitlements: resolved!.entitlements },
      'bundled',
    );
    expect(decision.allowed).toBe(true);
  });

  it('enforce + no server source + stale snapshot + no claim in this process keeps the snapshot', async () => {
    // The dogfood shape: cap explicitly on, workspace source null, snapshot
    // older than the cap, and this process has not seen a human JWT. Must not
    // become [] (that 403'd working machine PATs).
    const { service, store } = harness({ PAT_ENTITLEMENT_SNAPSHOT_MAX_AGE_HOURS: '24' });
    const minted = await service.create(payingUser(['customer-ops', 'ai-metered']), { name: 'agent' });
    store[0].createdAt = new Date(Date.now() - 25 * HOUR);

    const resolved = await service.findByPlaintext(minted.plaintext);
    expect(resolved!.entitlements).toEqual(['customer-ops', 'ai-metered']);
    expect(
      enforceGate().checkEntitlement(
        { workspaceId: WS, ucUid: 'kc-aaron', entitlements: resolved!.entitlements },
        'bundled',
      ).allowed,
    ).toBe(true);
    expect(warns.some((w) => w.includes(store[0].id) && /keeping the mint snapshot/i.test(w))).toBe(
      true,
    );
    expect(warns.join('\n')).not.toMatch(/co_pat_/);
  });

  it('unset PAT_ENTITLEMENT_SNAPSHOT_MAX_AGE_HOURS leaves the cap off (enforce, 48h snapshot stands)', async () => {
    const { service, store } = harness();
    const minted = await service.create(payingUser(['customer-ops']), { name: 'agent' });
    store[0].createdAt = new Date(Date.now() - 48 * HOUR);

    const resolved = await service.findByPlaintext(minted.plaintext);
    expect(resolved!.entitlements).toEqual(['customer-ops']);
    expect(warns.some((w) => /snapshot is older/i.test(w))).toBe(false);
  });

  it('a server-side source still wins for an old snapshot, so a paying workspace is not refused', async () => {
    const { service, store } = harness({}, ['customer-ops']);
    const minted = await service.create(payingUser(['customer-ops', 'ai-metered']), { name: 'agent' });
    store[0].createdAt = new Date(Date.now() - 48 * HOUR);

    const resolved = await service.findByPlaintext(minted.plaintext);
    expect(resolved!.entitlements).toEqual(['customer-ops']);
  });

  it('open mode with the cap on keeps the stale snapshot and only logs', async () => {
    const { service, store } = harness({
      UC_ENTITLEMENT_MODE: 'open',
      PAT_ENTITLEMENT_SNAPSHOT_MAX_AGE_HOURS: '24',
    });
    const minted = await service.create(payingUser(['customer-ops']), { name: 'agent' });
    store[0].createdAt = new Date(Date.now() - 48 * HOUR);

    const resolved = await service.findByPlaintext(minted.plaintext);
    expect(resolved!.entitlements).toEqual(['customer-ops']);
    expect(warns.some((w) => w.includes(store[0].id) && /open/i.test(w))).toBe(true);
    expect(warns.join('\n')).not.toMatch(/co_pat_/);
  });

  it('a snapshot inside a set cap is kept with no age log', async () => {
    const { service, store } = harness({ PAT_ENTITLEMENT_SNAPSHOT_MAX_AGE_HOURS: '24' });
    const minted = await service.create(payingUser(['customer-ops']), { name: 'agent' });
    store[0].createdAt = new Date(Date.now() - 2 * HOUR);
    expect((await service.findByPlaintext(minted.plaintext))!.entitlements).toEqual(['customer-ops']);
    expect(warns.some((w) => /snapshot is older/i.test(w))).toBe(false);
  });

  it('refuses to start when PAT_ENTITLEMENT_SNAPSHOT_MAX_AGE_HOURS is 0 or not a positive integer', () => {
    for (const bad of ['0', '-1', '0.5', 'nope', '00']) {
      expect(() => harness({ PAT_ENTITLEMENT_SNAPSHOT_MAX_AGE_HOURS: bad })).toThrow(
        /PAT_ENTITLEMENT_SNAPSHOT_MAX_AGE_HOURS/,
      );
    }
    expect(() => harness({ PAT_ENTITLEMENT_SNAPSHOT_MAX_AGE_HOURS: '24' })).not.toThrow();
  });

  it('omitting expiresAt mints a 90-day token; an explicit expiry is kept', async () => {
    const { service, store } = harness();
    const before = Date.now();
    const minted = await service.create(payingUser(['customer-ops']), { name: 'agent' });
    const exp = new Date(minted.expiresAt as Date).getTime();
    expect(exp).toBeGreaterThan(before + 89 * 86_400_000);
    expect(exp).toBeLessThan(before + 91 * 86_400_000);

    const explicit = new Date(Date.now() + 10 * 86_400_000);
    const second = await service.create(payingUser(['customer-ops']), {
      name: 'dated',
      expiresAt: explicit,
    });
    expect(new Date(second.expiresAt as Date).getTime()).toBe(explicit.getTime());
    expect(store).toHaveLength(2);
  });

  it('PAT_DEFAULT_EXPIRY_DAYS overrides the 90-day default', async () => {
    const { service } = harness({ PAT_DEFAULT_EXPIRY_DAYS: '7' });
    const before = Date.now();
    const minted = await service.create(payingUser([]), { name: 'week' });
    const exp = new Date(minted.expiresAt as Date).getTime();
    expect(exp).toBeGreaterThan(before + 6 * 86_400_000);
    expect(exp).toBeLessThan(before + 8 * 86_400_000);
  });

  it('a legacy null-expiry PAT still resolves, and its id is logged once per process', async () => {
    const { service, store } = harness();
    const minted = await service.create(payingUser(['customer-ops']), { name: 'legacy' });
    store[0].id = 'pat-legacy-null-expiry';
    store[0].expiresAt = null;
    store[0].createdAt = new Date();

    const first = await service.findByPlaintext(minted.plaintext);
    expect(first).not.toBeNull();
    expect(first!.entitlements).toEqual(['customer-ops']);
    const hits = () => warns.filter((w) => w.includes(store[0].id) && /expiresAt|null-expiry|no expiry/i.test(w));
    expect(hits()).toHaveLength(1);

    await service.findByPlaintext(minted.plaintext);
    expect(hits()).toHaveLength(1);
  });
});

describe('PAT mint binds a null server-side source to one workspace', () => {
  const WS_PAID = '0190a000-7e57-7000-8000-0000000000a1';
  const WS_OTHER = '0190a000-7e57-7000-8000-0000000000b2';
  const both = [
    { workspaceId: WS_PAID, isDefault: true },
    { workspaceId: WS_OTHER, isDefault: false },
  ];
  let warns: string[];

  beforeEach(() => {
    warns = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: any) => {
      warns.push(String(m));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  function named(workspaceId: string): User {
    const u = payingUser(['customer-ops']) as User & { __entitlementClaimWorkspaceId?: string };
    u.__entitlementClaimWorkspaceId = workspaceId;
    return u;
  }

  it('enforce: a claim that names W1 is kept on a W1 PAT and dropped on a W2 PAT', async () => {
    const { service } = harness({}, null, both);
    const paid = await service.create(named(WS_PAID), { name: 'paid', workspaceId: WS_PAID });
    expect(paid.entitlements).toEqual(['customer-ops']);
    const other = await service.create(named(WS_PAID), { name: 'other', workspaceId: WS_OTHER });
    expect(other.entitlements).toEqual([]);
  });

  it('enforce: with no workspace on the claim, only the primary workspace keeps the SKU', async () => {
    const { service } = harness({}, null, both);
    const paid = await service.create(payingUser(['customer-ops']), {
      name: 'paid',
      workspaceId: WS_PAID,
    });
    expect(paid.entitlements).toEqual(['customer-ops']);
    const other = await service.create(payingUser(['customer-ops']), {
      name: 'other',
      workspaceId: WS_OTHER,
    });
    expect(other.entitlements).toEqual([]);
  });

  it('the single-workspace case still snapshots the claim', async () => {
    const { service } = harness({}, null, [{ workspaceId: WS, isDefault: true }]);
    const minted = await service.create(payingUser(['customer-ops']), { name: 'only' });
    expect(minted.workspaceId).toBe(WS);
    expect(minted.entitlements).toEqual(['customer-ops']);
  });

  it('open mode keeps the W2 snapshot and only logs', async () => {
    const { service } = harness({ UC_ENTITLEMENT_MODE: 'open' }, null, both);
    const minted = await service.create(named(WS_PAID), { name: 'other', workspaceId: WS_OTHER });
    expect(minted.entitlements).toEqual(['customer-ops']);
    expect(warns.some((w) => /open/i.test(w) && w.includes(WS_OTHER))).toBe(true);
    expect(warns.join('\n')).not.toMatch(/co_pat_/);
  });

  it('with the cap on and no durable source, a stale snapshot is kept (mint-time bind is what refuses W2)', async () => {
    const { service, store } = harness(
      { PAT_ENTITLEMENT_SNAPSHOT_MAX_AGE_HOURS: '24' },
      null,
      both,
    );
    const minted = await service.create(named(WS_PAID), { name: 'paid', workspaceId: WS_PAID });
    store[0].createdAt = new Date(Date.now() - 25 * HOUR);
    const resolved = await service.findByPlaintext(minted.plaintext);
    expect(resolved!.entitlements).toEqual(['customer-ops']);
  });
});

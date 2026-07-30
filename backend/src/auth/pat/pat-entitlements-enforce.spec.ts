import { ExecutionContext, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipService } from '../../common/workspace/membership.service';
import { WorkspaceContextService } from '../../common/workspace/workspace-context.service';
import { WorkspaceEntitlementsResolver } from '../../common/workspace/workspace-entitlements.resolver';
import { EntitlementsService } from '../../entitlements/entitlements.service';
import { WithWorkspaceClaim } from '../../common/workspace/workspace.util';
import { AgentInferenceClient } from '../../agents/inference/agent-inference.client';
import { InferenceContext } from '../../agents/inference/agent-inference.port';
import { mcpToolDenial } from '../../mcp/mcp-access';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { REQUIRE_SCOPES_KEY } from '../decorators/require-scopes.decorator';
import { PatService } from './pat.service';
import { hashPat } from './pat.util';

/**
 * THE PAT LANE UNDER UC_ENTITLEMENT_MODE=enforce — end to end, real components.
 *
 * A `co_pat_` caller has no forwardable user JWT, so the suite entitlements
 * endpoint cannot be asked "what does THIS caller hold". Before this change the
 * only source was a snapshot frozen onto the token row at mint time, taken from
 * the minting SESSION user's union-of-orgs claim. Two defects fell out:
 *
 *   1. NOT REVOCABLE — a SKU revoked at the authority stayed usable until the PAT
 *      itself was revoked or expired (unbounded under-enforcement).
 *   2. NOT WORKSPACE-BOUND — a PAT bound to workspace B carried SKUs the user only
 *      bought in workspace A.
 *
 * The fix resolves the token's BOUND WORKSPACE server-side on every request
 * (WorkspaceEntitlementsResolver, bounded cache) and INTERSECTS it with the
 * snapshot, so the snapshot is a floor that can only ever narrow.
 *
 * Everything below drives the REAL PatService, the REAL JwtAuthGuard stamp, the
 * REAL WorkspaceContextService bind, the REAL MCP tool gate (`mcpToolDenial`)
 * and the REAL entitlement gate (`AgentInferenceClient.checkEntitlement` in
 * enforce mode) — the same gate every gated MCP tool funnels through.
 */

const WS_A = '0190a000-7e57-7000-8000-0000000000a1'; // the workspace that bought customer-ops
const WS_B = '0190a000-7e57-7000-8000-0000000000b2'; // a workspace that did NOT
const TTL = 60_000;

const aaron = {
  id: 'user-aaron',
  email: 'aaron@magicunicorn.tech',
  keycloakId: 'kc-aaron',
  isActive: true,
} as User;

/** The minting session user's live claim: the UNION across every org they're in. */
function sessionUser(claim: string[]): User & Partial<WithWorkspaceClaim> {
  const u = { ...aaron } as User & Partial<WithWorkspaceClaim>;
  u.__entitlements = claim;
  return u;
}

interface WorldOpts {
  /** workspaceId -> server-side SKUs. `undefined` key ⇒ NO server-side source. */
  serverSide?: Record<string, string[]>;
  /** workspaceId -> a mirror row that is already past its expiresAt. */
  expiredMirror?: string[];
  /** make every workspace read throw (DB outage). */
  dbDown?: boolean;
}

function world(opts: WorldOpts = {}) {
  const patRows: any[] = [];
  const serverSide = opts.serverSide ?? {};

  const prisma = {
    personalAccessToken: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `pat-${patRows.length + 1}`,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
          ...data,
        };
        patRows.push(row);
        return row;
      }),
      findMany: jest.fn(async () =>
        patRows
          .filter((r) => r.revokedAt == null)
          .map((r) => ({ ...r, user: aaron })),
      ),
      findUnique: jest.fn(async ({ where }: any) => patRows.find((r) => r.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const r = patRows.find((x) => x.id === where.id);
        Object.assign(r, data);
        return r;
      }),
    },
    workspace: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (opts.dbDown) throw new Error('connection terminated unexpectedly');
        // The operator pin is how a node expresses a workspace's SKUs locally.
        if (where.id in serverSide) return { entitlementCache: serverSide[where.id] };
        return null; // no workspace row ⇒ no operator pin
      }),
    },
    workspaceEntitlement: {
      findUnique: jest.fn(async ({ where }: any) =>
        (opts.expiredMirror ?? []).includes(where.workspaceId)
          ? { skus: ['customer-ops'], expiresAt: new Date(Date.now() - 1) }
          : null,
      ),
      upsert: jest.fn(async (a: any) => a.create),
    },
  } as unknown as PrismaService;

  const config = {
    get: (k: string, d?: unknown) =>
      k === 'WORKSPACE_ENTITLEMENTS_TTL_MS' ? String(TTL) : d,
  } as unknown as ConfigService;

  // The endpoint half stays dormant here (no ENTITLEMENTS_ENDPOINT_URL /
  // ENTITLEMENTS_SERVICE_TOKEN) — this exercises the operator-pin + mirror path.
  const entitlementsSvc = new EntitlementsService(config);
  const resolver = new WorkspaceEntitlementsResolver(prisma, config, entitlementsSvc);

  const membership = {
    resolveAndAuthorize: jest.fn(async (_u: User, req?: string | null) => req ?? WS_A),
  } as unknown as MembershipService;

  const pats = new PatService(prisma, membership, resolver);
  const workspaces = new WorkspaceContextService(config, prisma, membership, resolver);

  return { pats, resolver, workspaces, prisma, patRows, serverSide };
}

/** The production gate, in enforce mode with a configured gateway. */
function enforceGate(): AgentInferenceClient {
  const config = {
    get: (k: string) =>
      ({ AGENT_INFERENCE_BASE_URL: 'https://gateway.test', UC_ENTITLEMENT_MODE: 'enforce' })[k],
  } as unknown as ConfigService;
  return new AgentInferenceClient(config);
}

/** The REAL guard, driven by the REAL PatService — returns the mutated request. */
async function authenticate(pats: PatService, plaintext: string, scopes: string[]) {
  const request: any = { headers: { authorization: `Bearer ${plaintext}` }, params: {} };
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => (key === REQUIRE_SCOPES_KEY ? scopes : undefined)),
  };
  const moduleRef = { get: jest.fn().mockReturnValue(pats) };
  const ctx = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  await new JwtAuthGuard(reflector as any, moduleRef as any).canActivate(ctx);
  return request;
}

/**
 * The full gated-MCP-tool decision for an authenticated request:
 * PAT scope/workspace fence (mcpToolDenial) -> (user, workspace) entitlement
 * bind -> the enforce-mode entitlement gate. Mirrors McpService's wrapper +
 * the agents' `checkEntitlement` call.
 */
async function callGatedMcpTool(
  workspaces: WorkspaceContextService,
  request: any,
  toolName: string,
  args: Record<string, unknown>,
) {
  const grantedScopes: string[] | null = request.pat?.scopes ?? null;
  const boundWorkspaceId: string | null = request.pat?.workspaceId ?? null;

  const denial = mcpToolDenial(toolName, args, grantedScopes, boundWorkspaceId);
  if (denial) {
    // The MCP gate denies with an isError envelope, not a throw; the reason code
    // lives in the JSON body ('scope_denied' | 'workspace_denied').
    const body = JSON.parse(denial.content[0].text) as { error: string };
    return { ok: false as const, stage: 'mcp' as const, error: body.error };
  }

  const workspaceId = (args.workspace_id as string) ?? boundWorkspaceId ?? WS_A;
  const effective = await workspaces.effectiveEntitlements(request.user, workspaceId);
  const ctx: InferenceContext = {
    workspaceId,
    ucUid: request.user.__ucUid ?? null,
    entitlements: effective,
  };
  const decision = enforceGate().checkEntitlement(ctx, 'bundled');
  return decision.allowed
    ? { ok: true as const, stage: 'gate' as const, effective }
    : { ok: false as const, stage: 'gate' as const, error: decision.reason, effective };
}

describe('PAT lane × entitlements under UC_ENTITLEMENT_MODE=enforce', () => {
  afterEach(() => jest.restoreAllMocks());

  it('MONEY: an ENTITLED PAT reaches a gated MCP tool', async () => {
    const { pats, workspaces } = world({ serverSide: { [WS_A]: ['customer-ops', 'ai-metered'] } });
    const minted = await pats.create(sessionUser(['customer-ops', 'ai-metered']), {
      name: 'agent',
      scopes: ['run:agents'],
      workspaceId: WS_A,
    });
    expect(minted.entitlements).toEqual(['customer-ops', 'ai-metered']);

    const req = await authenticate(pats, minted.plaintext, ['run:agents']);
    expect(req.user.__entitlements).toEqual(['customer-ops', 'ai-metered']);

    const res = await callGatedMcpTool(workspaces, req, 'triage_customer', { workspace_id: WS_A });
    expect(res).toMatchObject({ ok: true });
  });

  it('an UNENTITLED PAT is DENIED at the same gated MCP tool', async () => {
    // The workspace exists server-side but holds no customer-ops.
    const { pats, workspaces } = world({ serverSide: { [WS_B]: ['email-ops'] } });
    const minted = await pats.create(sessionUser(['customer-ops']), {
      name: 'agent',
      scopes: ['run:agents'],
      workspaceId: WS_B,
    });
    // The mint snapshot is already workspace-scoped: nothing to carry.
    expect(minted.entitlements).toEqual([]);

    const req = await authenticate(pats, minted.plaintext, ['run:agents']);
    const res = await callGatedMcpTool(workspaces, req, 'triage_customer', { workspace_id: WS_B });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('gate');
    expect(String(res.error)).toMatch(/customer-ops/i);
  });

  it('a PAT bound to workspace A cannot use workspace B’s entitlements', async () => {
    const { pats, workspaces } = world({
      serverSide: { [WS_A]: ['customer-ops'], [WS_B]: ['email-ops'] },
    });
    const minted = await pats.create(sessionUser(['customer-ops']), {
      name: 'agent',
      scopes: ['run:agents'],
      workspaceId: WS_A,
    });
    const req = await authenticate(pats, minted.plaintext, ['run:agents']);

    // Works in its own workspace…
    await expect(
      callGatedMcpTool(workspaces, req, 'triage_customer', { workspace_id: WS_A }),
    ).resolves.toMatchObject({ ok: true });

    // …and is fenced out of B by the MCP workspace check before it can spend
    // A's SKU there.
    const crossed = await callGatedMcpTool(workspaces, req, 'triage_customer', {
      workspace_id: WS_B,
    });
    expect(crossed).toMatchObject({ ok: false, stage: 'mcp', error: 'workspace_denied' });
  });

  it('and the inverse: a PAT bound to B never carries the SKU A bought', async () => {
    const { pats } = world({ serverSide: { [WS_A]: ['customer-ops'], [WS_B]: ['email-ops'] } });
    // The MINTING SESSION carries customer-ops (bought in A) — the union claim.
    const minted = await pats.create(sessionUser(['customer-ops', 'email-ops']), {
      name: 'agent',
      scopes: ['run:agents'],
      workspaceId: WS_B,
    });
    // Bound to B ⇒ only B's SKUs survive the snapshot. A's customer-ops is gone.
    expect(minted.entitlements).toEqual(['email-ops']);
    const req = await authenticate(pats, minted.plaintext, ['run:agents']);
    expect(req.user.__entitlements).toEqual(['email-ops']);
  });

  it('REVOCATION lands within the documented window (the resolver cache TTL)', async () => {
    const t0 = 1_800_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);

    const w = world({ serverSide: { [WS_A]: ['customer-ops'] } });
    const minted = await w.pats.create(sessionUser(['customer-ops']), {
      name: 'agent',
      scopes: ['run:agents'],
      workspaceId: WS_A,
    });
    expect(minted.entitlements).toEqual(['customer-ops']);

    // Entitled today.
    let req = await authenticate(w.pats, minted.plaintext, ['run:agents']);
    await expect(
      callGatedMcpTool(w.workspaces, req, 'triage_customer', { workspace_id: WS_A }),
    ).resolves.toMatchObject({ ok: true });

    // The org cancels: the workspace's server-side set loses customer-ops. The
    // PAT row's frozen snapshot still says ['customer-ops'] — reading THAT is
    // the bug this test pins.
    w.serverSide[WS_A] = [];
    expect(w.patRows[0].entitlements).toEqual(['customer-ops']);

    // Past the bounded cache window, the same unmodified PAT is DENIED.
    now.mockReturnValue(t0 + TTL);
    req = await authenticate(w.pats, minted.plaintext, ['run:agents']);
    expect(req.user.__entitlements).toEqual([]);
    const after = await callGatedMcpTool(w.workspaces, req, 'triage_customer', {
      workspace_id: WS_A,
    });
    expect(after.ok).toBe(false);
    expect(String(after.error)).toMatch(/customer-ops/i);
  });

  it('INDETERMINATE (a source exists but went stale) still DENIES under enforce', async () => {
    // A mirror row exists for WS_A but is past expiresAt and the endpoint is
    // dormant ⇒ the resolver cannot get a current answer. A token minted BEFORE
    // the outage (snapshot written directly) must be denied at auth time.
    const { pats, workspaces, patRows, prisma } = world({ expiredMirror: [WS_A] });
    await (prisma as any).personalAccessToken.create({
      data: {
        userId: aaron.id,
        workspaceId: WS_A,
        name: 'minted-before-the-outage',
        prefix: 'co_pat_',
        tokenHash: await hashPat('co_pat_stale_source_token'),
        scopes: ['run:agents'],
        entitlements: ['customer-ops'],
        expiresAt: null,
      },
    });
    expect(patRows[0].entitlements).toEqual(['customer-ops']);

    const req = await authenticate(pats, 'co_pat_stale_source_token', ['run:agents']);
    expect(req.user.__entitlements).toEqual([]);
    const res = await callGatedMcpTool(workspaces, req, 'triage_customer', { workspace_id: WS_A });
    expect(res.ok).toBe(false);
  });

  it('a DB outage on the entitlement resolve DENIES at AUTH time (fail closed), never widens', async () => {
    const { pats, workspaces, prisma } = world({ dbDown: true });
    // Minting is impossible while the source is down (see the mint-failure suite
    // below), so this is a token minted earlier, used during the outage.
    await (prisma as any).personalAccessToken.create({
      data: {
        userId: aaron.id,
        workspaceId: WS_A,
        name: 'minted-before-the-outage',
        prefix: 'co_pat_',
        tokenHash: await hashPat('co_pat_db_down_token'),
        scopes: ['run:agents'],
        entitlements: ['customer-ops'],
        expiresAt: null,
      },
    });

    const req = await authenticate(pats, 'co_pat_db_down_token', ['run:agents']);
    expect(req.user.__entitlements).toEqual([]); // NOT the frozen snapshot
    const res = await callGatedMcpTool(workspaces, req, 'triage_customer', { workspace_id: WS_A });
    expect(res.ok).toBe(false);
  });

  it('NO server-side source anywhere ⇒ the snapshot is the fallback (documented)', async () => {
    // Nothing pinned, no mirror row: the resolver reports "no source" and the
    // PAT keeps its mint snapshot — the pre-existing shared-SaaS behaviour.
    const { pats, workspaces } = world({});
    const minted = await pats.create(sessionUser(['customer-ops']), {
      name: 'agent',
      scopes: ['run:agents'],
      workspaceId: WS_A,
    });
    expect(minted.entitlements).toEqual(['customer-ops']);
    const req = await authenticate(pats, minted.plaintext, ['run:agents']);
    expect(req.user.__entitlements).toEqual(['customer-ops']);
    await expect(
      callGatedMcpTool(workspaces, req, 'triage_customer', { workspace_id: WS_A }),
    ).resolves.toMatchObject({ ok: true });
  });
});

/**
 * ---------------------------------------------------------------------------
 * MINT MUST FAIL LOUDLY — never persist a permanently-dead credential.
 *
 * `PatService.create` snapshots `claim ∩ serverSide(workspace)` into a COLUMN.
 * `findByPlaintext` only ever re-INTERSECTS that column; it never re-widens it.
 * So an `[]` written because the resolver blipped for one second is not a
 * temporary deny — it is a token that can NEVER work again, handed to the user
 * with a 201 and no error. The mint must refuse instead.
 * ---------------------------------------------------------------------------
 */
describe('PAT mint × an unavailable entitlement source', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a DB outage during mint FAILS the mint (503) — no dead token is persisted', async () => {
    const { pats, patRows } = world({ dbDown: true });
    await expect(
      pats.create(sessionUser(['customer-ops']), {
        name: 'agent',
        scopes: ['run:agents'],
        workspaceId: WS_A,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // Nothing was written: no row, and therefore no permanently-empty snapshot.
    expect(patRows).toHaveLength(0);
  });

  it('an EXPIRED mirror (indeterminate) during mint FAILS the mint — no dead token', async () => {
    const { pats, patRows } = world({ expiredMirror: [WS_A] });
    await expect(
      pats.create(sessionUser(['customer-ops']), {
        name: 'agent',
        scopes: ['run:agents'],
        workspaceId: WS_A,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(patRows).toHaveLength(0);
  });

  it('a resolver that THROWS during mint FAILS the mint — no dead token', async () => {
    const { pats, resolver, patRows } = world({ serverSide: { [WS_A]: ['customer-ops'] } });
    jest
      .spyOn(resolver, 'resolve')
      .mockRejectedValue(new Error('resolver exploded'));

    await expect(
      pats.create(sessionUser(['customer-ops']), {
        name: 'agent',
        scopes: ['run:agents'],
        workspaceId: WS_A,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(patRows).toHaveLength(0);
  });

  it('the error message never leaks the token or the entitlement source internals', async () => {
    const { pats } = world({ dbDown: true });
    await expect(
      pats.create(sessionUser(['customer-ops']), {
        name: 'agent',
        scopes: ['run:agents'],
        workspaceId: WS_A,
      }),
    ).rejects.toThrow(/entitlement source is unavailable/i);
  });

  it('a HEALTHY source still mints normally (the failure path is not overzealous)', async () => {
    const { pats, patRows } = world({ serverSide: { [WS_A]: ['customer-ops'] } });
    const minted = await pats.create(sessionUser(['customer-ops']), {
      name: 'agent',
      scopes: ['run:agents'],
      workspaceId: WS_A,
    });
    expect(minted.entitlements).toEqual(['customer-ops']);
    expect(patRows).toHaveLength(1);
  });
});

/**
 * ---------------------------------------------------------------------------
 * THE TWO CATCH BLOCKS IN PatService, driven for real.
 *
 * Nothing previously pushed an EXCEPTION out of the resolver and into
 * PatService, so both catches were dead text: flipping
 * `effectiveEntitlementsFor`'s `return []` to `return snapshot` (a widening on
 * failure) and `serverSideSkus`' `return []` to `return null` (trust the claim
 * on failure) left the whole suite green. These drive the real
 * WorkspaceEntitlementsResolver instance and make it throw.
 * ---------------------------------------------------------------------------
 */
describe('PatService catch blocks — an exception out of the resolver', () => {
  afterEach(() => jest.restoreAllMocks());

  it('effectiveEntitlementsFor: a THROWING resolver denies ([]), it does not fall back to the snapshot', async () => {
    const { pats, resolver, workspaces } = world({ serverSide: { [WS_A]: ['customer-ops'] } });
    const minted = await pats.create(sessionUser(['customer-ops']), {
      name: 'agent',
      scopes: ['run:agents'],
      workspaceId: WS_A,
    });
    // The snapshot on the row is non-empty — this is what a widening catch would
    // hand back, and what the gate would then happily accept.
    expect(minted.entitlements).toEqual(['customer-ops']);

    // Now the resolver throws on the AUTH path (post-mint outage). `Once` so the
    // later gate call uses the real resolver — this test is about what the PAT
    // lane stamps when the resolve blows up under it, not about the gate.
    jest.spyOn(resolver, 'skusFor').mockRejectedValueOnce(new Error('connection terminated'));

    const req = await authenticate(pats, minted.plaintext, ['run:agents']);
    // The assertion that dies under `return snapshot`:
    expect(req.user.__entitlements).toEqual([]);
    expect(req.user.__entitlements).not.toEqual(['customer-ops']);

    // …and it is a real deny at the gate, not a cosmetic empty array.
    const res = await callGatedMcpTool(workspaces, req, 'triage_customer', { workspace_id: WS_A });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/customer-ops/i);
  });

  it('the request is still AUTHENTICATED when the resolver throws — it just holds no SKUs', async () => {
    const { pats, resolver } = world({ serverSide: { [WS_A]: ['customer-ops'] } });
    const minted = await pats.create(sessionUser(['customer-ops']), {
      name: 'agent',
      scopes: ['run:agents'],
      workspaceId: WS_A,
    });
    jest.spyOn(resolver, 'skusFor').mockRejectedValueOnce(new Error('connection terminated'));

    const req = await authenticate(pats, minted.plaintext, ['run:agents']);
    expect(req.user).toBeDefined();
    expect(req.user.email).toBe('aaron@magicunicorn.tech');
    expect(req.pat).toBeDefined();
  });

  it('serverSideSkus: a THROWING resolver refuses the mint, it does not trust the claim', async () => {
    const { pats, resolver, patRows } = world({ serverSide: { [WS_A]: ['customer-ops'] } });
    jest.spyOn(resolver, 'resolve').mockRejectedValue(new Error('connection terminated'));

    // Under `return null` (trust the claim) this would resolve to a PAT carrying
    // the raw union claim — a WIDENING on failure — instead of throwing.
    await expect(
      pats.create(sessionUser(['customer-ops', 'email-ops']), {
        name: 'agent',
        scopes: ['run:agents'],
        workspaceId: WS_A,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(patRows).toHaveLength(0);
  });
});

/**
 * ---------------------------------------------------------------------------
 * RESIDUAL: `personal_access_tokens.workspaceId` is NULLABLE, and every fence is
 * written `if (workspaceId) { …check… }` — so a NULL does not fail the fence, it
 * SKIPS it. PatService.create cannot produce such a row, but a hand-inserted row
 * or a restored backup can.
 * ---------------------------------------------------------------------------
 */
describe('SENTINEL: a PAT with no bound workspace is never an unfenced token', () => {
  async function insertUnboundPat(prisma: any, plaintext: string) {
    await prisma.personalAccessToken.create({
      data: {
        userId: aaron.id,
        workspaceId: null, // the hand-inserted / legacy row
        name: 'hand-inserted',
        prefix: 'co_pat_',
        tokenHash: await hashPat(plaintext),
        scopes: ['run:agents', 'read:customers'],
        entitlements: ['customer-ops'],
        expiresAt: null,
      },
    });
  }

  it('findByPlaintext REFUSES it (generic 401 path), rather than resolving it unfenced', async () => {
    const { pats, prisma } = world({ serverSide: { [WS_A]: ['customer-ops'] } });
    await insertUnboundPat(prisma as any, 'co_pat_unbound_token_value');
    await expect((pats as any).findByPlaintext('co_pat_unbound_token_value')).resolves.toBeNull();
  });

  it('the guard rejects it with 401 — it never reaches a handler with a free-roaming claim', async () => {
    const { pats, prisma } = world({ serverSide: { [WS_A]: ['customer-ops'] } });
    await insertUnboundPat(prisma as any, 'co_pat_unbound_token_value');
    await expect(
      authenticate(pats, 'co_pat_unbound_token_value', ['run:agents']),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  /**
   * Each of the three fence sites is pinned SEPARATELY and on purpose. They are
   * defence in depth, and defence in depth is worthless if one layer's test
   * passes only because an earlier layer happens to catch the case first — the
   * inner layers then rot silently. So the next two drive the guard and the
   * entitlement bind DIRECTLY, with a PatService that hands back an unbound
   * resolution (as it would if the sentinel above were ever loosened).
   */
  it('JwtAuthGuard rejects an unbound resolution ON ITS OWN, even if PatService hands one over', async () => {
    const unboundResolution = {
      user: { ...aaron },
      token: {
        id: 'pat-unbound',
        scopes: ['run:agents'],
        workspaceId: null,
        entitlements: ['customer-ops'],
      },
      workspaceId: null,
      entitlements: ['customer-ops'],
    };
    const patsDouble = {
      findByPlaintext: jest.fn().mockResolvedValue(unboundResolution),
    } as unknown as PatService;

    // The request explicitly addresses a workspace the token has no claim to.
    const request: any = {
      headers: { authorization: 'Bearer co_pat_forged_unbound' },
      params: { workspaceId: WS_B },
    };
    const reflector = {
      getAllAndOverride: jest.fn((key: string) =>
        key === REQUIRE_SCOPES_KEY ? ['run:agents'] : undefined,
      ),
    };
    const moduleRef = { get: jest.fn().mockReturnValue(patsDouble) };
    const ctx = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;

    await expect(
      new JwtAuthGuard(reflector as any, moduleRef as any).canActivate(ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // It never got a principal, so it never reached a handler.
    expect(request.user).toBeUndefined();
    expect(request.workspaceId).toBeUndefined();
  });

  it('the entitlement bind denies an unbound token ON ITS OWN — it does not hand back the snapshot', async () => {
    const { pats } = world({ serverSide: { [WS_A]: ['customer-ops'] } });
    const unboundRow = {
      id: 'pat-unbound',
      workspaceId: null,
      entitlements: ['customer-ops', 'email-ops'],
    } as any;
    // Reaching past the sentinel on purpose: this is the inner layer's contract.
    await expect((pats as any).effectiveEntitlementsFor(unboundRow)).resolves.toEqual([]);
  });

  it('mcpToolDenial denies an unbound PAT caller instead of waving it through', async () => {
    // The pure-policy third fence site. Previously `if (boundWorkspaceId)` meant
    // a null bound workspace skipped the check and ANY workspace_id was allowed.
    const denial = mcpToolDenial('list_customers', { workspace_id: WS_B }, ['read:customers'], null);
    expect(denial).not.toBeNull();
    expect(JSON.parse(denial!.content[0].text).error).toBe('workspace_denied');

    // …even with no workspace_id arg at all.
    expect(mcpToolDenial('list_customers', {}, ['read:customers'], null)).not.toBeNull();

    // A JWT/federation caller (grantedScopes null) is still untouched.
    expect(mcpToolDenial('list_customers', { workspace_id: WS_B }, null, null)).toBeNull();
  });
});

/**
 * ---------------------------------------------------------------------------
 * OPERATOR FOOTGUN: ENTITLEMENTS_ENDPOINT_URL without ENTITLEMENTS_SERVICE_TOKEN
 * yields ZERO server-side enforcement, forever, silently — while the old boot log
 * printed "Entitlements source: <url>" as though everything were wired.
 * ---------------------------------------------------------------------------
 */
describe('BOOT LOG: half-configured entitlements must be loud', () => {
  afterEach(() => jest.restoreAllMocks());

  function boot(env: Record<string, string>) {
    const logs: string[] = [];
    const warns: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: any) => void logs.push(String(m)));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: any) => void warns.push(String(m)));
    const svc = new EntitlementsService({
      get: (k: string) => env[k],
    } as unknown as ConfigService);
    return { svc, logs, warns };
  }

  it('URL set, SERVICE TOKEN missing ⇒ a WARNING that names the consequence', () => {
    const { svc, warns } = boot({ ENTITLEMENTS_ENDPOINT_URL: 'https://ops.test/api/v1/entitlements' });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/ENTITLEMENTS_SERVICE_TOKEN/);
    expect(warns[0]).toMatch(/DISABLED/);
    expect(warns[0]).toMatch(/enforces\s+NOTHING/i);
    // And the capability read is honest about it.
    expect(svc.isConfigured()).toBe(true); // the USER lane is live…
    expect(svc.isWorkspaceLookupConfigured()).toBe(false); // …the workspace lane is not.
  });

  it('BOTH set ⇒ no warning, and the log says the server-side lane is LIVE', () => {
    const { svc, logs, warns } = boot({
      ENTITLEMENTS_ENDPOINT_URL: 'https://ops.test/api/v1/entitlements',
      ENTITLEMENTS_SERVICE_TOKEN: 'not-a-real-credential',
    });
    expect(warns).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/server-side per-workspace lane LIVE/);
    expect(svc.isWorkspaceLookupConfigured()).toBe(true);
  });

  it('NEITHER set (the shipping default) ⇒ no warning, but the log says INERT', () => {
    const { svc, logs, warns } = boot({});
    expect(warns).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/INERT/);
    expect(svc.isWorkspaceLookupConfigured()).toBe(false);
  });

  it('the boot log NEVER contains the service credential', () => {
    const secret = 'co_svc_super_secret_credential';
    const { logs, warns } = boot({
      ENTITLEMENTS_ENDPOINT_URL: 'https://ops.test/api/v1/entitlements',
      ENTITLEMENTS_SERVICE_TOKEN: secret,
    });
    expect([...logs, ...warns].join('\n')).not.toContain(secret);
  });
});

describe('REGRESSION: the JWT lane is unchanged', () => {
  it('a JWT caller bypasses PAT gating and keeps its raw claim when no source exists', async () => {
    const { workspaces } = world({});
    const jwtUser = sessionUser(['customer-ops', 'ai-metered']) as any;
    jwtUser.__ucUid = 'kc-aaron';

    // No PAT ⇒ grantedScopes null ⇒ mcpToolDenial short-circuits to allow.
    expect(mcpToolDenial('triage_customer', { workspace_id: WS_B }, null, null)).toBeNull();

    // …and the claim is trusted verbatim (no server-side source).
    await expect(workspaces.effectiveEntitlements(jwtUser, WS_A)).resolves.toEqual([
      'customer-ops',
      'ai-metered',
    ]);
    const ctx: InferenceContext = {
      workspaceId: WS_A,
      ucUid: 'kc-aaron',
      entitlements: await workspaces.effectiveEntitlements(jwtUser, WS_A),
    };
    expect(enforceGate().checkEntitlement(ctx, 'bundled').allowed).toBe(true);
  });

  it('a JWT caller IS still bound when the workspace has a server-side source', async () => {
    const { workspaces } = world({ serverSide: { [WS_B]: ['email-ops'] } });
    const jwtUser = sessionUser(['customer-ops']) as any;
    await expect(workspaces.effectiveEntitlements(jwtUser, WS_B)).resolves.toEqual([]);
  });

  it('NO ADDED STALENESS: an operator pin edit lands on the very NEXT JWT request', async () => {
    // Before the resolver existed this lane re-read Workspace.entitlementCache
    // from Postgres every request, so an operator edit was immediate. Routing it
    // through the resolver's 60s cache would silently open a 60-second
    // under-enforcement window here. Time does NOT advance in this test: any
    // cache hit at all would keep serving the revoked SKU.
    const t0 = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(t0);

    const w = world({ serverSide: { [WS_A]: ['customer-ops'] } });
    const jwtUser = sessionUser(['customer-ops']) as any;

    await expect(w.workspaces.effectiveEntitlements(jwtUser, WS_A)).resolves.toEqual([
      'customer-ops',
    ]);

    // The operator revokes the pin. No time passes.
    w.serverSide[WS_A] = [];

    await expect(w.workspaces.effectiveEntitlements(jwtUser, WS_A)).resolves.toEqual([]);
    jest.restoreAllMocks();
  });

  it('the PAT lane still ACCEPTS the bounded cache (the two lanes have different max-age)', async () => {
    const t0 = 1_800_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    const w = world({ serverSide: { [WS_A]: ['customer-ops'] } });
    const minted = await w.pats.create(sessionUser(['customer-ops']), {
      name: 'agent',
      scopes: ['run:agents'],
      workspaceId: WS_A,
    });

    w.serverSide[WS_A] = [];
    now.mockReturnValue(t0 + TTL - 1); // inside the documented window
    const req = await authenticate(w.pats, minted.plaintext, ['run:agents']);
    expect(req.user.__entitlements).toEqual(['customer-ops']);
    jest.restoreAllMocks();
  });

  it('UC_ENTITLEMENT_MODE has no new default: unset still reduces to enforce', () => {
    const unset = new AgentInferenceClient({
      get: (k: string) => ({ AGENT_INFERENCE_BASE_URL: 'https://gateway.test' })[k],
    } as unknown as ConfigService);
    const ctx: InferenceContext = { workspaceId: WS_A, ucUid: null, entitlements: [] };
    expect(unset.checkEntitlement(ctx, 'bundled')).toMatchObject({
      allowed: false,
      mode: 'enforce',
    });
  });

  it('the non-enforcing mode (open) is unchanged for a PAT — allow + warn', async () => {
    const { pats } = world({ serverSide: { [WS_B]: ['email-ops'] } });
    const minted = await pats.create(sessionUser(['customer-ops']), {
      name: 'agent',
      scopes: ['run:agents'],
      workspaceId: WS_B,
    });
    const req = await authenticate(pats, minted.plaintext, ['run:agents']);
    expect(req.user.__entitlements).toEqual([]); // zero SKUs…

    const open = new AgentInferenceClient({
      get: (k: string) =>
        ({ AGENT_INFERENCE_BASE_URL: 'https://gateway.test', UC_ENTITLEMENT_MODE: 'open' })[k],
    } as unknown as ConfigService);
    const ctx: InferenceContext = { workspaceId: WS_B, ucUid: 'kc-aaron', entitlements: [] };
    // …and open mode still allows, exactly as before.
    expect(open.checkEntitlement(ctx, 'bundled')).toMatchObject({ allowed: true, mode: 'open' });
  });
});

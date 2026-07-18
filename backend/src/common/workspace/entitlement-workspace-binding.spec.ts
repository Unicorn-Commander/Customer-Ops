import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipService } from './membership.service';
import { WorkspaceContextService } from './workspace-context.service';
import {
  entitlementKey,
  entitlementsOf,
  intersectEntitlements,
  parseWorkspaceEntitlements,
  WithWorkspaceClaim,
} from './workspace.util';
import { AgentInferenceClient } from '../../agents/inference/agent-inference.client';
import { InferenceContext } from '../../agents/inference/agent-inference.port';

/**
 * (user, workspace) entitlement binding — task 29817abc.
 *
 * Two properties this pins, both MONEY-critical under UC_ENTITLEMENT_MODE=enforce:
 *
 *   1. THE PAT LANE IS NO LONGER ZERO-ENTITLEMENT. A PAT carries no live token
 *      claim; the auth chokepoint stamps the mint-time SKU snapshot onto
 *      `__entitlements`, so a PAT for a PAYING user is entitled at a gated action
 *      instead of being 403'd like an empty claim (the reported bug).
 *
 *   2. ENTITLEMENTS ARE BOUND TO THE ACTING WORKSPACE. The claim is intersected
 *      with the workspace's server-side entitlements (Workspace.entitlementCache),
 *      so a caller whose token carries `customer-ops` from ANOTHER org is denied
 *      it in a workspace whose cache lacks it — even though the raw claim has it.
 *
 * The gate itself (AgentInferenceClient.checkEntitlement) is exercised REAL — the
 * same gate every gated MCP tool (triage_customer, next_best_action, the AR /
 * email / outreach writes) funnels through — fed by the REAL binding resolver.
 */

const WS_PAID = '0190a000-7e57-7000-8000-0000000000a1'; // workspace the user pays for
const WS_UNSUBBED = '0190a000-7e57-7000-8000-0000000000b2'; // workspace with no customer-ops

const aaron = { id: 'u-aaron', keycloakId: 'kc-aaron', isActive: true } as User;

function userWithClaim(entitlements: string[] | null | undefined): User & Partial<WithWorkspaceClaim> {
  const u = { ...aaron } as User & Partial<WithWorkspaceClaim>;
  u.__entitlements = entitlements as string[] | null | undefined ?? null;
  return u;
}

/** A WorkspaceContextService whose only live dependency is a prisma stub that
 *  returns the given entitlementCache for a workspace id (undefined ⇒ no row). */
function serviceWithCaches(caches: Record<string, unknown | undefined>): WorkspaceContextService {
  const prisma = {
    workspace: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (!(where.id in caches)) return null; // no mirror row
        return { entitlementCache: caches[where.id] ?? null };
      }),
    },
  } as unknown as PrismaService;
  const config = { get: (_k: string, d?: unknown) => d } as unknown as ConfigService;
  const membership = {} as unknown as MembershipService;
  return new WorkspaceContextService(config, prisma, membership);
}

/** The production gate, wired to enforce with a configured gateway. */
function enforceGate(): AgentInferenceClient {
  const config = {
    get: (k: string) =>
      ({ AGENT_INFERENCE_BASE_URL: 'https://gateway.test', UC_ENTITLEMENT_MODE: 'enforce' })[k],
  } as unknown as ConfigService;
  return new AgentInferenceClient(config);
}

describe('entitlementKey — separator/case tolerance', () => {
  it('collapses separator + case spellings of the same SKU', () => {
    expect(entitlementKey('customer-ops')).toBe(entitlementKey('customer_ops'));
    expect(entitlementKey('Customer-Ops')).toBe(entitlementKey('customerops'));
    expect(entitlementKey('  ai-metered  ')).toBe(entitlementKey('ai_metered'));
  });
});

describe('parseWorkspaceEntitlements — the server-side source reader', () => {
  it('null / undefined ⇒ null (NO server-side source → trust the claim)', () => {
    expect(parseWorkspaceEntitlements(null)).toBeNull();
    expect(parseWorkspaceEntitlements(undefined)).toBeNull();
  });

  it('a present-but-empty cache ⇒ [] (entitled to NOTHING, not "no source")', () => {
    expect(parseWorkspaceEntitlements([])).toEqual([]);
    expect(parseWorkspaceEntitlements({ entitlements: [] })).toEqual([]);
  });

  it('reads a bare string[] cache', () => {
    expect(parseWorkspaceEntitlements(['customer-ops', 'ai-metered'])).toEqual([
      'customer-ops',
      'ai-metered',
    ]);
  });

  it('reads the object shapes {entitlements|skus|products} and drops inactive', () => {
    expect(parseWorkspaceEntitlements({ skus: ['customer-ops'] })).toEqual(['customer-ops']);
    expect(parseWorkspaceEntitlements({ products: 'customer-ops email-ops' })).toEqual([
      'customer-ops',
      'email-ops',
    ]);
    expect(
      parseWorkspaceEntitlements({
        entitlements: [
          { code: 'customer-ops', active: true },
          { code: 'ai-metered', active: false },
        ],
      }),
    ).toEqual(['customer-ops']);
  });
});

describe('intersectEntitlements — the (user, workspace) bind', () => {
  it('workspace null ⇒ trusts the claim unchanged (shared-SaaS fallback)', () => {
    expect(intersectEntitlements(['customer-ops', 'ai-metered'], null)).toEqual([
      'customer-ops',
      'ai-metered',
    ]);
  });

  it('intersects by key, keeping the claimed spelling', () => {
    expect(intersectEntitlements(['customer_ops', 'ai-metered'], ['customer-ops'])).toEqual([
      'customer_ops',
    ]);
  });

  it('NEVER grants a SKU the claim did not carry', () => {
    expect(intersectEntitlements([], ['customer-ops'])).toEqual([]);
    expect(intersectEntitlements(['email-ops'], ['customer-ops', 'email-ops'])).toEqual([
      'email-ops',
    ]);
  });

  it('a present-but-empty workspace cache denies everything', () => {
    expect(intersectEntitlements(['customer-ops'], [])).toEqual([]);
  });
});

describe('WorkspaceContextService.effectiveEntitlements', () => {
  it('binds the claim to the workspace cache (intersection)', async () => {
    const svc = serviceWithCaches({
      [WS_PAID]: ['customer-ops', 'ai-metered'],
      [WS_UNSUBBED]: ['email-ops'],
    });
    const user = userWithClaim(['customer-ops']);
    await expect(svc.effectiveEntitlements(user, WS_PAID)).resolves.toEqual(['customer-ops']);
    // Same user + same token claim, different workspace → the SKU is stripped.
    await expect(svc.effectiveEntitlements(user, WS_UNSUBBED)).resolves.toEqual([]);
  });

  it('falls back to the raw claim when the workspace has no cache / no row', async () => {
    const svc = serviceWithCaches({ [WS_PAID]: null }); // row exists, cache null
    await expect(
      svc.effectiveEntitlements(userWithClaim(['customer-ops']), WS_PAID),
    ).resolves.toEqual(['customer-ops']);
    // No mirror row at all → also "no source" → trust the claim.
    await expect(
      svc.effectiveEntitlements(userWithClaim(['customer-ops']), 'ws-unknown'),
    ).resolves.toEqual(['customer-ops']);
  });
});

describe('MONEY: a PAT for a paying user succeeds on a gated action', () => {
  it('PAT snapshot → __entitlements → effective → gate ALLOWED (enforce)', async () => {
    // The guard stamps the mint-time snapshot onto __entitlements for a PAT.
    const patUser = userWithClaim(['customer-ops']);
    expect(entitlementsOf(patUser)).toEqual(['customer-ops']); // NOT the empty-set bug

    const svc = serviceWithCaches({ [WS_PAID]: ['customer-ops'] });
    const effective = await svc.effectiveEntitlements(patUser, WS_PAID);

    const ctx: InferenceContext = { workspaceId: WS_PAID, ucUid: 'kc-aaron', entitlements: effective };
    const decision = enforceGate().checkEntitlement(ctx, 'bundled');
    expect(decision).toMatchObject({ allowed: true, mode: 'enforce', tierAllowed: 'bundled' });
  });

  it('the pre-fix behavior (no snapshot ⇒ empty claim) would have been DENIED', async () => {
    // Regression guard: an unstamped PAT (the bug) resolves to [] → denied.
    const bug = userWithClaim(null);
    const svc = serviceWithCaches({ [WS_PAID]: null });
    const effective = await svc.effectiveEntitlements(bug, WS_PAID);
    const ctx: InferenceContext = { workspaceId: WS_PAID, ucUid: 'kc-aaron', entitlements: effective };
    expect(enforceGate().checkEntitlement(ctx, 'bundled').allowed).toBe(false);
  });
});

describe('MONEY: cross-org SKU does NOT unlock a workspace it was not bought for', () => {
  it('a token carrying customer-ops from org A is DENIED in workspace B (enforce)', async () => {
    // Token/PAT carries customer-ops (bought in org A), acting in workspace B
    // whose server-side cache holds only email-ops.
    const user = userWithClaim(['customer-ops', 'ai-metered']);
    const svc = serviceWithCaches({ [WS_UNSUBBED]: ['email-ops'] });

    const effective = await svc.effectiveEntitlements(user, WS_UNSUBBED);
    expect(effective).toEqual([]); // customer-ops stripped by the bind

    const ctx: InferenceContext = {
      workspaceId: WS_UNSUBBED,
      ucUid: 'kc-aaron',
      entitlements: effective,
    };
    const decision = enforceGate().checkEntitlement(ctx, 'bundled');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/customer-ops/i);
  });

  it('the SAME token IS allowed in the workspace that actually bought the SKU', async () => {
    const user = userWithClaim(['customer-ops']);
    const svc = serviceWithCaches({ [WS_PAID]: ['customer-ops'], [WS_UNSUBBED]: ['email-ops'] });
    const effective = await svc.effectiveEntitlements(user, WS_PAID);
    const ctx: InferenceContext = { workspaceId: WS_PAID, ucUid: 'kc-aaron', entitlements: effective };
    expect(enforceGate().checkEntitlement(ctx, 'bundled').allowed).toBe(true);
  });
});

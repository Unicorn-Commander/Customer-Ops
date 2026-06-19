import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { JwtStrategy } from '../../auth/strategies/jwt.strategy';
import { entitlementsOf, WithWorkspaceClaim } from '../../common/workspace/workspace.util';
import { AgentInferenceClient } from './agent-inference.client';
import { InferenceContext } from './agent-inference.port';
import { InferenceTier } from './agent-inference.types';

/**
 * Enforce-readiness end-to-end (workstream w4): prove the entitlement SKUs travel
 * the WHOLE thread, from a verified bearer-token CLAIM all the way to the agent's
 * inference gate — the seam that makes UC_ENTITLEMENT_MODE=enforce safe to flip.
 *
 * The individual links are pinned elsewhere (jwt.strategy.spec → the tolerant
 * `readEntitlements` extractor; agent-inference.client.spec → the pure gate on a
 * hand-built ctx). What was NOT pinned is that they are CONNECTED — that
 * `ctx.entitlements` is actually fed from the token claim and is not empty/stubbed.
 * A refactor that severed `__entitlements` (e.g. an agent stopping calling
 * `entitlementsOf`, or `validate()` no longer stamping it) would silently make
 * enforce deny EVERY agent (claim present) or allow nothing — and every other
 * client spec would still pass. This test fails loudly in that case.
 *
 * It exercises the REAL pieces with NO mocks of the gate or the extractor:
 *   1. JwtStrategy.readEntitlements(payload)  — the claim → string[] extractor,
 *   2. the same stamp JwtStrategy.validate() writes onto the resolved user,
 *   3. entitlementsOf(user)                   — the request.user → list reader,
 *   4. AgentInferenceClient.checkEntitlement  — the agent's gate.
 * and asserts the four enforce-readiness outcomes the brief requires.
 */

/** Replays exactly what JwtStrategy.validate() does after the token verifies:
 *  run the tolerant extractor over the payload and stamp it onto request.user.
 *  (validate() itself also resolves the DB user + audience-binds; that is covered
 *  by the auth specs. Here we isolate the claim → user.__entitlements stamp so the
 *  thread under test is the verified-claim → gate path, not Prisma.) */
function userFromVerifiedClaim(payload: any): User & Partial<WithWorkspaceClaim> {
  const user = { id: 'local-user-1', keycloakId: 'kc-sub-1' } as unknown as User;
  const augmented = user as User & Partial<WithWorkspaceClaim>;
  augmented.__entitlements = JwtStrategy.readEntitlements(payload);
  return augmented;
}

/** Build the agent's InferenceContext the way every agent does (lead-triage /
 *  follow-up-drafter / collections-nudge all use `entitlements: entitlementsOf(user)`). */
function infCtxFor(user: User & Partial<WithWorkspaceClaim>): InferenceContext {
  return { workspaceId: 'ws-aaaa', ucUid: 'kc-sub-1', entitlements: entitlementsOf(user) };
}

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

/** Decide as the agents do: claim → user → ctx → gate, at the agents' default tier. */
function decideFromToken(
  payload: any,
  env: Record<string, string | undefined>,
  requested: InferenceTier = 'bundled',
) {
  const client = new AgentInferenceClient(
    makeConfig({ AGENT_INFERENCE_BASE_URL: 'https://g.test', ...env }),
  );
  const user = userFromVerifiedClaim(payload);
  return client.checkEntitlement(infCtxFor(user), requested);
}

describe('entitlement claim → agent gate (enforce-readiness E2E)', () => {
  describe('UC_ENTITLEMENT_MODE=enforce (the production posture)', () => {
    const ENFORCE = { UC_ENTITLEMENT_MODE: 'enforce' };

    it('a token with NO customer-ops SKU is DENIED at the agent gate (clean, no model call)', () => {
      // The agents pre-check this decision and, when not allowed, return a
      // not-entitled result WITHOUT calling complete() — so no model runs.
      const decision = decideFromToken({ entitlements: ['accounting-ops', 'email-ops'] }, ENFORCE);
      expect(decision.allowed).toBe(false);
      expect(decision.mode).toBe('enforce');
      expect(decision.reason).toMatch(/customer-ops/i);
    });

    it('an EMPTY / absent claim is DENIED (the degrade-clean default under enforce)', () => {
      expect(decideFromToken({}, ENFORCE).allowed).toBe(false);
      expect(decideFromToken({ entitlements: [] }, ENFORCE).allowed).toBe(false);
      expect(decideFromToken({ entitlements: null }, ENFORCE).allowed).toBe(false);
    });

    it('a token carrying customer-ops is ALLOWED at the BUNDLED tier (lanes 1-2)', () => {
      const decision = decideFromToken({ entitlements: ['customer-ops'] }, ENFORCE, 'bundled');
      expect(decision).toMatchObject({ allowed: true, tierAllowed: 'bundled', mode: 'enforce' });
    });

    it('a token carrying customer-ops + ai-metered is ALLOWED at the METERED tier (lanes 3-4)', () => {
      const decision = decideFromToken(
        { entitlements: ['customer-ops', 'ai-metered'] },
        ENFORCE,
        'metered',
      );
      expect(decision).toMatchObject({ allowed: true, tierAllowed: 'metered', mode: 'enforce' });
    });

    it('customer-ops WITHOUT ai-metered asking for metered is allowed but DOWNGRADED to bundled (not denied)', () => {
      const decision = decideFromToken({ entitlements: ['customer-ops'] }, ENFORCE, 'metered');
      expect(decision).toMatchObject({ allowed: true, tierAllowed: 'bundled' });
      expect(decision.reason).toMatch(/bundled/i);
    });

    it('honors the SKU claim under uc_skus / nested subscription, not only `entitlements`', () => {
      // The claim-name tolerance is real end-to-end: a Keycloak mapper that emits
      // `uc_skus` (or nests under subscription.products) still entitles the agent.
      expect(decideFromToken({ uc_skus: ['customer-ops'] }, ENFORCE).allowed).toBe(true);
      expect(
        decideFromToken({ subscription: { products: ['customer-ops'] } }, ENFORCE).allowed,
      ).toBe(true);
      // ...and SKU spelling/alias tolerance survives the trip (client normalizes).
      expect(decideFromToken({ entitlements: ['customer_ops'] }, ENFORCE).allowed).toBe(true);
    });
  });

  describe('UC_ENTITLEMENT_MODE=open (the pre-Lago bootstrap)', () => {
    const OPEN = { UC_ENTITLEMENT_MODE: 'open' };

    it('ALLOWS even with no SKU on the token (the bootstrap escape hatch), reporting mode=open', () => {
      // Open mode must allow regardless so the bootstrap deploy keeps working
      // before Lago emits entitlements; the client logs a loud WARN on this path
      // (the WARN itself is pinned in agent-inference.client.spec).
      const decision = decideFromToken({}, OPEN, 'metered');
      expect(decision).toMatchObject({ allowed: true, mode: 'open', tierAllowed: 'metered' });
    });

    it('still ALLOWS when the SKU is present (open never tightens)', () => {
      expect(decideFromToken({ entitlements: ['customer-ops'] }, OPEN, 'bundled')).toMatchObject({
        allowed: true,
        mode: 'open',
      });
    });
  });
});

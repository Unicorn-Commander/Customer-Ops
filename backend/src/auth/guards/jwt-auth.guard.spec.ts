import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JWT_ONLY_KEY } from '../decorators/jwt-only.decorator';
import { REQUIRE_SCOPES_KEY } from '../decorators/require-scopes.decorator';

const WS = '0190a000-7e57-7000-8000-00000000c007';
const OTHER_WS = '0190a000-7e57-7000-8000-0000000000ff';

const aaron = { id: 'u1', email: 'aaron@magicunicorn.tech', keycloakId: 'kc-1', isActive: true } as any;

/**
 * Build a fake ExecutionContext. `meta` configures what the Reflector returns
 * per metadata key (isPublic / jwtOnly / requiredScopes).
 */
function makeCtx(opts: {
  type?: string;
  request?: any;
  meta?: { isPublic?: boolean; jwtOnly?: boolean; requiredScopes?: string[] | undefined };
}): { ctx: ExecutionContext; reflector: any } {
  const meta = opts.meta ?? {};
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === 'isPublic') return meta.isPublic;
      if (key === JWT_ONLY_KEY) return meta.jwtOnly;
      if (key === REQUIRE_SCOPES_KEY) return meta.requiredScopes;
      return undefined;
    }),
  };
  const ctx = {
    getType: () => opts.type ?? 'http',
    switchToHttp: () => ({ getRequest: () => opts.request ?? {} }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  return { ctx, reflector };
}

function patReq(token: string, params: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return { headers: { authorization: `Bearer ${token}`, ...headers }, params };
}

function makeGuard(reflector: any, findByPlaintext: jest.Mock) {
  const pats = { findByPlaintext };
  const moduleRef = { get: jest.fn().mockReturnValue(pats) };
  return new JwtAuthGuard(reflector as any, moduleRef as any);
}

const resolution = (scopes: string[], workspaceId: string | null = WS) => ({
  user: { ...aaron },
  token: { id: 'pat-1', scopes, workspaceId },
  workspaceId,
});

describe('JwtAuthGuard', () => {
  it('non-http execution contexts pass through', async () => {
    const { ctx, reflector } = makeCtx({ type: 'rpc' });
    const guard = makeGuard(reflector, jest.fn());
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('a @Public() route skips auth entirely (no token read)', async () => {
    const { ctx, reflector } = makeCtx({ meta: { isPublic: true }, request: {} });
    const find = jest.fn();
    const guard = makeGuard(reflector, find);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(find).not.toHaveBeenCalled();
  });

  it('is idempotent — a request whose user is already resolved passes without re-bcrypting', async () => {
    const { ctx, reflector } = makeCtx({ request: { user: aaron, headers: {} } });
    const find = jest.fn();
    const guard = makeGuard(reflector, find);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(find).not.toHaveBeenCalled();
  });

  describe('PAT bearer', () => {
    it('rejects a PAT on a @JwtOnly() route with 403 (a leaked PAT cannot mint/revoke PATs)', async () => {
      const request = patReq('co_pat_abc');
      const { ctx, reflector } = makeCtx({ request, meta: { jwtOnly: true } });
      const find = jest.fn();
      const guard = makeGuard(reflector, find);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
      expect(find).not.toHaveBeenCalled(); // rejected before resolving the token
    });

    it('rejects an unresolvable PAT with 401 (never falls through to JWT parsing)', async () => {
      const { ctx, reflector } = makeCtx({
        request: patReq('co_pat_bogus'),
        meta: { requiredScopes: ['read:customers'] },
      });
      const guard = makeGuard(reflector, jest.fn().mockResolvedValue(null));
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('allows a PAT that holds the required scope, attaching user + pat + workspace', async () => {
      const request = patReq('co_pat_ok', { workspaceId: WS });
      const { ctx, reflector } = makeCtx({ request, meta: { requiredScopes: ['read:customers'] } });
      const guard = makeGuard(reflector, jest.fn().mockResolvedValue(resolution(['read:customers'])));
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(request).toMatchObject({ workspaceId: WS });
      expect((request as any).user.email).toBe(aaron.email);
      expect((request as any).pat.id).toBe('pat-1');
      expect((request as any).user.__ucUid).toBe('kc-1');
    });

    it('stamps __entitlements from the PAT mint-time snapshot (the zero-entitlement fix)', async () => {
      const request = patReq('co_pat_ok', { workspaceId: WS });
      const { ctx, reflector } = makeCtx({ request, meta: { requiredScopes: ['read:customers'] } });
      const resolved = {
        user: { ...aaron },
        token: { id: 'pat-1', scopes: ['read:customers'], workspaceId: WS, entitlements: ['customer-ops', 'ai-metered'] },
        workspaceId: WS,
        entitlements: ['customer-ops', 'ai-metered'],
      };
      const guard = makeGuard(reflector, jest.fn().mockResolvedValue(resolved));
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      // A PAT has no live token claim — without this stamp entitlementsOf(user) is
      // [] and every gated action 403s under enforce even for a paying user.
      expect((request as any).user.__entitlements).toEqual(['customer-ops', 'ai-metered']);
    });

    it('stamps [] when the PAT carries no snapshot (secure default, never over-grants)', async () => {
      const request = patReq('co_pat_ok', { workspaceId: WS });
      const { ctx, reflector } = makeCtx({ request, meta: { requiredScopes: ['read:customers'] } });
      // resolution() builds a token WITHOUT an entitlements field (pre-snapshot token).
      const guard = makeGuard(reflector, jest.fn().mockResolvedValue(resolution(['read:customers'])));
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect((request as any).user.__entitlements).toEqual([]);
    });

    it('honors write ⊇ read (write:customers token reaches a read:customers route)', async () => {
      const { ctx, reflector } = makeCtx({
        request: patReq('co_pat_ok', { workspaceId: WS }),
        meta: { requiredScopes: ['read:customers'] },
      });
      const guard = makeGuard(reflector, jest.fn().mockResolvedValue(resolution(['write:customers'])));
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('denies a PAT missing the required scope with 403', async () => {
      const { ctx, reflector } = makeCtx({
        request: patReq('co_pat_ok', { workspaceId: WS }),
        meta: { requiredScopes: ['write:customers'] },
      });
      const guard = makeGuard(reflector, jest.fn().mockResolvedValue(resolution(['read:customers'])));
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('DENY-BY-DEFAULT: a route with no @RequireScopes is unreachable with a PAT', async () => {
      const { ctx, reflector } = makeCtx({
        request: patReq('co_pat_ok', { workspaceId: WS }),
        meta: { requiredScopes: undefined },
      });
      const guard = makeGuard(reflector, jest.fn().mockResolvedValue(resolution(['read:customers'])));
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('@RequireScopes() with no scopes admits any PAT (identity/whoami)', async () => {
      const { ctx, reflector } = makeCtx({
        request: patReq('co_pat_ok'),
        meta: { requiredScopes: [] },
      });
      const guard = makeGuard(reflector, jest.fn().mockResolvedValue(resolution(['read:customers'])));
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('fences the PAT to its bound workspace — an explicit other workspace is 403', async () => {
      const { ctx, reflector } = makeCtx({
        request: patReq('co_pat_ok', { workspaceId: OTHER_WS }),
        meta: { requiredScopes: ['read:customers'] },
      });
      const guard = makeGuard(reflector, jest.fn().mockResolvedValue(resolution(['read:customers'], WS)));
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('honors X-Workspace-Id header in the fence', async () => {
      const { ctx, reflector } = makeCtx({
        request: patReq('co_pat_ok', {}, { 'x-workspace-id': OTHER_WS }),
        meta: { requiredScopes: ['read:customers'] },
      });
      const guard = makeGuard(reflector, jest.fn().mockResolvedValue(resolution(['read:customers'], WS)));
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('JWT bearer (non-PAT)', () => {
    it('delegates to the passport JWT strategy and ignores PAT scope metadata', async () => {
      const superProto = Object.getPrototypeOf(JwtAuthGuard.prototype);
      const superSpy = jest.spyOn(superProto, 'canActivate').mockResolvedValue(true as any);
      try {
        const { ctx, reflector } = makeCtx({
          request: patReq('eyJhbGciOiJI.notapat.sig'),
          meta: { requiredScopes: ['write:customers'] }, // a JWT session is unaffected by scopes
        });
        const find = jest.fn();
        const guard = makeGuard(reflector, find);
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(superSpy).toHaveBeenCalled();
        expect(find).not.toHaveBeenCalled(); // not PAT-shaped → never hits PatService
      } finally {
        superSpy.mockRestore();
      }
    });
  });
});

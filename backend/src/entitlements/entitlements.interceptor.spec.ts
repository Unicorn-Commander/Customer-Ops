import { ExecutionContext, CallHandler, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { EntitlementsInterceptor } from './entitlements.interceptor';
import { EntitlementsService } from './entitlements.service';

function ctxWith(req: any): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}
const NEXT = { handle: () => of('OK') } as unknown as CallHandler;
const cfg = (env: Record<string, string> = {}) =>
  ({ get: (k: string) => env[k] }) as unknown as ConfigService;

// A real service instance only for the faithful toSkuList mapping; resolve +
// isConfigured are stubbed per test.
const mapper = new EntitlementsService(cfg());

function fakeSvc(resolve: jest.Mock, configured = true): EntitlementsService {
  return {
    isConfigured: () => configured,
    resolve,
    toSkuList: (k: string[]) => mapper.toSkuList(k),
  } as unknown as EntitlementsService;
}

describe('EntitlementsInterceptor', () => {
  it('no-ops when the service is unconfigured (claim stays the source)', async () => {
    const resolve = jest.fn();
    const interceptor = new EntitlementsInterceptor(fakeSvc(resolve, false), cfg());
    const req = { user: { __entitlements: ['claim-sku'] }, headers: { authorization: 'Bearer x' } };
    await interceptor.intercept(ctxWith(req), NEXT);
    expect(req.user.__entitlements).toEqual(['claim-sku']);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('no-ops on an unauthenticated request (no req.user)', async () => {
    const resolve = jest.fn();
    const interceptor = new EntitlementsInterceptor(fakeSvc(resolve), cfg());
    const req = { headers: {} };
    await interceptor.intercept(ctxWith(req), NEXT);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('overwrites __entitlements with the endpoint set (raw + suite SKU forms)', async () => {
    const resolve = jest
      .fn()
      .mockResolvedValue({ orgId: 'o', tier: 'managed', featureKeys: ['customer_ops_access', 'email_ops_access'] });
    const interceptor = new EntitlementsInterceptor(fakeSvc(resolve), cfg({ ENTITLEMENTS_ENDPOINT_URL: 'x' }));
    const req = { user: { __entitlements: ['claim-sku'] }, headers: { authorization: 'Bearer abc' } };
    await interceptor.intercept(ctxWith(req), NEXT);
    expect(resolve).toHaveBeenCalledWith('abc', undefined);
    expect(req.user.__entitlements).toEqual(
      expect.arrayContaining(['customer_ops_access', 'customer-ops', 'email_ops_access', 'email-ops']),
    );
    expect(req.user.__entitlements).not.toContain('claim-sku'); // replaced, not merged
  });

  it('leaves the claim value untouched when the endpoint is indeterminate (null)', async () => {
    const resolve = jest.fn().mockResolvedValue(null);
    const interceptor = new EntitlementsInterceptor(fakeSvc(resolve), cfg({ ENTITLEMENTS_ENDPOINT_URL: 'x' }));
    const req = { user: { __entitlements: ['claim-sku'] }, headers: { authorization: 'Bearer abc' } };
    await interceptor.intercept(ctxWith(req), NEXT);
    expect(req.user.__entitlements).toEqual(['claim-sku']);
  });

  it('launch gate (enforce): denies a definitive answer lacking customer_ops_access', async () => {
    const resolve = jest.fn().mockResolvedValue({ orgId: 'o', tier: 'free', featureKeys: ['email_ops_access'] });
    const interceptor = new EntitlementsInterceptor(
      fakeSvc(resolve),
      cfg({ ENTITLEMENTS_ENDPOINT_URL: 'x', ENTITLEMENTS_LAUNCH_GATE: 'enforce' }),
    );
    const req = { user: { __entitlements: [] }, headers: { authorization: 'Bearer abc' } };
    await expect(interceptor.intercept(ctxWith(req), NEXT)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('launch gate (enforce): allows when customer_ops_access is present', async () => {
    const resolve = jest
      .fn()
      .mockResolvedValue({ orgId: 'o', tier: 'managed', featureKeys: ['customer_ops_access'] });
    const interceptor = new EntitlementsInterceptor(
      fakeSvc(resolve),
      cfg({ ENTITLEMENTS_ENDPOINT_URL: 'x', ENTITLEMENTS_LAUNCH_GATE: 'enforce' }),
    );
    const req = { user: { __entitlements: [] }, headers: { authorization: 'Bearer abc' } };
    await expect(interceptor.intercept(ctxWith(req), NEXT)).resolves.toBeDefined();
    expect(req.user.__entitlements).toContain('customer_ops_access');
  });

  it('launch gate OFF by default: an indeterminate answer never denies', async () => {
    const resolve = jest.fn().mockResolvedValue(null);
    const interceptor = new EntitlementsInterceptor(fakeSvc(resolve), cfg({ ENTITLEMENTS_ENDPOINT_URL: 'x' }));
    const req = { user: { __entitlements: ['claim-sku'] }, headers: { authorization: 'Bearer abc' } };
    await expect(interceptor.intercept(ctxWith(req), NEXT)).resolves.toBeDefined();
  });

  // --- the PAT lane (previously ZERO coverage here) --------------------------

  describe('the co_pat_ lane is short-circuited DELIBERATELY, not by accident', () => {
    it('never forwards a co_pat_ bearer to the user-scoped endpoint', async () => {
      const resolve = jest.fn();
      const interceptor = new EntitlementsInterceptor(fakeSvc(resolve), cfg({ ENTITLEMENTS_ENDPOINT_URL: 'x' }));
      const req = {
        user: { __entitlements: ['customer-ops'] },
        pat: { id: 'pat-1', workspaceId: 'ws-a' },
        headers: { authorization: 'Bearer co_pat_deadbeef' },
      };
      await interceptor.intercept(ctxWith(req), NEXT);
      // A PAT is not a JWT; asking the user-scoped endpoint with it is meaningless
      // (it would 401 / bail on isRs256). It must not even be attempted.
      expect(resolve).not.toHaveBeenCalled();
    });

    it('leaves the guard-stamped, WORKSPACE-BOUND set intact (does not overwrite it)', async () => {
      // Simulate an endpoint that WOULD answer with a wider, user-scoped set. If
      // the interceptor applied it to a PAT, it would discard the (token,
      // workspace) bind that JwtAuthGuard/PatService just computed.
      const resolve = jest
        .fn()
        .mockResolvedValue({ orgId: 'o', tier: 'managed', featureKeys: ['customer_ops_access'] });
      const interceptor = new EntitlementsInterceptor(fakeSvc(resolve), cfg({ ENTITLEMENTS_ENDPOINT_URL: 'x' }));
      const req = {
        // the workspace-bound answer: this PAT's workspace holds nothing
        user: { __entitlements: [] as string[] },
        pat: { id: 'pat-1', workspaceId: 'ws-b' },
        headers: { authorization: 'Bearer co_pat_deadbeef' },
      };
      await interceptor.intercept(ctxWith(req), NEXT);
      expect(req.user.__entitlements).toEqual([]); // NOT widened to customer-ops
      expect(resolve).not.toHaveBeenCalled();
    });

    it('the launch gate cannot 403 a PAT (its authority is the workspace resolver)', async () => {
      const resolve = jest
        .fn()
        .mockResolvedValue({ orgId: 'o', tier: 'free', featureKeys: [] });
      const interceptor = new EntitlementsInterceptor(
        fakeSvc(resolve),
        cfg({ ENTITLEMENTS_ENDPOINT_URL: 'x', ENTITLEMENTS_LAUNCH_GATE: 'enforce' }),
      );
      const req = {
        user: { __entitlements: ['customer-ops'] },
        pat: { id: 'pat-1', workspaceId: 'ws-a' },
        headers: { authorization: 'Bearer co_pat_deadbeef' },
      };
      // Documented decision: the per-USER launch gate does not run on a lane
      // whose entitlements are resolved per-WORKSPACE. Gated actions on this lane
      // are still denied by the SKU gates when the workspace lacks the SKU.
      await expect(interceptor.intercept(ctxWith(req), NEXT)).resolves.toBeDefined();
    });

    it('a JWT request (no req.pat) is unaffected — regression', async () => {
      const resolve = jest
        .fn()
        .mockResolvedValue({ orgId: 'o', tier: 'managed', featureKeys: ['customer_ops_access'] });
      const interceptor = new EntitlementsInterceptor(fakeSvc(resolve), cfg({ ENTITLEMENTS_ENDPOINT_URL: 'x' }));
      const req = { user: { __entitlements: ['claim-sku'] }, headers: { authorization: 'Bearer abc' } };
      await interceptor.intercept(ctxWith(req), NEXT);
      expect(resolve).toHaveBeenCalledWith('abc', undefined);
      expect(req.user.__entitlements).toContain('customer-ops');
    });
  });
});

import { ConfigService } from '@nestjs/config';
import { EntitlementsService } from './entitlements.service';

// Minimal JWT shaping — the service only base64url-decodes the header (alg) and
// payload (sub); the signature is never checked here (JwtAuthGuard already did).
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (header: object, payload: object) => `${b64(header)}.${b64(payload)}.sig`;
const RS = jwt({ alg: 'RS256', kid: 'k' }, { sub: 'user-1' });
const RS2 = jwt({ alg: 'RS256', kid: 'k' }, { sub: 'user-2' });
const HS = jwt({ alg: 'HS256' }, { sub: 'user-1' });

function svc(env: Record<string, string> = {}): EntitlementsService {
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  return new EntitlementsService(config);
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function status(code: number) {
  return { ok: code < 400, status: code, json: async () => ({}) } as unknown as Response;
}

const URL = 'https://magicunicorn.dev/api/v1/entitlements';
const GRANTS = { org_id: 'org-1', tier: 'managed', entitlements: ['customer_ops_access', 'email_ops_access'] };

describe('EntitlementsService', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  it('is dormant when ENTITLEMENTS_ENDPOINT_URL is unset', async () => {
    const s = svc();
    expect(s.isConfigured()).toBe(false);
    expect(await s.resolve(RS)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips a non-RS256 (local HS256 session) token without a round-trip', async () => {
    const s = svc({ ENTITLEMENTS_ENDPOINT_URL: URL });
    expect(await s.resolve(HS)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches with the bearer and returns the org feature_keys on 200', async () => {
    fetchMock.mockResolvedValue(ok(GRANTS));
    const s = svc({ ENTITLEMENTS_ENDPOINT_URL: URL });
    const res = await s.resolve(RS);
    expect(res?.featureKeys).toEqual(['customer_ops_access', 'email_ops_access']);
    expect(res?.tier).toBe('managed');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL);
    expect((init.headers as any).Authorization).toBe(`Bearer ${RS}`);
  });

  it('passes ?org_id when an org is supplied', async () => {
    fetchMock.mockResolvedValue(ok(GRANTS));
    const s = svc({ ENTITLEMENTS_ENDPOINT_URL: URL });
    await s.resolve(RS, 'ws-7');
    expect(fetchMock.mock.calls[0][0]).toBe(`${URL}?org_id=ws-7`);
  });

  it('caches within the TTL (one fetch per user/org window)', async () => {
    fetchMock.mockResolvedValue(ok(GRANTS));
    const s = svc({ ENTITLEMENTS_ENDPOINT_URL: URL }); // default 60s TTL
    await s.resolve(RS);
    await s.resolve(RS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fail-soft: serves last-good for a known org on a 5xx blip', async () => {
    const s = svc({ ENTITLEMENTS_ENDPOINT_URL: URL, ENTITLEMENTS_CACHE_TTL_MS: '0' });
    fetchMock.mockResolvedValueOnce(ok(GRANTS)); // primes last-good
    expect((await s.resolve(RS))?.featureKeys).toContain('customer_ops_access');
    fetchMock.mockResolvedValueOnce(status(503)); // blip
    expect((await s.resolve(RS))?.featureKeys).toContain('customer_ops_access');
  });

  it('fail-closed: a never-seen org gets null on a 5xx (claim fallback)', async () => {
    const s = svc({ ENTITLEMENTS_ENDPOINT_URL: URL });
    fetchMock.mockResolvedValue(status(500));
    expect(await s.resolve(RS2)).toBeNull();
  });

  it('falls back (null) on a 401/403 without caching', async () => {
    const s = svc({ ENTITLEMENTS_ENDPOINT_URL: URL });
    fetchMock.mockResolvedValue(status(403));
    expect(await s.resolve(RS)).toBeNull();
  });

  it('fail-soft on a network/timeout error', async () => {
    const s = svc({ ENTITLEMENTS_ENDPOINT_URL: URL, ENTITLEMENTS_CACHE_TTL_MS: '0' });
    fetchMock.mockResolvedValueOnce(ok(GRANTS));
    await s.resolve(RS);
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect((await s.resolve(RS))?.tier).toBe('managed');
  });

  describe('toSkuList — maps *_access keys onto the suite SKU vocabulary', () => {
    const s = svc();
    it('keeps the raw key AND adds the hyphenated suite SKU', () => {
      expect(s.toSkuList(['customer_ops_access', 'email_ops_access']).sort()).toEqual(
        ['customer-ops', 'customer_ops_access', 'email-ops', 'email_ops_access'].sort(),
      );
    });
    it('is idempotent on an already-suite SKU', () => {
      expect(s.toSkuList(['customer-ops'])).toEqual(['customer-ops']);
    });
  });
});

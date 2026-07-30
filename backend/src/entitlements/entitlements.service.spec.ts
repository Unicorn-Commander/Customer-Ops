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

  /**
   * lookupWorkspace — the SERVER-SIDE, per-workspace lane (the one the `co_pat_`
   * lane depends on). It returns a THREE-state result rather than
   * `EntitlementsResult | null` for one reason: its caller
   * (WorkspaceEntitlementsResolver) treats "no source" as TRUST THE CALLER'S
   * CLAIM. Collapsing "configured but broken" into that value is a silent
   * fail-OPEN — a 500, an expired service credential, or a timeout would widen
   * every caller back to full trust. Every non-200 below must therefore be
   * `unavailable`, never `unconfigured`.
   */
  describe('lookupWorkspace — the server-side per-workspace lane', () => {
    const WS = '0190a000-7e57-7000-8000-0000000000a1';
    const CRED = 'not-a-real-service-credential';

    function wsSvc(extra: Record<string, string> = {}) {
      return svc({ ENTITLEMENTS_ENDPOINT_URL: URL, ENTITLEMENTS_SERVICE_TOKEN: CRED, ...extra });
    }

    it('is UNCONFIGURED (no round-trip) when the URL is unset', async () => {
      const s = svc({ ENTITLEMENTS_SERVICE_TOKEN: CRED });
      expect(await s.lookupWorkspace(WS)).toEqual({ status: 'unconfigured' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is UNCONFIGURED (no round-trip) when the SERVICE TOKEN is unset — URL alone enforces nothing', async () => {
      const s = svc({ ENTITLEMENTS_ENDPOINT_URL: URL });
      expect(s.isConfigured()).toBe(true); // the user lane IS configured…
      expect(s.isWorkspaceLookupConfigured()).toBe(false); // …this one is not.
      expect(await s.lookupWorkspace(WS)).toEqual({ status: 'unconfigured' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a 200 is OK, sends the SERVICE credential (not a user token) and scopes by workspace_id', async () => {
      fetchMock.mockResolvedValue(ok(GRANTS));
      const got = await wsSvc().lookupWorkspace(WS);
      expect(got).toMatchObject({
        status: 'ok',
        data: { featureKeys: ['customer_ops_access', 'email_ops_access'] },
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${URL}?workspace_id=${encodeURIComponent(WS)}`);
      expect((init.headers as any).Authorization).toBe(`Bearer ${CRED}`);
    });

    // THE FAIL-OPEN, at the HTTP boundary. Each of these once produced the same
    // `null` as "unconfigured", which the resolver reads as "trust the claim".
    it.each([401, 403, 404, 429, 500, 502, 503])(
      'HTTP %i is UNAVAILABLE (indeterminate), NEVER unconfigured',
      async (code) => {
        fetchMock.mockResolvedValue(status(code));
        const got = await wsSvc().lookupWorkspace(WS);
        expect(got.status).toBe('unavailable');
        expect(got.status).not.toBe('unconfigured');
      },
    );

    it('a network error is UNAVAILABLE, not unconfigured', async () => {
      fetchMock.mockRejectedValue(Object.assign(new Error('econnrefused'), { name: 'FetchError' }));
      expect(await wsSvc().lookupWorkspace(WS)).toEqual({
        status: 'unavailable',
        reason: 'FetchError',
      });
    });

    it('a timeout/abort is UNAVAILABLE, not unconfigured', async () => {
      fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      expect(await wsSvc().lookupWorkspace(WS)).toEqual({
        status: 'unavailable',
        reason: 'AbortError',
      });
    });

    it('an unparseable body is UNAVAILABLE, not unconfigured', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      } as unknown as Response);
      expect(await wsSvc().lookupWorkspace(WS)).toMatchObject({ status: 'unavailable' });
    });

    it('an empty workspace id is UNAVAILABLE, not unconfigured (a caller bug is still not an answer)', async () => {
      expect(await wsSvc().lookupWorkspace('')).toMatchObject({ status: 'unavailable' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does NOT serve a last-good on failure — the durable mirror owns that, with an expiry', async () => {
      const s = wsSvc();
      fetchMock.mockResolvedValueOnce(ok(GRANTS));
      expect((await s.lookupWorkspace(WS)).status).toBe('ok');
      fetchMock.mockResolvedValueOnce(status(500));
      // A fail-soft last-good here would be an unbounded grant: this lane has no
      // expiry of its own.
      expect((await s.lookupWorkspace(WS)).status).toBe('unavailable');
    });
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
    it('maps magic_outreach -> outreach (keeping the raw key) for the Outreach gate', () => {
      expect(s.toSkuList(['magic_outreach']).sort()).toEqual(['magic_outreach', 'outreach'].sort());
    });
  });
});

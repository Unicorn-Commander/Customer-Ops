import {
  USERINFO_CACHE_MAX_ENTRIES,
  USERINFO_TIMEOUT_MS,
  clearUserinfoCacheForTests,
  fetchRealmUserinfo,
  isUserinfoCandidate,
  userinfoFetchEnabled,
  UserinfoOptions,
} from './userinfo';

const ISSUER = 'https://auth.example.test/realms/uchub';
const SUB = 'kc-noemail-1';
const BEARER = 'realm-bearer-fixture-not-a-real-token';
const NOW = 1_800_000_000_000; // fixed clock for ttl math

/**
 * The PO-CONN userinfo client, pinned in isolation. Every test mocks global
 * fetch; the `guard` below makes a test FAIL if the real fetch is ever
 * reached. No test touches the network.
 */
describe('auth/userinfo (PO-CONN realm userinfo client)', () => {
  const env = (extra: Record<string, string> = {}) => ({
    CUSTOMER_OPS_USERINFO_FETCH: 'true',
    KEYCLOAK_URL: 'https://auth.example.test',
    KEYCLOAK_PUBLIC_URL: 'https://auth.example.test',
    KEYCLOAK_REALM: 'uchub',
    ...extra,
  });
  const quiet = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const guard = () => {
    const real = global.fetch;
    (global as any).fetch = jest.fn(async () => {
      throw new Error('real fetch reached — the test must have mocked it');
    });
    return () => {
      (global as any).fetch = real;
    };
  };

  function options(over: Partial<UserinfoOptions> = {}): UserinfoOptions {
    return {
      trustedIssuers: [ISSUER],
      issuer: ISSUER,
      sub: SUB,
      bearer: BEARER,
      cache: true,
      exp: NOW / 1000 + 3600,
      getEnv: ((key: string) => env()[key]) as any,
      logger: quiet,
      now: () => NOW,
      ...over,
    };
  }

  function okProfile(over: Record<string, unknown> = {}): jest.Mock {
    return jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sub: SUB, email: 'person@example.com', email_verified: true, ...over }),
    }));
  }

  beforeEach(() => {
    clearUserinfoCacheForTests();
    jest.restoreAllMocks();
  });

  describe('userinfoFetchEnabled', () => {
    it('defaults OFF (today behavior: no fetch on the bearer path)', () => {
      const getEnv = (key: string) => process.env[key];
      delete process.env.CUSTOMER_OPS_USERINFO_FETCH;
      expect(userinfoFetchEnabled(getEnv)).toBe(false);
    });

    it('arms only on explicit truthy values', () => {
      for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
        expect(userinfoFetchEnabled(((k: string) => v) as any)).toBe(true);
      }
      for (const v of ['0', 'false', 'no', 'off', '']) {
        expect(userinfoFetchEnabled(((k: string) => v) as any)).toBe(false);
      }
    });
  });

  describe('isUserinfoCandidate', () => {
    const human = { iss: ISSUER, sub: SUB };

    it('accepts a trusted realm human token without an email claim', () => {
      expect(isUserinfoCandidate(human, [ISSUER])).toBe(true);
    });

    it('refuses an untrusted issuer', () => {
      expect(isUserinfoCandidate({ ...human, iss: 'https://evil.example/realms/x' }, [ISSUER])).toBe(
        false,
      );
      expect(isUserinfoCandidate({ ...human, iss: undefined }, [ISSUER])).toBe(false);
    });

    it('refuses machine and delegation shapes', () => {
      expect(isUserinfoCandidate({ ...human, act: { sub: 'x' } }, [ISSUER])).toBe(false);
      expect(isUserinfoCandidate({ ...human, client_id: 'svc' }, [ISSUER])).toBe(false);
      expect(isUserinfoCandidate({ ...human, clientId: 'svc' }, [ISSUER])).toBe(false);
    });

    it('refuses a token that already carries an email claim (email path unchanged)', () => {
      expect(isUserinfoCandidate({ ...human, email: 'has@one.com' }, [ISSUER])).toBe(false);
      expect(isUserinfoCandidate({ ...human, email: '  ' }, [ISSUER])).toBe(true);
    });
  });

  describe('fetchRealmUserinfo', () => {
    it('returns a verified profile for an armed no-email human bearer', async () => {
      const restore = guard();
      const doFetch = okProfile();
      const resolution = await fetchRealmUserinfo(
        options({ fetchImpl: doFetch as any, bearer: BEARER }),
      );
      restore();
      expect(resolution.outcome).toBe('profile');
      expect(resolution.profile).toMatchObject({
        sub: SUB,
        email: 'person@example.com',
        email_verified: true,
      });
      expect(doFetch).toHaveBeenCalledTimes(1);
      const [url, init] = (doFetch as jest.Mock).mock.calls[0];
      expect(url).toBe(`${ISSUER}/protocol/openid-connect/userinfo`);
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('refuses when not armed (no fetch at all)', async () => {
      const restore = guard();
      const doFetch = jest.fn();
      const resolution = await fetchRealmUserinfo(
        options({
          fetchImpl: doFetch as any,
          getEnv: (((key: string) => (key === 'CUSTOMER_OPS_USERINFO_FETCH' ? undefined : 'true')) as any),
        }),
      );
      restore();
      expect(resolution).toMatchObject({ outcome: 'refused' });
      expect(doFetch).not.toHaveBeenCalled();
    });

    it('refuses an untrusted issuer without fetching', async () => {
      const restore = guard();
      const doFetch = jest.fn();
      const resolution = await fetchRealmUserinfo(
        options({
          fetchImpl: doFetch as any,
          issuer: 'https://evil.example/realms/x',
          trustedIssuers: [ISSUER],
        }),
      );
      restore();
      expect(resolution.outcome).toBe('refused');
      expect(doFetch).not.toHaveBeenCalled();
    });

    it('refuses a non-https issuer without fetching', async () => {
      const restore = guard();
      const doFetch = jest.fn();
      const resolution = await fetchRealmUserinfo(
        options({ fetchImpl: doFetch as any, issuer: 'http://auth.example.test/realms/uchub' }),
      );
      restore();
      expect(resolution.outcome).toBe('refused');
      expect(doFetch).not.toHaveBeenCalled();
    });

    it('refuses a userinfo sub mismatch without caching the refusal', async () => {
      const restore = guard();
      const doFetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ sub: 'someone-else', email: 'x@example.com' }),
      }));
      const first = await fetchRealmUserinfo(options({ fetchImpl: doFetch as any }));
      const second = await fetchRealmUserinfo(options({ fetchImpl: doFetch as any }));
      restore();
      expect(first).toMatchObject({ outcome: 'refused' });
      expect(second).toMatchObject({ outcome: 'refused' });
      // Refusals are not cached: the second call re-fetches.
      expect(doFetch).toHaveBeenCalledTimes(2);
    });

    it('caches the profile per bearer digest until exp (one fetch per bearer)', async () => {
      const restore = guard();
      const doFetch = okProfile();
      await fetchRealmUserinfo(options({ fetchImpl: doFetch as any }));
      await fetchRealmUserinfo(options({ fetchImpl: doFetch as any }));
      restore();
      expect(doFetch).toHaveBeenCalledTimes(1);
    });

    it('does not cache across different bearers', async () => {
      const restore = guard();
      const doFetch = okProfile();
      await fetchRealmUserinfo(options({ fetchImpl: doFetch as any }));
      await fetchRealmUserinfo(options({ fetchImpl: doFetch as any, bearer: 'another-bearer' }));
      restore();
      expect(doFetch).toHaveBeenCalledTimes(2);
    });

    it('caches negative (unavailable) results until exp', async () => {
      const restore = guard();
      const doFetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
      const first = await fetchRealmUserinfo(options({ fetchImpl: doFetch as any }));
      const second = await fetchRealmUserinfo(options({ fetchImpl: doFetch as any }));
      restore();
      expect(first).toMatchObject({ outcome: 'unavailable' });
      expect(second).toMatchObject({ outcome: 'unavailable' });
      expect(doFetch).toHaveBeenCalledTimes(1);
    });

    it('does not cache when the ttl is already <= 0 at exp', async () => {
      const restore = guard();
      const doFetch = okProfile();
      // exp 10 s ahead, but the cap math gives ttl <= 0 when now >= exp.
      const at = options({
        fetchImpl: doFetch as any,
        exp: Math.floor(NOW / 1000),
      });
      await fetchRealmUserinfo(at);
      await fetchRealmUserinfo(at);
      restore();
      expect(doFetch).toHaveBeenCalledTimes(2);
    });

    it('caps the ttl at 900 s even for a long-lived token', async () => {
      const restore = guard();
      const doFetch = okProfile();
      const long = options({ fetchImpl: doFetch as any, exp: NOW / 1000 + 100_000 });
      await fetchRealmUserinfo(long);
      // 900 s later the entry must be expired again (a re-fetch is allowed).
      const later = { ...long, now: () => NOW + 901 * 1000 };
      await fetchRealmUserinfo(later);
      restore();
      expect(doFetch).toHaveBeenCalledTimes(2);
    });

    it('honors token exp as the cache bound', async () => {
      const restore = guard();
      const doFetch = okProfile();
      const withExp = options({ fetchImpl: doFetch as any, exp: NOW / 1000 + 60 });
      await fetchRealmUserinfo(withExp);
      const before = { ...withExp, now: () => NOW + 59 * 1000 };
      await fetchRealmUserinfo(before);
      const after = { ...withExp, now: () => NOW + 61 * 1000 };
      const second = await fetchRealmUserinfo(after);
      restore();
      // One cached hit (before exp) + one re-fetch (after exp).
      expect(doFetch).toHaveBeenCalledTimes(2);
      expect(second.outcome).toBe('profile');
    });

    it('bounds the cache at 5000 entries, evicting the oldest first', async () => {
      const restore = guard();
      const doFetch = jest.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ sub: SUB, email: 'person@example.com', email_verified: true }),
          }) as Response,
      );
      for (let i = 0; i < USERINFO_CACHE_MAX_ENTRIES; i++) {
        await fetchRealmUserinfo(options({ fetchImpl: doFetch as any, bearer: `bearer-${i}` }));
      }
      // One more bearer evicts bearer-0 (oldest insert); its digest must miss.
      await fetchRealmUserinfo(options({ fetchImpl: doFetch as any, bearer: 'bearer-overflow' }));
      await fetchRealmUserinfo(options({ fetchImpl: doFetch as any, bearer: 'bearer-0' }));
      restore();
      // 5000 initial + overflow (evicts bearer-0) + the re-fetch of bearer-0.
      expect(doFetch).toHaveBeenCalledTimes(USERINFO_CACHE_MAX_ENTRIES + 2);
    });

    it('times out at 3 s and degrades to unavailable (never throws)', async () => {
      const restore = guard();
      const doFetch = jest.fn(
        (_url: string, init: any) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      );
      const resolution = await fetchRealmUserinfo(
        options({ fetchImpl: doFetch as any, now: () => NOW }),
      );
      restore();
      expect(resolution).toMatchObject({ outcome: 'unavailable' });
      expect(resolution.reason).toContain(String(USERINFO_TIMEOUT_MS));
    });

    it('degrades to unavailable on a transport error (never throws)', async () => {
      const restore = guard();
      const doFetch = jest.fn(async () => {
        throw new Error('network down');
      });
      const resolution = await fetchRealmUserinfo(options({ fetchImpl: doFetch as any }));
      restore();
      expect(resolution).toMatchObject({ outcome: 'unavailable' });
      expect(quiet.warn).toHaveBeenCalled();
    });

    it('degrades to unavailable on a non-JSON body (and caches the negative)', async () => {
      const restore = guard();
      const badJson = jest.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('nope'); } }));
      const a = await fetchRealmUserinfo(options({ fetchImpl: badJson as any }));
      const b = await fetchRealmUserinfo(options({ fetchImpl: badJson as any }));
      restore();
      expect(a).toMatchObject({ outcome: 'unavailable' });
      expect(b).toMatchObject({ outcome: 'unavailable' });
      expect(badJson).toHaveBeenCalledTimes(1);
    });

    it('refuses a non-object body (no profile to merge)', async () => {
      const restore = guard();
      const badShape = jest.fn(async () => ({ ok: true, status: 200, json: async () => ['a', 'b'] }));
      const b = await fetchRealmUserinfo(options({ fetchImpl: badShape as any }));
      restore();
      expect(b).toMatchObject({ outcome: 'refused' });
      expect(badShape).toHaveBeenCalledTimes(1);
    });

    it('never logs the bearer or the email', async () => {
      const restore = guard();
      const doFetch = okProfile();
      await fetchRealmUserinfo(options({ fetchImpl: doFetch as any }));
      const doFetchErr = jest.fn(async () => {
        throw new Error('network down');
      });
      await fetchRealmUserinfo(options({ fetchImpl: doFetchErr as any, bearer: 'secret-bearer-value' }));
      restore();
      const logged = [
        quiet.log.mock.calls,
        quiet.warn.mock.calls,
        quiet.error.mock.calls,
      ]
        .flat()
        .flat()
        .join(' ');
      expect(logged).not.toContain('secret-bearer-value');
      expect(logged).not.toContain('person@example.com');
      expect(logged).not.toContain(BEARER);
    });
  });
});

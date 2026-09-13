import { ConfigService } from '@nestjs/config';
import { BrigadeTokenSource } from './brigade-token-source';

/**
 * Pins the scope-keyed subject cache (R1 regression guard).
 *
 * The customer-ops client-credentials SUBJECT token is minted per requested
 * scope and MUST be cached keyed by scope: contacts:* are KC *optional* scopes
 * (only present when requested) while meetings:read is a *default* scope (always
 * present). A scope-agnostic 'cc:subject' key let a meetings:read-only subject
 * (minted first by the Meeting-Ops path) get reused for a later contacts:write
 * exchange, whose least-privilege intersection (requested ∩ subject) is then ∅ →
 * Brigade 403 → the lead→contact write silently no-ops. This is order-dependent
 * (a single manual e2e passed only because contacts minted first). These tests
 * prove the mint is keyed by scope so order can never starve a path.
 */
function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

const ENV = {
  KEYCLOAK_URL: 'https://auth.test/',
  KEYCLOAK_REALM: 'uchub',
  KEYCLOAK_CLIENT_ID: 'customer-ops',
  KEYCLOAK_CLIENT_SECRET: 'sekret',
};

/** A fetch fake that returns the request's `scope` form-field back inside the
 *  access_token (for the KC mint) so a test can assert which scope was minted,
 *  and an opaque token for the Brigade exchange. Records every call. */
function makeFetch() {
  const calls: Array<{
    url: string;
    scope: string | null;
    subject: string | null;
    audience: string | null;
  }> = [];
  const fn = jest.fn(async (url: string, init: any) => {
    const params = new URLSearchParams(init.body as string);
    const isMint = url.includes('/openid-connect/token');
    const scope = params.get('scope');
    const subject = params.get('subject_token');
    calls.push({ url, scope, subject, audience: params.get('audience') });
    const access_token = isMint
      ? `subjtok|scope=${scope}` // echo the minted scope so we can assert it
      : `exchanged|for=${params.get('audience')}|sub=${subject}`;
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token, expires_in: 300 }),
    } as unknown as Response;
  });
  return { fn, calls };
}

describe('BrigadeTokenSource — scope-keyed subject cache (R1)', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  it('mints a DISTINCT subject per scope (meeting-first does not starve contacts)', async () => {
    const { fn, calls } = makeFetch();
    global.fetch = fn as any;
    const src = new BrigadeTokenSource(makeConfig(ENV));

    // Meeting-Ops path FIRST (the order that triggered the bug).
    await src.exchangedToken({ audience: 'meeting-ops', scope: 'meetings:read', workspaceId: 'ws' });
    // Then Contact-Ops — must NOT reuse the meetings:read-only subject.
    await src.exchangedToken({
      audience: 'contact-ops',
      scope: 'contacts:read contacts:write',
      workspaceId: 'ws',
    });

    const mints = calls.filter((c) => c.url.includes('/openid-connect/token'));
    // Two distinct subject mints, one per scope-set.
    expect(mints.map((m) => m.scope).sort()).toEqual(
      ['contacts:read contacts:write', 'meetings:read'].sort(),
    );
    // The contact-ops exchange used a subject minted WITH the contacts scope
    // (NOT the meetings:read-only subject — that was the bug).
    const coExchange = calls.find(
      (c) => c.url.includes('/federation/token') && c.audience === 'contact-ops',
    );
    expect(coExchange?.subject).toBe('subjtok|scope=contacts:read contacts:write');
    // And the meeting-ops exchange used the meetings subject — each path isolated.
    const moExchange = calls.find(
      (c) => c.url.includes('/federation/token') && c.audience === 'meeting-ops',
    );
    expect(moExchange?.subject).toBe('subjtok|scope=meetings:read');
  });

  it('reuses the cached subject for the SAME scope (one mint, then served from cache)', async () => {
    const { fn, calls } = makeFetch();
    global.fetch = fn as any;
    const src = new BrigadeTokenSource(makeConfig(ENV));

    await src.exchangedToken({ audience: 'contact-ops', scope: 'contacts:read contacts:write', workspaceId: 'ws' });
    await src.exchangedToken({ audience: 'contact-ops', scope: 'contacts:read contacts:write', workspaceId: 'wsB' });

    const mints = calls.filter((c) => c.url.includes('/openid-connect/token'));
    // Same scope → subject minted ONCE (second call hits the subject cache);
    // but two exchanges (different workspace → different exchange cache key).
    expect(mints).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('/federation/token'))).toHaveLength(2);
  });

  it('caches the exchanged token per (audience, workspace)', async () => {
    const { fn, calls } = makeFetch();
    global.fetch = fn as any;
    const src = new BrigadeTokenSource(makeConfig(ENV));

    await src.exchangedToken({ audience: 'contact-ops', scope: 'contacts:read', workspaceId: 'ws' });
    await src.exchangedToken({ audience: 'contact-ops', scope: 'contacts:read', workspaceId: 'ws' });

    // Second call fully cached: no new mint, no new exchange.
    expect(calls).toHaveLength(2); // 1 mint + 1 exchange, total, for both calls
  });
  it.each([
    ['invoices:read', 'invoices:read invoices:write'],
    ['invoices:read invoices:write', 'invoices:read'],
  ])('keeps exchanged scopes separate: %s then %s', async (first, second) => {
    const { fn, calls } = makeFetch();
    global.fetch = fn as any;
    const src = new BrigadeTokenSource(makeConfig(ENV));
    const ctx = { audience: 'accounting-ops', workspaceId: 'ws' };
    const a = await src.exchangedToken({ ...ctx, scope: first });
    const b = await src.exchangedToken({ ...ctx, scope: second });
    expect(a).not.toBe(b);
    expect(calls.filter(c => c.audience === 'accounting-ops').map(c => c.scope)).toEqual([first, second]);
    expect(await src.exchangedToken({ ...ctx, scope: first })).toBe(a);
    expect(calls).toHaveLength(4);
  });

  it('returns and caches direct service-account tokens without a Brigade exchange', async () => {
    const { fn, calls } = makeFetch(); global.fetch = fn as any;
    const src = new BrigadeTokenSource(makeConfig(ENV));
    expect(await src.clientCredentialsToken('invoices:write')).toBe('subjtok|scope=invoices:write');
    await src.clientCredentialsToken('invoices:write');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/realms/uchub/protocol/openid-connect/token');
    const body = new URLSearchParams(fn.mock.calls[0][1].body);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('customer-ops');
    expect(body.has('subject_token')).toBe(false);
  });
  it('direct token failure is null, without falling back to an exchange', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 }) as any;
    const src = new BrigadeTokenSource(makeConfig(ENV));
    expect(await src.clientCredentialsToken('invoices:write')).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

});

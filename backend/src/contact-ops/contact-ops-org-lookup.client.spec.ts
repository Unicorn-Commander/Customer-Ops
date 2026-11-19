import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContactOpsOrgLookupClient } from './contact-ops-org-lookup.client';
import { ContactOpsMapProvisioner } from './contact-ops-map.provisioner';

/**
 * The Contact-Ops org lookup (Contact-Ops #42, org_tenancy.py):
 *   GET {CONTACT_OPS_BASE_URL}/api/service/ops-center-orgs/{org_id}/tenant
 * with a client-credentials bearer of the dedicated lookup client. Contact-Ops
 * and Keycloak are MOCKED via global.fetch; fictional hosts only.
 */
const ORG_A = '0b7d7a52-4f6e-4c1a-9d0e-1a2b3c4d5e6f';
const ORG_B = '9f8e7d6c-5b4a-4c3d-8e2f-0a1b2c3d4e5f';
const TENANT_A = '11111111-2222-4333-8444-555555555555';
const TOKEN_URL = 'https://sso.example.com/realms/uchub/protocol/openid-connect/token';
const BASE = 'https://contacts.example.com';
const LIVE = {
  CONTACT_OPS_BASE_URL: BASE,
  CONTACT_OPS_LOOKUP_CLIENT_ID: 'contact-ops-org-lookup-client',
  CONTACT_OPS_LOOKUP_CLIENT_SECRET: 'fixture-secret-not-real',
  CONTACT_OPS_LOOKUP_TOKEN_URL: TOKEN_URL,
};

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** A fake Keycloak + Contact-Ops: the lookup answers from `answers` by org id. */
function fakeFetch(answers: Record<string, { status: number; body?: unknown }>) {
  return jest.fn(async (url: string, init: any) => {
    if (url === TOKEN_URL) return res(200, { access_token: 'lookup-cc-token', expires_in: 300 });
    const m = /\/api\/service\/ops-center-orgs\/([^/]+)\/tenant$/.exec(url);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    expect(init.headers.Authorization).toBe('Bearer lookup-cc-token');
    const a = answers[decodeURIComponent(m[1])] ?? { status: 404, body: { detail: 'not found' } };
    return res(a.status, a.body);
  });
}

describe('ContactOpsOrgLookupClient', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });

  it('asks Contact-Ops for THAT org id with a client-credentials bearer and returns its tenant', async () => {
    const fetchSpy = fakeFetch({
      [ORG_A]: {
        status: 200,
        body: { ops_center_org_id: ORG_A, tenant_id: TENANT_A, tenant_slug: 'acme' },
      },
    });
    global.fetch = fetchSpy as any;
    const client = new ContactOpsOrgLookupClient(makeConfig(LIVE));

    await expect(client.lookupTenant(ORG_A)).resolves.toEqual({
      kind: 'tenant',
      tenantId: TENANT_A,
      tenantSlug: 'acme',
    });
    const [tokenUrl, tokenInit] = fetchSpy.mock.calls[0];
    expect(tokenUrl).toBe(TOKEN_URL);
    const form = new URLSearchParams(tokenInit.body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('contact-ops-org-lookup-client');
    expect(fetchSpy.mock.calls[1][0]).toBe(`${BASE}/api/service/ops-center-orgs/${ORG_A}/tenant`);
    expect(fetchSpy.mock.calls[1][1].method).toBe('GET');
  });

  it('refuses an answer for a different org id than the one asked (never a first match)', async () => {
    global.fetch = fakeFetch({
      [ORG_A]: {
        status: 200,
        body: { ops_center_org_id: ORG_B, tenant_id: TENANT_A, tenant_slug: 'acme' },
      },
    }) as any;
    const client = new ContactOpsOrgLookupClient(makeConfig(LIVE));
    await expect(client.lookupTenant(ORG_A)).resolves.toMatchObject({ kind: 'mismatch' });
  });

  it('refuses an answer whose tenant id is not a uuid', async () => {
    global.fetch = fakeFetch({
      [ORG_A]: {
        status: 200,
        body: { ops_center_org_id: ORG_A, tenant_id: 'acme', tenant_slug: 'acme' },
      },
    }) as any;
    const client = new ContactOpsOrgLookupClient(makeConfig(LIVE));
    await expect(client.lookupTenant(ORG_A)).resolves.toMatchObject({ kind: 'mismatch' });
  });

  it('is DORMANT (no fetch) when any lookup env is unset', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    for (const missing of Object.keys(LIVE)) {
      const client = new ContactOpsOrgLookupClient(makeConfig({ ...LIVE, [missing]: undefined }));
      expect(client.isConfigured()).toBe(false);
      await expect(client.lookupTenant(ORG_A)).resolves.toEqual({ kind: 'dormant' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('the failure answers (C2): no row, never a throw', () => {
    it('404 and 422 mean "no tenant for that org"', async () => {
      const client = new ContactOpsOrgLookupClient(makeConfig(LIVE));
      global.fetch = fakeFetch({ [ORG_A]: { status: 404, body: { detail: 'x' } } }) as any;
      await expect(client.lookupTenant(ORG_A)).resolves.toEqual({ kind: 'no_tenant' });
      global.fetch = fakeFetch({ [ORG_A]: { status: 422, body: { detail: 'x' } } }) as any;
      await expect(client.lookupTenant(ORG_A)).resolves.toEqual({ kind: 'no_tenant' });
    });

    it('a non-uuid org id is "no tenant" without asking Contact-Ops', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      const client = new ContactOpsOrgLookupClient(makeConfig(LIVE));
      await expect(client.lookupTenant('org-acme')).resolves.toEqual({ kind: 'no_tenant' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([401, 403, 500, 503])('HTTP %i is "unavailable"', async (status) => {
      global.fetch = fakeFetch({ [ORG_A]: { status, body: { detail: 'x' } } }) as any;
      const client = new ContactOpsOrgLookupClient(makeConfig(LIVE));
      await expect(client.lookupTenant(ORG_A)).resolves.toMatchObject({ kind: 'unavailable' });
    });

    it('a transport error, a non-JSON body or a failed token mint is "unavailable"', async () => {
      const client = new ContactOpsOrgLookupClient(makeConfig(LIVE));
      global.fetch = jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as any;
      await expect(client.lookupTenant(ORG_A)).resolves.toMatchObject({ kind: 'unavailable' });

      global.fetch = jest.fn(async (url: string) =>
        url === TOKEN_URL
          ? res(200, { access_token: 'lookup-cc-token' })
          : ({
              ok: true,
              status: 200,
              json: async () => {
                throw new SyntaxError('Unexpected token <');
              },
            } as unknown as Response),
      ) as any;
      await expect(client.lookupTenant(ORG_A)).resolves.toMatchObject({ kind: 'unavailable' });

      const fresh = new ContactOpsOrgLookupClient(makeConfig(LIVE));
      global.fetch = jest.fn(async () => res(401, { error: 'invalid_client' })) as any;
      await expect(fresh.lookupTenant(ORG_A)).resolves.toMatchObject({ kind: 'unavailable' });
    });

    it('a lookup that hangs past CONTACT_OPS_TIMEOUT_MS is "unavailable"', async () => {
      global.fetch = jest.fn((url: string, init: any) =>
        url === TOKEN_URL
          ? Promise.resolve(res(200, { access_token: 'lookup-cc-token' }))
          : new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
      ) as any;
      const client = new ContactOpsOrgLookupClient(
        makeConfig({ ...LIVE, CONTACT_OPS_TIMEOUT_MS: '20' }),
      );
      await expect(client.lookupTenant(ORG_A)).resolves.toMatchObject({ kind: 'unavailable' });
    });

    it.each(['the lookup', 'the token mint'])(
      'a body that never finishes (%s) is "unavailable" within the timeout (R3-4)',
      async (which) => {
        // Headers arrive; json() only ends when the request's abort signal fires,
        // as with real fetch. One deadline must cover the whole request.
        const stalled = (init: any) =>
          ({
            ok: true,
            status: 200,
            json: () =>
              new Promise((_resolve, reject) =>
                init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
              ),
          }) as unknown as Response;
        global.fetch = jest.fn(async (url: string, init: any) => {
          if (url === TOKEN_URL) {
            return which === 'the token mint'
              ? stalled(init)
              : res(200, { access_token: 'lookup-cc-token' });
          }
          return stalled(init);
        }) as any;
        const client = new ContactOpsOrgLookupClient(
          makeConfig({ ...LIVE, CONTACT_OPS_TIMEOUT_MS: '30' }),
        );
        const started = Date.now();
        const answer = await Promise.race([
          client.lookupTenant(ORG_A),
          new Promise((r) => setTimeout(() => r({ kind: 'still-waiting' }), 1000)),
        ]);
        expect(answer).toMatchObject({ kind: 'unavailable' });
        expect(Date.now() - started).toBeLessThan(1000);
      },
    );
  });

  describe('failure details are sanitized categories, never response text (R3-5)', () => {
    // A fake credential a misbehaving endpoint echoes back inside its error text.
    const ECHOED = 'fixture-echoed-secret-0000-not-real';
    const badJson = () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError(`Unexpected token in JSON: {"access_token":"${ECHOED}"`);
        },
      }) as unknown as Response;
    let logged: string[];

    beforeEach(() => {
      logged = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          logged.push(args.map(String).join(' '));
        });
      }
    });
    afterEach(() => jest.restoreAllMocks());

    it.each<[string, (url: string) => Response | Promise<Response>, string]>([
      [
        'a malformed token response',
        (url) => (url === TOKEN_URL ? badJson() : res(200, {})),
        'bad_json',
      ],
      [
        'a malformed lookup response',
        (url) => (url === TOKEN_URL ? res(200, { access_token: 'lookup-cc-token' }) : badJson()),
        'bad_json',
      ],
      [
        'a transport error quoting the request',
        () => {
          throw new TypeError(`fetch failed: client_secret=${ECHOED}`);
        },
        'transport',
      ],
      [
        'a 503 from the lookup',
        (url) => (url === TOKEN_URL ? res(200, { access_token: 'lookup-cc-token' }) : res(503, {})),
        'http_503',
      ],
    ])(
      '%s: a sanitized category; the provisioner log never carries response text',
      async (_l, answer, detail) => {
        global.fetch = jest.fn(async (url: string) => answer(url)) as any;
        const client = new ContactOpsOrgLookupClient(makeConfig(LIVE));
        await expect(client.lookupTenant(ORG_A)).resolves.toEqual({ kind: 'unavailable', detail });

        const prisma = { federationWorkspaceMap: { findUnique: jest.fn(), create: jest.fn() } };
        const writer = new ContactOpsMapProvisioner(prisma as any, client, {
          reload: jest.fn(),
        } as any);
        await expect(writer.ensureForOrg(ORG_A)).resolves.toEqual({
          kind: 'skipped',
          reason: 'unavailable',
        });
        expect(logged.join('\n')).toContain(`unavailable (${detail})`);
        expect(logged.join('\n')).not.toContain(ECHOED);
        expect(logged.join('\n')).not.toMatch(/Unexpected token|fetch failed/);
      },
    );
  });
});

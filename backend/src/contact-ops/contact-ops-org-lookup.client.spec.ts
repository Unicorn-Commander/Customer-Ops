import { ConfigService } from '@nestjs/config';
import { ContactOpsOrgLookupClient } from './contact-ops-org-lookup.client';

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
});

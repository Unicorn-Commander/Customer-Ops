import { ConfigService } from '@nestjs/config';
import { ContactOpsClient } from './contact-ops.client';
import { FederationContext } from './contact-ops.port';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';
import { FederationWorkspaceMapService } from '../common/federation/federation-workspace-map.service';

/**
 * The federation workspace map (added with the per-workspace map in 0d09be3).
 * `routableTarget` is the request-time DB read of the workspace's contact-ops
 * row (R5-2): null means no routable row (none, or in conflict), and the client
 * then addresses no tenant at all. By default the row maps the test workspace
 * onto itself ('ws-aaaa', CTX below), the addressing these specs were written
 * against. Pass null for an unmapped workspace.
 */
function makeFedMap(mapped: string | null = 'ws-aaaa') {
  return {
    routableTarget: jest.fn(async () => mapped),
  } as any;
}

/** These tests exercise STATIC auth mode (CONTACT_OPS_SERVICE_TOKEN forwarded),
 *  so the Brigade source is never reached; a stub that returns null suffices.
 *  The brigade-sts path is proven live, not unit-mocked. */
function makeBrigade(): BrigadeTokenSource {
  return { exchangedToken: jest.fn().mockResolvedValue(null) } as unknown as BrigadeTokenSource;
}

/**
 * The Contact-Ops federation client speaks JSON-RPC 2.0 to CO's `POST /mcp` and
 * the signed `GET /api/v1/workspaces/{id}` projection. Contact-Ops is MOCKED
 * here via a fake global.fetch — CO is never running. These pin:
 *   - get_person → FederatedContact mapping (CO PersonSummary/GetPersonOutput),
 *   - list_people / search_people switch + summary mapping,
 *   - the workspace is sent as the wire claim path/header (never trusted from a
 *     local header on CO's side, but Customer-Ops forwards X-Workspace-Id),
 *   - DEGRADE-CLEAN: unset CONTACT_OPS_BASE_URL → empty/null, no throw,
 *   - transport/HTTP/tool errors → null/empty, never throw (federation is
 *     best-effort).
 */
const CTX: FederationContext = { workspaceId: 'ws-aaaa', ucUid: 'uc-uid-1' };

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A JSON-RPC tools/call success envelope wrapping structuredContent. */
function rpcOk(structured: unknown) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      isError: false,
      structuredContent: structured,
      content: [{ type: 'text', text: JSON.stringify(structured) }],
    },
  };
}

describe('ContactOpsClient (Contact-Ops MOCKED)', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  describe('when CONTACT_OPS_BASE_URL is unset (dormant)', () => {
    const client = new ContactOpsClient(makeConfig({}), makeBrigade(), makeFedMap());

    it('getContact returns null without any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.getContact(CTX, 'p1')).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('listContacts returns an empty page', async () => {
      await expect(client.listContacts(CTX, {})).resolves.toEqual({
        items: [],
        count: 0,
        nextCursor: null,
      });
    });

    it('getContactSummaries returns an empty map', async () => {
      const m = await client.getContactSummaries(CTX, ['p1', 'p2']);
      expect(m.size).toBe(0);
    });

    it('getWorkspaceProjection returns null', async () => {
      await expect(client.getWorkspaceProjection(CTX)).resolves.toBeNull();
    });
  });

  describe('dormant (no base URL) + MAPPED workspace (audit 9c049f6d Q2)', () => {
    // A mapped workspace whose CO base URL has been cleared (maintenance window):
    // "connected" must be FALSE so create answers 409 not_connected, not 503.
    const client = new ContactOpsClient(makeConfig({}), makeBrigade(), makeFedMap('co-tenant-a'));

    it('isWorkspaceConnected is false (mapped but no base URL)', async () => {
      await expect(client.isWorkspaceConnected(CTX)).resolves.toBe(false);
    });

    it('verifyContact -> not_connected (no fetch), NOT unavailable', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.verifyContact(CTX, 'p1')).resolves.toBe('not_connected');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('with CONTACT_OPS_BASE_URL set', () => {
    const env = {
      CONTACT_OPS_BASE_URL: 'https://contacts.example.test/',
      CONTACT_OPS_SERVICE_TOKEN: 'svc-token-xyz',
    };

    describe('verifyContact (CO-1)', () => {
      const mk = (resp: any) => {
        global.fetch = jest.fn().mockResolvedValue(resp) as any;
        return new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap('co-tenant-a'));
      };

      it('exists when get_person returns the person', async () => {
        const c = mk(jsonResponse(rpcOk({ person_id: 'p1', display_name: 'Jane' })));
        await expect(c.verifyContact(CTX, 'p1')).resolves.toBe('exists');
      });
      it('missing when Contact-Ops answers not-found / invalid-params', async () => {
        const toolErr = jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'Person not found' }] },
        });
        await expect(mk(toolErr).verifyContact(CTX, 'p1')).resolves.toBe('missing');
        const rpcErr = jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32602, message: 'invalid person_id' },
        });
        await expect(mk(rpcErr).verifyContact(CTX, 'E2E Test Contact')).resolves.toBe('missing');
      });
      it('missing for a provisional prov: id without a round-trip', async () => {
        const c = mk(jsonResponse(rpcOk({ person_id: 'x' })));
        await expect(c.verifyContact(CTX, 'prov:abc')).resolves.toBe('missing');
        expect(global.fetch).not.toHaveBeenCalled();
      });
      it('unavailable on HTTP 500 and transport failure; not_connected when dormant (audit 9c049f6d Q2)', async () => {
        const c500 = mk(jsonResponse({}, false, 500));
        await expect(c500.verifyContact(CTX, 'p1')).resolves.toBe('unavailable');
        global.fetch = jest.fn().mockRejectedValue(new Error('boom')) as any;
        const c = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap('co-tenant-a'));
        await expect(c.verifyContact(CTX, 'p1')).resolves.toBe('unavailable');
        // Dormant (no base URL) but MAPPED: "connected" is now false, so the
        // create path answers 409 not_connected instead of 503 unavailable.
        const dormant = new ContactOpsClient(
          makeConfig({}),
          makeBrigade(),
          makeFedMap('co-tenant-a'),
        );
        await expect(dormant.verifyContact(CTX, 'p1')).resolves.toBe('not_connected');
      });

      it('not_connected (no fetch) when the workspace has no contact-ops mapping', async () => {
        global.fetch = jest.fn() as any;
        const c = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap(null));
        await expect(c.verifyContact(CTX, 'p1')).resolves.toBe('not_connected');
        expect(global.fetch).not.toHaveBeenCalled();
        await expect(c.isWorkspaceConnected(CTX)).resolves.toBe(false);
      });
      it('unavailable (not not_connected) on a timeout for a MAPPED workspace', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('timeout')) as any;
        const c = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap('co-tenant-a'));
        await expect(c.verifyContact(CTX, 'p1')).resolves.toBe('unavailable');
        await expect(c.isWorkspaceConnected(CTX)).resolves.toBe(true);
      });
    });

    describe('cross-org isolation (two mapped workspaces, two Contact-Ops tenants)', () => {
      const WS_A: FederationContext = { workspaceId: 'ws-org-a', ucUid: 'ua' };
      const WS_B: FederationContext = { workspaceId: 'ws-org-b', ucUid: 'ub' };
      const TENANTS: Record<string, string> = {
        'ws-org-a': 'co-tenant-a',
        'ws-org-b': 'co-tenant-b',
      };
      // Fake Contact-Ops: each tenant owns only its own people; the request is
      // answered from the tenant named in X-Workspace-Id.
      const PEOPLE: Record<string, Record<string, { name: string; email: string }>> = {
        'co-tenant-a': { 'pa-1': { name: 'Ann Alpha', email: 'ann@a.example.com' } },
        'co-tenant-b': { 'pb-1': { name: 'Bob Beta', email: 'bob@b.example.com' } },
      };
      const seenTenants: string[] = [];
      const mk = () => {
        global.fetch = jest.fn(async (_u: any, init: any) => {
          const tenant = init.headers['X-Workspace-Id'] as string;
          seenTenants.push(tenant);
          const { params } = JSON.parse(init.body);
          const people = PEOPLE[tenant] ?? {};
          if (params.name === 'get_person') {
            const p = people[params.arguments.person_id];
            return p
              ? jsonResponse(rpcOk({ person_id: params.arguments.person_id, display_name: p.name }))
              : jsonResponse({
                  jsonrpc: '2.0',
                  id: 1,
                  result: { isError: true, content: [{ type: 'text', text: 'Person not found' }] },
                });
          }
          return jsonResponse(
            rpcOk({
              items: Object.entries(people).map(([id, p]) => ({
                person_id: id,
                display_name: p.name,
                primary_email: p.email,
              })),
              count: Object.keys(people).length,
            }),
          );
        }) as any;
        const fed = {
          routableTarget: jest.fn(async (ws: string) => TENANTS[ws] ?? null),
        } as any;
        return new ContactOpsClient(makeConfig(env), makeBrigade(), fed);
      };
      beforeEach(() => (seenTenants.length = 0));

      it("org A's search never returns B's people", async () => {
        const c = mk();
        const page = await c.listContacts(WS_A, { query: 'a', limit: 10 });
        expect(page.items.map((i) => i.contactId)).toEqual(['pa-1']);
        expect(JSON.stringify(page)).not.toContain('Bob');
        expect(seenTenants).toEqual(['co-tenant-a']);
      });
      it("A's verify of an id that exists only in B's tenant is 'missing' (-> 422, no row)", async () => {
        const c = mk();
        await expect(c.verifyContact(WS_A, 'pb-1')).resolves.toBe('missing');
        await expect(c.verifyContact(WS_B, 'pb-1')).resolves.toBe('exists');
        expect(seenTenants).toEqual(['co-tenant-a', 'co-tenant-b']);
      });
    });

    it('get_person: posts JSON-RPC tools/call and maps GetPersonOutput → FederatedContact', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse(
          rpcOk({
            person_id: 'p1',
            etag: 'W/"3"',
            vcard_uid: 'vc-1',
            display_name: 'Jane Lead',
            kind: 'individual',
            status: 'active',
            emails: [{ address: 'jane@x.com', is_primary: true, type: 'work' }],
            phones: [{ e164: '+15551234567', type: 'mobile' }],
            recent_events: [{ id: 'e1' }],
          }),
        ),
      );
      global.fetch = fetchSpy as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const contact = await client.getContact(CTX, 'p1');

      // URL + method + JSON-RPC body shape.
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://contacts.example.test/mcp');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_person', arguments: { person_id: 'p1' } },
      });
      // Workspace forwarded as the wire address (header) + service token.
      expect(init.headers['X-Workspace-Id']).toBe('ws-aaaa');
      expect(init.headers['Authorization']).toBe('Bearer svc-token-xyz');

      // Mapping CO → federation projection.
      expect(contact).toMatchObject({
        contactId: 'p1',
        displayName: 'Jane Lead',
        primaryEmail: 'jane@x.com',
        etag: 'W/"3"',
        kind: 'individual',
        status: 'active',
      });
      expect(contact?.emails).toHaveLength(1);
      expect(contact?.phones[0].e164).toBe('+15551234567');
    });

    it('upsertContact: sends only contract fields, including initial_tags', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(jsonResponse(rpcOk({ person_id: 'p3', created: true, etag: 'W/"4"' })));
      global.fetch = fetchSpy as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const result = await client.upsertContact(CTX, {
        source: 'northwind',
        sourceDedupKey: 'lead-1',
        displayName: 'Diesel Dude',
        givenName: 'Diesel',
        familyName: 'Dude',
        nicknames: ['Diesel'],
        email: 'diesel@x.com',
        phone: '+15551234567',
        organization: { name: 'Acme Exteriors', domain: 'x.com' },
        tags: ['james-sdr', 'contractor'],
      });

      expect(result?.contactId).toBe('p3');
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.arguments).toMatchObject({
        display_name: 'Diesel Dude',
        given_name: 'Diesel',
        family_name: 'Dude',
        nicknames: ['Diesel'],
        emails: [{ address: 'diesel@x.com', is_primary: true }],
        phones: [{ e164: '+15551234567', is_primary: true }],
        organization: { name: 'Acme Exteriors', domain: 'x.com' },
        initial_tags: ['james-sdr', 'contractor'],
      });
      expect(body.params.arguments).not.toHaveProperty('org_name');
    });

    it('upsertContact: preserves an organization without a free-mail domain', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(jsonResponse(rpcOk({ person_id: 'p-free-mail', created: true })));
      global.fetch = fetchSpy as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      await client.upsertContact(CTX, {
        source: 'northwind',
        sourceDedupKey: 'lead-free-mail',
        email: 'person74@example.com',
        organization: { name: 'Acme Exteriors' },
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.arguments.organization).toEqual({ name: 'Acme Exteriors' });
      expect(body.params.arguments.organization).not.toHaveProperty('domain');
    });

    it('upsertContact: omits organization when no company is supplied', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(jsonResponse(rpcOk({ person_id: 'p-no-org', created: true })));
      global.fetch = fetchSpy as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      await client.upsertContact(CTX, {
        source: 'northwind',
        sourceDedupKey: 'lead-no-company',
        email: 'lead@acme.example',
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.arguments).not.toHaveProperty('organization');
    });

    it('get_person: maps structured names, nicknames, handles and links', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse(
          rpcOk({
            person_id: 'p-named',
            display_name: 'Diesel',
            kind: 'individual',
            status: 'active',
            given_name: 'Diesel',
            family_name: 'Dude',
            additional_names: ['Diesel Dave'],
            honorific_prefix: 'Mr.',
            honorific_suffix: 'Jr.',
            phonetic_given_name: 'DEE-sel',
            phonetic_family_name: 'DOOD',
            nicknames: ['Big D'],
            file_as: 'Diesel',
            pronouns: 'he/him',
            emails: [],
            phones: [],
            im_handles: [
              {
                id: 'h1',
                protocol: 'telegram',
                handle: '@diesel',
                label: 'personal',
                is_primary: true,
              },
            ],
            identifiers: [
              {
                id: 'i1',
                namespace: 'linkedin',
                value: 'diesel',
                url: 'https://linkedin.example/diesel',
                verified: true,
              },
            ],
            urls: [
              {
                id: 'u1',
                url: 'https://diesel.example',
                type: 'website',
                label: 'Home',
                is_primary: true,
              },
            ],
            recent_events: [],
          }),
        ),
      );
      global.fetch = fetchSpy as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const contact = await client.getContact(CTX, 'p-named');
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.arguments.include).toEqual(
        expect.arrayContaining(['emails', 'phones', 'im_handles', 'identifiers', 'urls']),
      );
      expect(contact).toMatchObject({
        givenName: 'Diesel',
        familyName: 'Dude',
        additionalNames: ['Diesel Dave'],
        honorificPrefix: 'Mr.',
        honorificSuffix: 'Jr.',
        phoneticGivenName: 'DEE-sel',
        phoneticFamilyName: 'DOOD',
        nicknames: ['Big D'],
        fileAs: 'Diesel',
        pronouns: 'he/him',
        imHandles: [{ id: 'h1', protocol: 'telegram', handle: '@diesel' }],
        identifiers: [{ id: 'i1', namespace: 'linkedin', verified: true }],
        urls: [{ id: 'u1', url: 'https://diesel.example', type: 'website' }],
      });
    });

    it('get_person: defaults optional structured collections when Contact-Ops omits them', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse(
          rpcOk({
            person_id: 'p-bare',
            display_name: 'Bare',
            kind: 'individual',
            status: 'active',
          }),
        ),
      ) as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const contact = await client.getContact(CTX, 'p-bare');
      expect(contact).toMatchObject({
        givenName: null,
        familyName: null,
        fileAs: null,
        pronouns: null,
        additionalNames: [],
        nicknames: [],
        imHandles: [],
        identifiers: [],
        urls: [],
      });
    });

    it('get_person: maps merged state and the owner relationship category', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse(
          rpcOk({
            person_id: 'p-merged',
            display_name: 'Old Duplicate',
            kind: 'individual',
            status: 'active',
            merged_into_id: 'p-survivor',
            relationship_category: 'coworker',
            emails: [],
            phones: [],
            recent_events: [],
          }),
        ),
      ) as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const contact = await client.getContact(CTX, 'p-merged');
      expect(contact).toMatchObject({
        mergedIntoId: 'p-survivor',
        relationshipCategory: 'coworker',
        status: 'active',
      });
    });

    it('get_person: defaults lifecycle fields to null when Contact-Ops omits them', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse(
          rpcOk({
            person_id: 'p-live',
            display_name: 'Live',
            kind: 'individual',
            status: 'active',
          }),
        ),
      ) as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const contact = await client.getContact(CTX, 'p-live');
      expect(contact?.mergedIntoId).toBeNull();
      expect(contact?.relationshipCategory).toBeNull();
    });

    it('get_person: derives primary_email from emails[] when CO omits the flat field', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse(
          rpcOk({
            person_id: 'p2',
            display_name: 'Bob',
            kind: 'individual',
            status: 'active',
            emails: [
              { address: 'secondary@x.com', is_primary: false },
              { address: 'primary@x.com', is_primary: true },
            ],
            phones: [],
            recent_events: [],
          }),
        ),
      ) as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());
      const contact = await client.getContact(CTX, 'p2');
      expect(contact?.primaryEmail).toBe('primary@x.com');
    });

    it('listContacts: uses list_people for structured filters', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse(
          rpcOk({
            items: [
              {
                person_id: 'p1',
                display_name: 'Alice',
                primary_email: 'a@x.com',
                current_org_name: 'Acme',
                tags: ['vip'],
                etag: 'W/"1"',
              },
            ],
            count: 1,
            next_cursor: 'cur2',
          }),
        ),
      );
      global.fetch = fetchSpy as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const page = await client.listContacts(CTX, { hasEmail: true, tagsAny: ['vip'], limit: 10 });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.name).toBe('list_people');
      expect(body.params.arguments).toMatchObject({
        has_email: true,
        tags_any: ['vip'],
        limit: 10,
      });
      expect(page.items[0]).toMatchObject({
        contactId: 'p1',
        displayName: 'Alice',
        currentOrgName: 'Acme',
      });
      expect(page.nextCursor).toBe('cur2');
    });

    it('listContacts: uses search_people when a query is present', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(jsonResponse(rpcOk({ items: [], count: 0, next_cursor: null })));
      global.fetch = fetchSpy as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      await client.listContacts(CTX, { query: 'jane' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.name).toBe('search_people');
      expect(body.params.arguments.query).toBe('jane');
    });

    it('getContactSummaries: resolves each id via get_person and keys the map', async () => {
      const fetchSpy = jest.fn().mockImplementation((_url: string, init: any) => {
        const body = JSON.parse(init.body);
        const id = body.params.arguments.person_id;
        return Promise.resolve(
          jsonResponse(
            rpcOk({
              person_id: id,
              display_name: `Name ${id}`,
              kind: 'individual',
              status: 'active',
              emails: [],
              phones: [],
              recent_events: [],
            }),
          ),
        );
      });
      global.fetch = fetchSpy as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const m = await client.getContactSummaries(CTX, ['p1', 'p2', 'p1']); // dedupes p1
      expect(m.size).toBe(2);
      expect(m.get('p1')?.displayName).toBe('Name p1');
      expect(m.get('p2')?.displayName).toBe('Name p2');
      // 2 unique fetches, not 3.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('getWorkspaceProjection: GETs the signed projection and maps the 9 fields', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse({
          workspace_id: 'ws-aaaa',
          slug: 'acme',
          display_name: 'Acme',
          isolation_mode: 'strict',
          isolation_tier: 'premium',
          hipaa_mode: true,
          gdpr_mode: false,
          data_residency: 'us-east',
          status: 'active',
        }),
      );
      global.fetch = fetchSpy as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const proj = await client.getWorkspaceProjection(CTX);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://contacts.example.test/api/v1/workspaces/ws-aaaa');
      expect(init.method).toBe('GET');
      expect(proj).toMatchObject({
        workspaceId: 'ws-aaaa',
        isolationMode: 'strict',
        isolationTier: 'premium',
        hipaaMode: true,
        status: 'active',
      });
    });

    it('returns null (never throws) on a JSON-RPC error envelope', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }),
        ) as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());
      await expect(client.getContact(CTX, 'p1')).resolves.toBeNull();
    });

    it('returns null (never throws) when the tool result is isError', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'PERSON_NOT_FOUND' }] },
        }),
      ) as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());
      await expect(client.getContact(CTX, 'missing')).resolves.toBeNull();
    });

    it('returns null (never throws) on a transport error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());
      await expect(client.getContact(CTX, 'p1')).resolves.toBeNull();
      await expect(client.listContacts(CTX, {})).resolves.toEqual({
        items: [],
        count: 0,
        nextCursor: null,
      });
    });

    it('returns empty page (never throws) on HTTP 500', async () => {
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({}, false, 500)) as any;
      const client = new ContactOpsClient(makeConfig(env), makeBrigade(), makeFedMap());
      await expect(client.listContacts(CTX, {})).resolves.toEqual({
        items: [],
        count: 0,
        nextCursor: null,
      });
    });
  });
});

describe('R5-3: the tenant id goes on the wire in canonical (lowercase) form', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });
  // A confirmed legacy row stored UPPERCASE (the lookup names it lowercase).
  const STORED = 'AAAAAAAA-0000-4000-8000-00000000000A';
  const CANONICAL = STORED.toLowerCase();

  it('X-Workspace-Id, the bearer workspace claim and the projection path are lowercase', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    global.fetch = jest.fn(async (url: string, init: any) => {
      calls.push({ url: String(url), headers: init.headers });
      return String(url).includes('/api/v1/workspaces/')
        ? jsonResponse({ workspace_id: CANONICAL, name: 'Example' })
        : jsonResponse(rpcOk({ items: [], count: 0 }));
    }) as any;
    const brigade = { exchangedToken: jest.fn().mockResolvedValue('exchanged-token') };
    const client = new ContactOpsClient(
      makeConfig({
        CONTACT_OPS_BASE_URL: 'https://contacts.example.test',
        CONTACT_OPS_AUTH_MODE: 'brigade-sts',
      }),
      brigade as unknown as BrigadeTokenSource,
      makeFedMap(STORED),
    );

    await client.listContacts(CTX, {});
    await client.verifyContact(CTX, 'p1');
    await client.getWorkspaceProjection(CTX);

    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.headers['X-Workspace-Id']).toBe(CANONICAL);
    expect(brigade.exchangedToken.mock.calls.map((c) => c[0].workspaceId)).toEqual([
      CANONICAL,
      CANONICAL,
      CANONICAL,
    ]);
    expect(calls[2].url).toBe(`https://contacts.example.test/api/v1/workspaces/${CANONICAL}`);
    expect(JSON.stringify(calls)).not.toContain(STORED);
  });
});

describe('R6-1: ping() routes through the DB-backed contact-ops decision', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });
  const PROBE_WS = 'ws-probe';
  const TENANT = 'cccccccc-0000-4000-8000-00000000000c';

  /** The real map service over a fake Prisma: `row` is the probe workspace's
   *  contact-ops row (undefined = none); `readFails` makes the DB read throw.
   *  The in-memory cache holds the tenant, as a stale reload would. */
  async function setup(
    row: { targetWorkspaceId: string; conflictTenantId: string | null } | undefined,
    readFails = false,
  ) {
    const prisma = {
      federationWorkspaceMap: {
        findUnique: jest.fn(async () => {
          if (readFails) throw new Error('connection refused');
          return row ?? null;
        }),
        // The cache was loaded earlier with the stored id, or with a routable
        // tenant when the row is gone (a stale reload).
        findMany: jest.fn(async () => [
          {
            localWorkspaceId: PROBE_WS,
            targetApp: 'contact-ops',
            targetWorkspaceId: row?.targetWorkspaceId ?? TENANT,
          },
        ]),
      },
    };
    const map = new FederationWorkspaceMapService(prisma as any, makeConfig({}));
    await map.reload();
    const fetchSpy = jest.fn(async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }));
    global.fetch = fetchSpy as any;
    const brigade = { exchangedToken: jest.fn().mockResolvedValue('exchanged-token') };
    const client = new ContactOpsClient(
      makeConfig({
        CONTACT_OPS_BASE_URL: 'https://contacts.example.test',
        CONTACT_OPS_AUTH_MODE: 'brigade-sts',
        HEALTH_PROBE_WORKSPACE_ID: PROBE_WS,
      }),
      brigade as unknown as BrigadeTokenSource,
      map,
    );
    return { client, fetchSpy, brigade };
  }

  const NOT_CONNECTED = {
    seam: 'contact-ops',
    configured: false,
    ok: false,
    status: null,
    detail: 'not-connected',
    latencyMs: null,
  };

  it('conflicted probe row: no fetch, no token exchange, not-connected', async () => {
    const { client, fetchSpy, brigade } = await setup({
      targetWorkspaceId: TENANT,
      conflictTenantId: 'dddddddd-0000-4000-8000-00000000000d',
    });
    await expect(client.ping()).resolves.toEqual(NOT_CONNECTED);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(brigade.exchangedToken).not.toHaveBeenCalled();
  });

  it('unmapped probe workspace: no fetch, no token exchange, not-connected', async () => {
    const { client, fetchSpy, brigade } = await setup(undefined);
    await expect(client.ping()).resolves.toEqual(NOT_CONNECTED);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(brigade.exchangedToken).not.toHaveBeenCalled();
  });

  it('failed DB read: no fetch, no token exchange, not-connected', async () => {
    const { client, fetchSpy, brigade } = await setup(
      { targetWorkspaceId: TENANT, conflictTenantId: null },
      true,
    );
    await expect(client.ping()).resolves.toEqual(NOT_CONNECTED);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(brigade.exchangedToken).not.toHaveBeenCalled();
  });

  it('uppercase legacy probe row: header and STS input are lowercase', async () => {
    const { client, fetchSpy, brigade } = await setup({
      targetWorkspaceId: TENANT.toUpperCase(),
      conflictTenantId: null,
    });
    const h = await client.ping();
    expect(h.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = (fetchSpy.mock.calls[0] as any[])[1];
    expect(init.headers['X-Workspace-Id']).toBe(TENANT);
    expect(brigade.exchangedToken.mock.calls.map((c) => c[0].workspaceId)).toEqual([TENANT]);
  });

  it('healthy mapped probe row: pings once, tools/list, ok', async () => {
    const { client, fetchSpy, brigade } = await setup({
      targetWorkspaceId: TENANT,
      conflictTenantId: null,
    });
    await expect(client.ping()).resolves.toMatchObject({ ok: true, status: 200, detail: 'ok' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as any[];
    expect(url).toBe('https://contacts.example.test/mcp');
    expect(JSON.parse(init.body).method).toBe('tools/list');
    expect(init.headers['X-Workspace-Id']).toBe(TENANT);
    expect(brigade.exchangedToken).toHaveBeenCalledTimes(1);
  });
});

import { ConfigService } from '@nestjs/config';
import { ContactOpsClient } from './contact-ops.client';
import { FederationContext } from './contact-ops.port';

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
    const client = new ContactOpsClient(makeConfig({}));

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

  describe('with CONTACT_OPS_BASE_URL set', () => {
    const env = {
      CONTACT_OPS_BASE_URL: 'https://contacts.example.test/',
      CONTACT_OPS_SERVICE_TOKEN: 'svc-token-xyz',
    };

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
      const client = new ContactOpsClient(makeConfig(env));

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
      const client = new ContactOpsClient(makeConfig(env));
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
      const client = new ContactOpsClient(makeConfig(env));

      const page = await client.listContacts(CTX, { hasEmail: true, tagsAny: ['vip'], limit: 10 });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.name).toBe('list_people');
      expect(body.params.arguments).toMatchObject({ has_email: true, tags_any: ['vip'], limit: 10 });
      expect(page.items[0]).toMatchObject({ contactId: 'p1', displayName: 'Alice', currentOrgName: 'Acme' });
      expect(page.nextCursor).toBe('cur2');
    });

    it('listContacts: uses search_people when a query is present', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse(rpcOk({ items: [], count: 0, next_cursor: null })),
      );
      global.fetch = fetchSpy as any;
      const client = new ContactOpsClient(makeConfig(env));

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
            rpcOk({ person_id: id, display_name: `Name ${id}`, kind: 'individual', status: 'active', emails: [], phones: [], recent_events: [] }),
          ),
        );
      });
      global.fetch = fetchSpy as any;
      const client = new ContactOpsClient(makeConfig(env));

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
      const client = new ContactOpsClient(makeConfig(env));

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
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }),
      ) as any;
      const client = new ContactOpsClient(makeConfig(env));
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
      const client = new ContactOpsClient(makeConfig(env));
      await expect(client.getContact(CTX, 'missing')).resolves.toBeNull();
    });

    it('returns null (never throws) on a transport error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      const client = new ContactOpsClient(makeConfig(env));
      await expect(client.getContact(CTX, 'p1')).resolves.toBeNull();
      await expect(client.listContacts(CTX, {})).resolves.toEqual({ items: [], count: 0, nextCursor: null });
    });

    it('returns empty page (never throws) on HTTP 500', async () => {
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({}, false, 500)) as any;
      const client = new ContactOpsClient(makeConfig(env));
      await expect(client.listContacts(CTX, {})).resolves.toEqual({ items: [], count: 0, nextCursor: null });
    });
  });
});

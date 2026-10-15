import { ConfigService } from '@nestjs/config';
import { ProjectOpsClient } from './project-ops.client';
import { FederationContext, ProjectLookup } from './project-ops.port';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';

/**
 * The federation workspace map (added with the per-workspace map in 0d09be3).
 * `resolveSync` returning null means "this workspace has no explicit mapping for
 * that app", and every client then falls back to ctx.workspaceId — i.e. exactly
 * the behaviour these specs were written against. Override per-test if a case
 * ever needs a real mapping.
 */
function makeFedMap(mapped: string | null = null) {
  return { resolveSync: jest.fn().mockReturnValue(mapped) } as any;
}


/**
 * The Project-Ops federation client speaks JSON-RPC 2.0 to the Project-Ops app's
 * `POST /mcp` read surface (its native `search_projects` tool). Project-Ops is
 * MOCKED here via a fake global.fetch — the app is never running. Mirrors the
 * Meeting-Ops client spec, but note the client parses `await res.text()` (it
 * accepts a plain-JSON OR an SSE-framed body), so the Response mock exposes a
 * `text()` method (not `json()`). These pin:
 *   - DEGRADE-CLEAN: unset PROJECT_OPS_BASE_URL → isConfigured() false, [] with
 *     NO fetch, never throws,
 *   - the configured happy path posts a JSON-RPC tools/call for search_projects
 *     (relationship ids preferred over org/contact name) + maps Project → FederatedProject,
 *   - a JSON-RPC error envelope / result.isError / a transport throw / an HTTP
 *     500 each return [] and NEVER throw (federation is best-effort).
 *
 * These tests exercise STATIC auth mode (PROJECT_OPS_SERVICE_TOKEN forwarded);
 * the Brigade source isn't reached (the brigade-sts path is proven live).
 */
const CTX: FederationContext = { workspaceId: 'ws-aaaa', ucUid: 'uc-uid-1', entitlements: [] };

function makeBrigade(): BrigadeTokenSource {
  return { exchangedToken: jest.fn().mockResolvedValue(null) } as unknown as BrigadeTokenSource;
}

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

/** A fetch Response whose body is read via res.text() — the client calls
 *  parseRpc(await res.text()), so we serialize the envelope here. */
function textResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
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

describe('ProjectOpsClient (Project-Ops MOCKED)', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  describe('when PROJECT_OPS_BASE_URL is unset (dormant)', () => {
    const client = new ProjectOpsClient(makeConfig({}), makeBrigade(), makeFedMap());
    const lookup: ProjectLookup = { orgName: 'Acme', contactName: 'Jane Lead' };

    it('isConfigured() is false', () => {
      expect(client.isConfigured()).toBe(false);
    });

    it('listProjectsForContact returns [] WITHOUT any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.listProjectsForContact(CTX, lookup)).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('ping() reports not-configured without a fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.ping()).resolves.toMatchObject({
        seam: 'project-ops',
        configured: false,
        ok: false,
        detail: 'not-configured',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('with PROJECT_OPS_BASE_URL set', () => {
    const env = {
      PROJECT_OPS_BASE_URL: 'https://projects.example.test/',
      PROJECT_OPS_SERVICE_TOKEN: 'svc-token-po',
    };

    it('isConfigured() is true', () => {
      expect(new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap()).isConfigured()).toBe(true);
    });

    it('happy path: posts JSON-RPC tools/call for search_projects and maps Project → FederatedProject', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(
        textResponse(
          rpcOk({
            projects: [
              {
                id: 'proj-1',
                projectNumber: 'P-00085',
                title: 'Acme website rebuild',
                status: 'IN_PROGRESS',
                priority: 'HIGH',
                dueDate: '2026-07-15',
                clientName: 'Acme Co',
                organization: { name: 'Acme' },
                assignedTo: { firstName: 'Sam', lastName: 'Dev', email: 'sam@x.test' },
              },
            ],
            count: 1,
          }),
        ),
      );
      global.fetch = fetchSpy as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const projects = await client.listProjectsForContact(CTX, {
        orgName: 'Acme',
        contactName: 'Jane Lead',
      });

      // The wire body is a JSON-RPC search_projects tools/call.
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://projects.example.test/mcp');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'search_projects', arguments: { query: 'Acme', limit: 25 } },
      });
      // Workspace forwarded as the wire address (header) + the service token.
      expect(init.headers['X-Workspace-Id']).toBe('ws-aaaa');
      expect(init.headers['Authorization']).toBe('Bearer svc-token-po');

      // The Project-Ops wire shape is mapped to the FederatedProject projection.
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({
        id: 'proj-1',
        matchedBy: 'name',
        projectNumber: 'P-00085',
        title: 'Acme website rebuild',
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        dueDate: '2026-07-15',
        clientName: 'Acme Co',
        organizationName: 'Acme',
        assignedTo: { displayName: 'Sam Dev', email: 'sam@x.test' },
      });
    });

    it('uses the Customer-Ops relationship id first and labels the result', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValueOnce(textResponse(rpcOk({ projects: [{ id: 'proj-customer', title: 'Exact customer match' }] })))
        .mockResolvedValueOnce(textResponse(rpcOk({ projects: [] })));
      global.fetch = fetchSpy as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const projects = await client.listProjectsForContact(CTX, {
        customerOpsCustomerId: 'customer-1',
        contactOpsContactId: 'contact-1',
        orgName: null,
        contactName: null,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchSpy.mock.calls[0][1].body).params.arguments).toEqual({
        customerOpsCustomerId: 'customer-1',
        limit: 25,
      });
      expect(projects).toMatchObject([{ id: 'proj-customer', matchedBy: 'customerOpsCustomerId' }]);
    });

    it('uses the Contact-Ops contact id when the customer id has no hit', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValueOnce(textResponse(rpcOk({ projects: [] })))
        .mockResolvedValueOnce(textResponse(rpcOk({ projects: [{ id: 'proj-contact', title: 'Exact contact match' }] })));
      global.fetch = fetchSpy as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const projects = await client.listProjectsForContact(CTX, {
        customerOpsCustomerId: 'customer-1',
        contactOpsContactId: 'contact-1',
        orgName: 'Acme',
        contactName: 'Jane Lead',
      });

      expect(JSON.parse(fetchSpy.mock.calls[1][1].body).params.arguments).toEqual({
        contactOpsContactId: 'contact-1',
        limit: 25,
      });
      expect(projects).toMatchObject([{ id: 'proj-contact', matchedBy: 'contactOpsContactId' }]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('falls back to the name query only when both id lookups are empty', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValueOnce(textResponse(rpcOk({ projects: [] })))
        .mockResolvedValueOnce(textResponse(rpcOk({ projects: [] })))
        .mockResolvedValueOnce(textResponse(rpcOk({ projects: [{ id: 'proj-name', title: 'Name match' }] })));
      global.fetch = fetchSpy as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const projects = await client.listProjectsForContact(CTX, {
        customerOpsCustomerId: 'customer-1',
        contactOpsContactId: 'contact-1',
        orgName: 'Acme',
        contactName: 'Jane Lead',
      });

      expect(JSON.parse(fetchSpy.mock.calls[2][1].body).params.arguments).toEqual({
        query: 'Acme',
        limit: 25,
      });
      expect(projects).toMatchObject([{ id: 'proj-name', matchedBy: 'name' }]);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('falls through to the name query when id lookups return errors', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValueOnce(textResponse({}, false, 503))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(textResponse(rpcOk({ projects: [{ id: 'proj-after-error' }] })));
      global.fetch = fetchSpy as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const projects = await client.listProjectsForContact(CTX, {
        customerOpsCustomerId: 'customer-1',
        contactOpsContactId: 'contact-1',
        orgName: 'Acme',
        contactName: 'Jane Lead',
      });

      expect(projects).toMatchObject([{ id: 'proj-after-error', matchedBy: 'name' }]);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('merges id hits and dedupes by project id, preserving the stronger match label', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValueOnce(
          textResponse(
            rpcOk({
              projects: [
                { id: 'proj-shared', title: 'Shared from customer id' },
                { id: 'proj-customer-only', title: 'Customer only' },
              ],
            }),
          ),
        )
        .mockResolvedValueOnce(
          textResponse(
            rpcOk({
              projects: [
                { id: 'proj-shared', title: 'Shared from contact id' },
                { id: 'proj-contact-only', title: 'Contact only' },
              ],
            }),
          ),
        );
      global.fetch = fetchSpy as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const projects = await client.listProjectsForContact(CTX, {
        customerOpsCustomerId: 'customer-1',
        contactOpsContactId: 'contact-1',
        orgName: 'Acme',
        contactName: 'Jane Lead',
      });

      expect(projects.map((project) => project.id)).toEqual([
        'proj-shared',
        'proj-customer-only',
        'proj-contact-only',
      ]);
      expect(projects.find((project) => project.id === 'proj-shared')?.matchedBy).toBe(
        'customerOpsCustomerId',
      );
      expect(projects.find((project) => project.id === 'proj-contact-only')?.matchedBy).toBe(
        'contactOpsContactId',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('prefers the org name over the contact name as the search query', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(textResponse(rpcOk({ projects: [] })));
      global.fetch = fetchSpy as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      await client.listProjectsForContact(CTX, { orgName: 'Acme Corp', contactName: 'Jane Lead' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.arguments.query).toBe('Acme Corp');
    });

    it('falls back to the contact name when there is no org name', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(textResponse(rpcOk({ projects: [] })));
      global.fetch = fetchSpy as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      await client.listProjectsForContact(CTX, { orgName: null, contactName: 'Jane Lead' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.arguments.query).toBe('Jane Lead');
    });

    it('no usable match key (org + contact both empty) → [] with NO fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      await expect(
        client.listProjectsForContact(CTX, { orgName: null, contactName: null }),
      ).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('drops a project row with no id (never fabricated)', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        textResponse(
          rpcOk({
            projects: [
              { id: 'proj-1', title: 'Has id' },
              { title: 'No id — dropped' },
            ],
          }),
        ),
      ) as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const projects = await client.listProjectsForContact(CTX, { orgName: 'Acme', contactName: null });
      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe('proj-1');
      // Missing optional fields get safe defaults, not undefined.
      expect(projects[0].title).toBe('Has id');
      expect(projects[0].status).toBe('NEW');
      expect(projects[0].organizationName).toBeNull();
      expect(projects[0].assignedTo).toBeNull();
    });

    it('returns [] (never throws) on a JSON-RPC error envelope', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        textResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }),
      ) as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());
      await expect(
        client.listProjectsForContact(CTX, { orgName: 'Acme', contactName: null }),
      ).resolves.toEqual([]);
    });

    it('returns [] (never throws) when the tool result is isError', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        textResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'ORG_NOT_FOUND' }] },
        }),
      ) as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());
      await expect(
        client.listProjectsForContact(CTX, { orgName: 'Acme', contactName: null }),
      ).resolves.toEqual([]);
    });

    it('returns [] (never throws) on a transport error (fetch rejects)', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());
      await expect(
        client.listProjectsForContact(CTX, { orgName: 'Acme', contactName: null }),
      ).resolves.toEqual([]);
    });

    it('returns [] (never throws) on an HTTP 500', async () => {
      global.fetch = jest.fn().mockResolvedValue(textResponse({}, false, 500)) as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());
      await expect(
        client.listProjectsForContact(CTX, { orgName: 'Acme', contactName: null }),
      ).resolves.toEqual([]);
    });

    it('returns [] (never throws) on an unparseable body', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'not json at all',
      } as unknown as Response) as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());
      await expect(
        client.listProjectsForContact(CTX, { orgName: 'Acme', contactName: null }),
      ).resolves.toEqual([]);
    });

    it('parses an SSE-framed JSON-RPC body (streamable-HTTP MCP transport)', async () => {
      // The client falls back to pulling the last `data:` line and parsing it.
      const sse =
        'event: message\n' +
        `data: ${JSON.stringify(rpcOk({ projects: [{ id: 'proj-sse', title: 'Via SSE' }] }))}\n\n`;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => sse,
      } as unknown as Response) as any;
      const client = new ProjectOpsClient(makeConfig(env), makeBrigade(), makeFedMap());

      const projects = await client.listProjectsForContact(CTX, { orgName: 'Acme', contactName: null });
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({ id: 'proj-sse', title: 'Via SSE' });
    });
  });
});

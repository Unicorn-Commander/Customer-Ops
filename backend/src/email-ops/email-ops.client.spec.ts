import { ConfigService } from '@nestjs/config';
import { EmailOpsClient } from './email-ops.client';
import { FederationContext } from './email-ops.port';
import { EmailComposeRequest } from './email-ops.types';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';

/** These tests exercise STATIC auth mode (EMAIL_OPS_SERVICE_TOKEN forwarded), so
 *  the Brigade source is never reached; a stub that returns null suffices. The
 *  brigade-sts path is proven live, not unit-mocked (mirrors Contact-Ops). */
function makeBrigade(): BrigadeTokenSource {
  return { exchangedToken: jest.fn().mockResolvedValue(null) } as unknown as BrigadeTokenSource;
}

/**
 * The Email-Ops federation client speaks JSON-RPC 2.0 to the (future) Email-Ops
 * app's `POST /mcp` (list_threads_with_contact / list_thread_messages /
 * compose_email). Email-Ops is MOCKED here via a fake global.fetch — the
 * Email-Ops app is not built yet. These pin the brief's requirements:
 *   - list_threads_with_contact / list_thread_messages mapping (threads,
 *     participants, message previews — bodies are previews, never full),
 *   - compose_email argument mapping (send vs draft mode, the deterministic
 *     external_ref/source, the contactId travelling as a thin reference) + the
 *     message-view → EmailComposeResult mapping,
 *   - IDEMPOTENCY on external_ref: the same (source, ref) drives the same tool
 *     args; Email-Ops returns the same message (no second send) — asserted via
 *     the stable ref on the wire and the stable mapped result,
 *   - the DUAL-SKU entitlement gate: PASS only with both customer-ops AND
 *     email-ops; DENY otherwise; OPEN bootstrap (UC_ENTITLEMENT_MODE=open)
 *     bypasses with a WARN; a denied compose makes NO fetch,
 *   - DEGRADE-CLEAN: unset EMAIL_OPS_BASE_URL → isConfigured()=false +
 *     empty/null, no fetch,
 *   - READS are viewer-level: list threads/messages do NOT require the dual SKU,
 *   - transport/HTTP/tool errors → empty/null, never throw (best-effort).
 */

const ENTITLED: FederationContext = {
  workspaceId: 'ws-aaaa',
  ucUid: 'uc-uid-1',
  entitlements: ['customer-ops', 'email-ops'],
};
const HALF_ENTITLED: FederationContext = {
  workspaceId: 'ws-aaaa',
  ucUid: 'uc-uid-1',
  entitlements: ['customer-ops'], // missing email-ops
};
const NOT_ENTITLED: FederationContext = {
  workspaceId: 'ws-aaaa',
  ucUid: 'uc-uid-1',
  entitlements: [],
};

const SEND: EmailComposeRequest = {
  contactId: 'contact-42',
  toAddress: 'jane@acme.test',
  subject: 'Following up',
  body: 'Hi Jane, just checking in on the proposal.',
  mode: 'send',
  externalSource: 'customer-ops',
  externalRef: 'cust:cust-1:email:idem-key-123',
};

const DRAFT: EmailComposeRequest = {
  ...SEND,
  mode: 'draft',
  inReplyToThreadId: 'thread-9',
  externalRef: 'cust:cust-1:email:idem-key-456',
};

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
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

/** A representative Email-Ops compose result (the app's wire shape). */
function composeView(over: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    thread_id: 'thread-1',
    status: 'queued',
    mode: 'send',
    external_source: 'customer-ops',
    external_ref: 'cust:cust-1:email:idem-key-123',
    created_at: '2026-06-03T00:00:00Z',
    ...over,
  };
}

const CONFIGURED_ENFORCE = {
  EMAIL_OPS_BASE_URL: 'https://mail.example.test/',
  EMAIL_OPS_SERVICE_TOKEN: 'svc-token-mail',
  UC_ENTITLEMENT_MODE: 'enforce',
};

describe('EmailOpsClient (Email-Ops app MOCKED)', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  describe('degrade-clean: EMAIL_OPS_BASE_URL unset (dormant)', () => {
    const client = new EmailOpsClient(makeConfig({}), makeBrigade());

    it('isConfigured() is false', () => {
      expect(client.isConfigured()).toBe(false);
    });

    it('listThreadsWithContact / listThreadMessages return [] WITHOUT any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.listThreadsWithContact(ENTITLED, 'contact-42')).resolves.toEqual([]);
      await expect(client.listThreadMessages(ENTITLED, 'thread-1')).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('composeEmail returns null WITHOUT any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.composeEmail(ENTITLED, SEND)).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('dual-SKU entitlement gate', () => {
    it('PASS only when BOTH customer-ops AND email-ops are present (enforce)', () => {
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade());
      expect(client.checkEntitlement(ENTITLED)).toMatchObject({ allowed: true, mode: 'enforce' });
    });

    it('DENY when email-ops is missing (enforce)', () => {
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade());
      const deny = client.checkEntitlement(HALF_ENTITLED);
      expect(deny.allowed).toBe(false);
      expect(deny.mode).toBe('enforce');
    });

    it('DENY when no entitlements at all (enforce)', () => {
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade());
      expect(client.checkEntitlement(NOT_ENTITLED).allowed).toBe(false);
    });

    it('a denied composeEmail makes NO fetch (defense-in-depth)', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade());
      await expect(client.composeEmail(HALF_ENTITLED, SEND)).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('OPEN bootstrap (UC_ENTITLEMENT_MODE=open) bypasses the dual-SKU check', () => {
      const client = new EmailOpsClient(
        makeConfig({ ...CONFIGURED_ENFORCE, UC_ENTITLEMENT_MODE: 'open' }),
        makeBrigade(),
      );
      expect(client.checkEntitlement(NOT_ENTITLED)).toMatchObject({ allowed: true, mode: 'open' });
    });

    it('falls back to EMAIL_OPS_CROSS_APP_ENTITLEMENT_MODE when UC_ENTITLEMENT_MODE is unset', () => {
      const client = new EmailOpsClient(
        makeConfig({
          EMAIL_OPS_BASE_URL: 'https://mail.example.test',
          EMAIL_OPS_CROSS_APP_ENTITLEMENT_MODE: 'open',
        }),
        makeBrigade(),
      );
      expect(client.checkEntitlement(NOT_ENTITLED)).toMatchObject({ allowed: true, mode: 'open' });
    });

    it('accepts SKU aliases (e.g. email_ops / mail) on read', () => {
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade());
      const aliased: FederationContext = {
        workspaceId: 'ws-aaaa',
        ucUid: 'u',
        entitlements: ['customerops', 'mail'],
      };
      expect(client.checkEntitlement(aliased).allowed).toBe(true);
    });
  });

  describe('reads (viewer-level)', () => {
    it('listThreadsWithContact posts the tool and maps threads + participants', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse(
          rpcOk({
            threads: [
              {
                id: 'thread-1',
                subject: 'Proposal',
                message_count: 3,
                unread: true,
                last_message_at: '2026-06-02T10:00:00Z',
                last_snippet: 'Looks good, a couple questions…',
                participants: [
                  { address: 'jane@acme.test', name: 'Jane Lead' },
                  { address: 'me@magicunicorn.tech', name: null },
                ],
              },
            ],
          }),
        ),
      );
      global.fetch = fetchSpy as any;
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade());

      const threads = await client.listThreadsWithContact(ENTITLED, 'contact-42');
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://mail.example.test/mcp');
      const body = JSON.parse(init.body);
      expect(body.params.name).toBe('list_threads_with_contact');
      expect(body.params.arguments).toEqual({ workspace_id: 'ws-aaaa', contact_id: 'contact-42' });
      expect(init.headers['X-Workspace-Id']).toBe('ws-aaaa');
      expect(init.headers['Authorization']).toBe('Bearer svc-token-mail');

      expect(threads[0]).toMatchObject({
        id: 'thread-1',
        subject: 'Proposal',
        messageCount: 3,
        unread: true,
        lastSnippet: 'Looks good, a couple questions…',
      });
      expect(threads[0].participants).toEqual([
        { address: 'jane@acme.test', name: 'Jane Lead' },
        { address: 'me@magicunicorn.tech', name: null },
      ]);
    });

    it('listThreadsWithContact does NOT require the dual SKU (viewer-level)', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk({ threads: [] })));
      global.fetch = fetchSpy as any;
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade());
      await client.listThreadsWithContact(NOT_ENTITLED, 'contact-42');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('listThreadMessages maps message previews + direction', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse(
          rpcOk({
            messages: [
              {
                id: 'msg-1',
                thread_id: 'thread-1',
                from: { address: 'jane@acme.test', name: 'Jane Lead' },
                to: [{ address: 'me@magicunicorn.tech', name: null }],
                subject: 'Proposal',
                sent_at: '2026-06-02T10:00:00Z',
                preview: 'Looks good, a couple questions…',
                direction: 'received',
              },
            ],
          }),
        ),
      );
      global.fetch = fetchSpy as any;
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade());

      const messages = await client.listThreadMessages(ENTITLED, 'thread-1');
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.name).toBe('list_thread_messages');
      expect(body.params.arguments).toEqual({ workspace_id: 'ws-aaaa', thread_id: 'thread-1' });
      expect(messages[0]).toMatchObject({
        id: 'msg-1',
        threadId: 'thread-1',
        subject: 'Proposal',
        preview: 'Looks good, a couple questions…',
        direction: 'received',
      });
      expect(messages[0].from).toEqual({ address: 'jane@acme.test', name: 'Jane Lead' });
    });

    it('reads return [] (never throw) on a transport error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade());
      await expect(client.listThreadsWithContact(ENTITLED, 'c')).resolves.toEqual([]);
      await expect(client.listThreadMessages(ENTITLED, 't')).resolves.toEqual([]);
    });
  });

  describe('composeEmail (entitled, configured)', () => {
    it('SEND: posts compose_email with mode=send + the mapped args (deterministic ref)', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk(composeView())));
      global.fetch = fetchSpy as any;
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade());

      const result = await client.composeEmail(ENTITLED, SEND);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.name).toBe('compose_email');
      const args = body.params.arguments;
      expect(args.workspace_id).toBe('ws-aaaa');
      // contactId travels as a thin reference (contact_id), never a copy.
      expect(args.contact_id).toBe('contact-42');
      expect(args.to_address).toBe('jane@acme.test');
      expect(args.subject).toBe('Following up');
      expect(args.mode).toBe('send');
      expect(args.external_source).toBe('customer-ops');
      expect(args.external_ref).toBe('cust:cust-1:email:idem-key-123');
      // No reply thread on this one.
      expect(args.in_reply_to_thread_id).toBeUndefined();

      expect(result).toMatchObject({
        id: 'msg-1',
        threadId: 'thread-1',
        status: 'queued',
        mode: 'send',
        externalRef: 'cust:cust-1:email:idem-key-123',
      });
    });

    it('DRAFT: posts mode=draft + the reply thread; maps a pending_approval result', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(
          jsonResponse(rpcOk(composeView({ id: 'msg-2', status: 'pending_approval', mode: 'draft', external_ref: 'cust:cust-1:email:idem-key-456' }))),
        );
      global.fetch = fetchSpy as any;
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade());

      const result = await client.composeEmail(ENTITLED, DRAFT);
      const args = JSON.parse(fetchSpy.mock.calls[0][1].body).params.arguments;
      expect(args.mode).toBe('draft');
      expect(args.in_reply_to_thread_id).toBe('thread-9');
      expect(result).toMatchObject({ id: 'msg-2', status: 'pending_approval', mode: 'draft' });
    });

    it('IDEMPOTENT on external_ref: the same send yields the same message view', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk(composeView())));
      global.fetch = fetchSpy as any;
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade());

      const first = await client.composeEmail(ENTITLED, SEND);
      const second = await client.composeEmail(ENTITLED, SEND);
      const ref1 = JSON.parse(fetchSpy.mock.calls[0][1].body).params.arguments.external_ref;
      const ref2 = JSON.parse(fetchSpy.mock.calls[1][1].body).params.arguments.external_ref;
      expect(ref1).toBe('cust:cust-1:email:idem-key-123');
      expect(ref2).toBe(ref1);
      expect(first?.id).toBe('msg-1');
      expect(second).toEqual(first); // same message back (no second send)
    });

    it('returns null (never throws) on a transport error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade());
      await expect(client.composeEmail(ENTITLED, SEND)).resolves.toBeNull();
    });

    it('returns null when the tool result is isError', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'mailbox not found' }] },
        }),
      ) as any;
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade());
      await expect(client.composeEmail(ENTITLED, SEND)).resolves.toBeNull();
    });
  });

  describe('auth mode (EMAIL_OPS_AUTH_MODE)', () => {
    it('STATIC (default / unset): forwards EMAIL_OPS_SERVICE_TOKEN, never touches Brigade', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk({ threads: [] })));
      global.fetch = fetchSpy as any;
      const brigade = makeBrigade();
      const client = new EmailOpsClient(makeConfig(CONFIGURED_ENFORCE), brigade);

      await client.listThreadsWithContact(ENTITLED, 'contact-42');

      expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBe('Bearer svc-token-mail');
      expect(brigade.exchangedToken).not.toHaveBeenCalled();
    });

    it('BRIGADE-STS: mints aud=email-ops + forwards the exchanged bearer (not the static token)', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk({ threads: [] })));
      global.fetch = fetchSpy as any;
      const brigade = {
        exchangedToken: jest.fn().mockResolvedValue('brigade-minted-mail'),
      } as unknown as BrigadeTokenSource;
      const client = new EmailOpsClient(
        makeConfig({ ...CONFIGURED_ENFORCE, EMAIL_OPS_AUTH_MODE: 'brigade-sts' }),
        brigade,
      );

      await client.listThreadsWithContact(ENTITLED, 'contact-42');

      expect(brigade.exchangedToken).toHaveBeenCalledWith({
        audience: 'email-ops',
        scope: 'mail:read mail:send',
        workspaceId: 'ws-aaaa',
      });
      expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBe('Bearer brigade-minted-mail');
    });

    it('BRIGADE-STS honors EMAIL_OPS_AUDIENCE override + degrades clean (no bearer) when the exchange fails', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk({ threads: [] })));
      global.fetch = fetchSpy as any;
      const brigade = makeBrigade(); // exchangedToken → null (exchange failed)
      const client = new EmailOpsClient(
        makeConfig({
          ...CONFIGURED_ENFORCE,
          EMAIL_OPS_AUTH_MODE: 'brigade-sts',
          EMAIL_OPS_AUDIENCE: 'email-ops-prod',
        }),
        brigade,
      );

      await client.listThreadsWithContact(ENTITLED, 'contact-42');

      expect(brigade.exchangedToken).toHaveBeenCalledWith(
        expect.objectContaining({ audience: 'email-ops-prod' }),
      );
      // Exchange failed → no Authorization header, but the call still went out.
      expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBeUndefined();
      expect(fetchSpy.mock.calls[0][1].headers['X-Workspace-Id']).toBe('ws-aaaa');
    });
  });
});

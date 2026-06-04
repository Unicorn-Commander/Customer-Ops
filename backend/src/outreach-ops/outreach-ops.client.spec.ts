import { ConfigService } from '@nestjs/config';
import { OutreachClient } from './outreach-ops.client';
import { FederationContext } from './outreach-ops.port';
import { CampaignEnrollment, SocialTouchRequest } from './outreach-ops.types';

/**
 * The Outreach federation client speaks JSON-RPC 2.0 to the (future) Outreach
 * app's `POST /mcp` (list_campaigns / list_touches_for_contact / enroll_contact /
 * schedule_social_touch). Outreach is MOCKED here via a fake global.fetch — the
 * Outreach app is not built yet. These pin the brief's requirements:
 *   - list_campaigns / list_touches_for_contact mapping (snake→camel, channels),
 *   - enroll_contact / schedule_social_touch argument mapping (the deterministic
 *     external_ref/source, the contactId travelling as a thin reference) + the
 *     enrollment-view → OutreachEnrollmentResult mapping,
 *   - IDEMPOTENCY on external_ref: the same (source, ref) drives the same tool
 *     args; Outreach returns the same enrollment (no second send) — we assert the
 *     wire carries the stable ref and the mapped result is stable,
 *   - the DUAL-SKU entitlement gate: PASS only with both customer-ops AND
 *     outreach; DENY otherwise; OPEN bootstrap (UC_ENTITLEMENT_MODE=open)
 *     bypasses with a WARN; a denied trigger makes NO fetch,
 *   - DEGRADE-CLEAN: unset OUTREACH_BASE_URL → isConfigured()=false + empty/null,
 *     no fetch,
 *   - READS are viewer-level: list_campaigns / list_touches do NOT require the
 *     dual SKU,
 *   - transport/HTTP/tool errors → empty/null, never throw (best-effort).
 */

const ENTITLED: FederationContext = {
  workspaceId: 'ws-aaaa',
  ucUid: 'uc-uid-1',
  entitlements: ['customer-ops', 'outreach'],
};
const HALF_ENTITLED: FederationContext = {
  workspaceId: 'ws-aaaa',
  ucUid: 'uc-uid-1',
  entitlements: ['customer-ops'], // missing outreach
};
const NOT_ENTITLED: FederationContext = {
  workspaceId: 'ws-aaaa',
  ucUid: 'uc-uid-1',
  entitlements: [],
};

const ENROLLMENT: CampaignEnrollment = {
  campaignId: 'camp-1',
  contactId: 'contact-42',
  contactEmail: 'jane@acme.test',
  externalSource: 'customer-ops',
  externalRef: 'cust:cust-1:enroll:idem-key-123',
  mergeFields: { firstName: 'Jane' },
};

const SOCIAL: SocialTouchRequest = {
  channelId: 'postiz-li-1',
  contactId: 'contact-42',
  body: 'Great connecting, Jane!',
  scheduledAt: '2026-07-01T15:00:00Z',
  externalSource: 'customer-ops',
  externalRef: 'cust:cust-1:social:idem-key-999',
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

/** A representative Outreach enrollment view (the app's wire shape). */
function enrollmentView(over: Record<string, unknown> = {}) {
  return {
    id: 'enr-1',
    channel: 'email',
    campaign_id: 'camp-1',
    campaign_name: 'June Nurture',
    status: 'queued',
    external_source: 'customer-ops',
    external_ref: 'cust:cust-1:enroll:idem-key-123',
    created_at: '2026-06-03T00:00:00Z',
    ...over,
  };
}

const CONFIGURED_ENFORCE = {
  OUTREACH_BASE_URL: 'https://outreach.example.test/',
  OUTREACH_SERVICE_TOKEN: 'svc-token-outreach',
  UC_ENTITLEMENT_MODE: 'enforce',
};

describe('OutreachClient (Outreach app MOCKED)', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  describe('degrade-clean: OUTREACH_BASE_URL unset (dormant)', () => {
    const client = new OutreachClient(makeConfig({}));

    it('isConfigured() is false', () => {
      expect(client.isConfigured()).toBe(false);
    });

    it('listCampaigns / listTouchesForContact return [] WITHOUT any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.listCampaigns(ENTITLED)).resolves.toEqual([]);
      await expect(client.listTouchesForContact(ENTITLED, 'contact-42')).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('enrollContact / scheduleSocialTouch return null WITHOUT any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.enrollContact(ENTITLED, ENROLLMENT)).resolves.toBeNull();
      await expect(client.scheduleSocialTouch(ENTITLED, SOCIAL)).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('dual-SKU entitlement gate', () => {
    it('PASS only when BOTH customer-ops AND outreach are present (enforce)', () => {
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));
      expect(client.checkEntitlement(ENTITLED)).toMatchObject({ allowed: true, mode: 'enforce' });
    });

    it('DENY when outreach is missing (enforce)', () => {
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));
      const deny = client.checkEntitlement(HALF_ENTITLED);
      expect(deny.allowed).toBe(false);
      expect(deny.mode).toBe('enforce');
    });

    it('DENY when no entitlements at all (enforce)', () => {
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));
      expect(client.checkEntitlement(NOT_ENTITLED).allowed).toBe(false);
    });

    it('a denied enrollContact makes NO fetch (defense-in-depth)', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));
      await expect(client.enrollContact(HALF_ENTITLED, ENROLLMENT)).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a denied scheduleSocialTouch makes NO fetch (defense-in-depth)', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));
      await expect(client.scheduleSocialTouch(NOT_ENTITLED, SOCIAL)).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('OPEN bootstrap (UC_ENTITLEMENT_MODE=open) bypasses the dual-SKU check', () => {
      const client = new OutreachClient(
        makeConfig({ ...CONFIGURED_ENFORCE, UC_ENTITLEMENT_MODE: 'open' }),
      );
      expect(client.checkEntitlement(NOT_ENTITLED)).toMatchObject({ allowed: true, mode: 'open' });
    });

    it('falls back to OUTREACH_CROSS_APP_ENTITLEMENT_MODE when UC_ENTITLEMENT_MODE is unset', () => {
      const client = new OutreachClient(
        makeConfig({
          OUTREACH_BASE_URL: 'https://outreach.example.test',
          OUTREACH_CROSS_APP_ENTITLEMENT_MODE: 'open',
        }),
      );
      expect(client.checkEntitlement(NOT_ENTITLED)).toMatchObject({ allowed: true, mode: 'open' });
    });

    it('accepts SKU aliases (e.g. outreach_ops) on read', () => {
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));
      const aliased: FederationContext = {
        workspaceId: 'ws-aaaa',
        ucUid: 'u',
        entitlements: ['customer_ops', 'outreach_ops'],
      };
      expect(client.checkEntitlement(aliased).allowed).toBe(true);
    });
  });

  describe('reads (viewer-level)', () => {
    it('listCampaigns posts list_campaigns and maps the campaign views', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse(
          rpcOk({
            campaigns: [
              {
                id: 'camp-1',
                name: 'June Nurture',
                channel: 'email',
                status: 'running',
                is_sequence: true,
                list_id: 'lm-list-7',
                created_at: '2026-06-01T00:00:00Z',
              },
              { id: 'camp-2', name: 'LI Touch', channel: 'social', status: 'draft' },
            ],
          }),
        ),
      );
      global.fetch = fetchSpy as any;
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));

      const campaigns = await client.listCampaigns(ENTITLED);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://outreach.example.test/mcp');
      const body = JSON.parse(init.body);
      expect(body.params.name).toBe('list_campaigns');
      expect(body.params.arguments).toEqual({ workspace_id: 'ws-aaaa' });
      expect(init.headers['X-Workspace-Id']).toBe('ws-aaaa');
      expect(init.headers['Authorization']).toBe('Bearer svc-token-outreach');

      expect(campaigns).toHaveLength(2);
      expect(campaigns[0]).toMatchObject({
        id: 'camp-1',
        name: 'June Nurture',
        channel: 'email',
        status: 'running',
        isSequence: true,
        listId: 'lm-list-7',
      });
      expect(campaigns[1]).toMatchObject({ id: 'camp-2', channel: 'social', isSequence: false });
    });

    it('listCampaigns does NOT require the dual SKU (viewer-level)', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk({ campaigns: [] })));
      global.fetch = fetchSpy as any;
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));
      await client.listCampaigns(NOT_ENTITLED);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('listTouchesForContact polls by contact_id and maps engagement signal', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse(
          rpcOk({
            touches: [
              {
                id: 'touch-1',
                channel: 'email',
                campaign_id: 'camp-1',
                campaign_name: 'June Nurture',
                status: 'clicked',
                subject: 'Welcome to the pipeline',
                sent_at: '2026-06-02T10:00:00Z',
                last_engagement_kind: 'clicked',
                last_engagement_at: '2026-06-02T11:00:00Z',
              },
            ],
          }),
        ),
      );
      global.fetch = fetchSpy as any;
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));

      const touches = await client.listTouchesForContact(ENTITLED, 'contact-42');
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.name).toBe('list_touches_for_contact');
      expect(body.params.arguments).toEqual({ workspace_id: 'ws-aaaa', contact_id: 'contact-42' });
      expect(touches[0]).toMatchObject({
        id: 'touch-1',
        status: 'clicked',
        lastEngagementKind: 'clicked',
        campaignName: 'June Nurture',
      });
    });

    it('reads return [] (never throw) on a transport error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));
      await expect(client.listCampaigns(ENTITLED)).resolves.toEqual([]);
      await expect(client.listTouchesForContact(ENTITLED, 'c')).resolves.toEqual([]);
    });
  });

  describe('enrollContact (entitled, configured)', () => {
    it('posts enroll_contact with the mapped args (deterministic ref) and maps the view', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk(enrollmentView())));
      global.fetch = fetchSpy as any;
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));

      const result = await client.enrollContact(ENTITLED, ENROLLMENT);

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://outreach.example.test/mcp');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'enroll_contact' },
      });
      const args = body.params.arguments;
      expect(args.workspace_id).toBe('ws-aaaa');
      expect(args.campaign_id).toBe('camp-1');
      // contactId travels as a thin reference (contact_id), never a copy.
      expect(args.contact_id).toBe('contact-42');
      expect(args.contact_email).toBe('jane@acme.test');
      expect(args.external_source).toBe('customer-ops');
      expect(args.external_ref).toBe('cust:cust-1:enroll:idem-key-123');
      expect(args.merge_fields).toEqual({ firstName: 'Jane' });

      expect(result).toMatchObject({
        id: 'enr-1',
        channel: 'email',
        status: 'queued',
        externalRef: 'cust:cust-1:enroll:idem-key-123',
      });
    });

    it('IDEMPOTENT on external_ref: the same enrollment yields the same enrollment view', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk(enrollmentView())));
      global.fetch = fetchSpy as any;
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));

      const first = await client.enrollContact(ENTITLED, ENROLLMENT);
      const second = await client.enrollContact(ENTITLED, ENROLLMENT);

      const ref1 = JSON.parse(fetchSpy.mock.calls[0][1].body).params.arguments.external_ref;
      const ref2 = JSON.parse(fetchSpy.mock.calls[1][1].body).params.arguments.external_ref;
      expect(ref1).toBe('cust:cust-1:enroll:idem-key-123');
      expect(ref2).toBe(ref1); // same idempotency key on the wire
      expect(first?.id).toBe('enr-1');
      expect(second).toEqual(first); // same enrollment back (no second send)
    });

    it('returns null (never throws) on a transport error — link persists upstream', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));
      await expect(client.enrollContact(ENTITLED, ENROLLMENT)).resolves.toBeNull();
    });

    it('returns null on a JSON-RPC error envelope', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'denied' } }),
        ) as any;
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));
      await expect(client.enrollContact(ENTITLED, ENROLLMENT)).resolves.toBeNull();
    });

    it('returns null when the tool result is isError', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'campaign not found' }] },
        }),
      ) as any;
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));
      await expect(client.enrollContact(ENTITLED, ENROLLMENT)).resolves.toBeNull();
    });
  });

  describe('scheduleSocialTouch (entitled, configured)', () => {
    it('posts schedule_social_touch with the mapped args and maps the view', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(jsonResponse(rpcOk(enrollmentView({ id: 'enr-2', channel: 'social', campaign_id: null }))));
      global.fetch = fetchSpy as any;
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));

      const result = await client.scheduleSocialTouch(ENTITLED, SOCIAL);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.name).toBe('schedule_social_touch');
      expect(body.params.arguments).toEqual({
        workspace_id: 'ws-aaaa',
        channel_id: 'postiz-li-1',
        contact_id: 'contact-42',
        body: 'Great connecting, Jane!',
        scheduled_at: '2026-07-01T15:00:00Z',
        external_source: 'customer-ops',
        external_ref: 'cust:cust-1:social:idem-key-999',
      });
      expect(result).toMatchObject({ id: 'enr-2', channel: 'social' });
    });

    it('returns null on HTTP 500 (never throws)', async () => {
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({}, false, 500)) as any;
      const client = new OutreachClient(makeConfig(CONFIGURED_ENFORCE));
      await expect(client.scheduleSocialTouch(ENTITLED, SOCIAL)).resolves.toBeNull();
    });
  });
});

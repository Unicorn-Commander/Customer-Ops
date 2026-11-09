import { ConfigService } from '@nestjs/config';
import { AgentInferenceClient } from './agent-inference.client';
import { InferenceContext } from './agent-inference.port';
import {
  ORG_GATEWAY_KEY_CACHE_MAX_MS,
  OpsCenterOrgGatewayKeyProvider,
} from './org-gateway-key.provider';

/**
 * The Agent-Inference client posts an OpenAI-shaped chat-completions request to
 * the ops-center gateway (uchub-litellm) and lets it pick the lane + meter. The
 * gateway is MOCKED here via a fake global.fetch. These pin:
 *   - the entitlement gate: customer-ops for bundled (lanes 1-2); ai-metered also
 *     required for metered (lanes 3-4); a metered ask without ai-metered is
 *     DOWNGRADED to bundled (not failed),
 *   - the request shape (lane-alias model, metering metadata, json response_format),
 *   - the response mapping (text + lane/model/usage/metered echo),
 *   - DEGRADE-CLEAN: unset base url → null, no fetch, no throw,
 *   - the open bootstrap (UC_ENTITLEMENT_MODE=open) bypasses the SKU check,
 *   - transport/HTTP/parse failures → null, never throw.
 */
function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}
function ctx(entitlements: string[]): InferenceContext {
  return { workspaceId: 'ws-aaaa', ucUid: 'uc-uid-1', entitlements };
}

describe('AgentInferenceClient (gateway MOCKED)', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  describe('checkEntitlement (pure gate)', () => {
    const client = new AgentInferenceClient(
      makeConfig({ AGENT_INFERENCE_BASE_URL: 'https://g.test' }),
    );

    it('allows bundled with customer-ops', () => {
      const d = client.checkEntitlement(ctx(['customer-ops']), 'bundled');
      expect(d).toMatchObject({ allowed: true, tierAllowed: 'bundled', mode: 'enforce' });
    });

    it('DENIES everything without customer-ops (strict)', () => {
      const d = client.checkEntitlement(ctx([]), 'bundled');
      expect(d.allowed).toBe(false);
    });

    it('allows metered only with ai-metered; otherwise DOWNGRADES to bundled', () => {
      const full = client.checkEntitlement(ctx(['customer-ops', 'ai-metered']), 'metered');
      expect(full).toMatchObject({ allowed: true, tierAllowed: 'metered' });

      const downgraded = client.checkEntitlement(ctx(['customer-ops']), 'metered');
      // Allowed, but only at the bundled tier (not a hard failure).
      expect(downgraded).toMatchObject({ allowed: true, tierAllowed: 'bundled' });
      expect(downgraded.reason).toMatch(/bundled/i);
    });

    it('open bootstrap bypasses the SKU check', () => {
      const open = new AgentInferenceClient(
        makeConfig({ AGENT_INFERENCE_BASE_URL: 'https://g.test', UC_ENTITLEMENT_MODE: 'open' }),
      );
      const d = open.checkEntitlement(ctx([]), 'metered');
      expect(d).toMatchObject({ allowed: true, tierAllowed: 'metered', mode: 'open' });
    });
  });

  describe('when AGENT_INFERENCE_BASE_URL is unset (dormant)', () => {
    const client = new AgentInferenceClient(makeConfig({}));
    it('isConfigured() is false and complete() returns null without any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      expect(client.isConfigured()).toBe(false);
      const out = await client.complete(ctx(['customer-ops']), {
        task: 'lead-triage',
        tier: 'bundled',
        messages: [{ role: 'user', content: 'hi' }],
        responseFormat: 'json',
      });
      expect(out).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('complete() with the gateway configured', () => {
    const env = {
      AGENT_INFERENCE_BASE_URL: 'https://gateway.example.test/',
      AGENT_INFERENCE_SERVICE_TOKEN: 'svc-ai',
    };

    it('posts an OpenAI-shaped request with the lane alias + metering metadata + json format', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: '{"score":80}' } }],
          model: 'qwen3-27b',
          usage: { prompt_tokens: 120, completion_tokens: 40 },
          x_uc_lane: 2,
          x_uc_metered: false,
        }),
      );
      global.fetch = fetchSpy as any;
      const client = new AgentInferenceClient(makeConfig(env));

      const out = await client.complete(ctx(['customer-ops']), {
        task: 'lead-triage',
        tier: 'bundled',
        messages: [
          { role: 'system', content: 'You are a triage agent.' },
          { role: 'user', content: 'score this lead' },
        ],
        responseFormat: 'json',
        maxOutputTokens: 512,
      });

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://gateway.example.test/v1/chat/completions');
      expect(init.method).toBe('POST');
      expect(init.headers['Authorization']).toBe('Bearer svc-ai');
      expect(init.headers['X-Workspace-Id']).toBe('ws-aaaa');
      const body = JSON.parse(init.body);
      // Lane alias (not a concrete model) for the bundled tier.
      expect(body.model).toBe('uc-bundled');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.max_tokens).toBe(512);
      // Metering dimensions ops-center keys on.
      expect(body.metadata).toMatchObject({
        workspace_id: 'ws-aaaa',
        task: 'lead-triage',
        tier: 'bundled',
      });

      // Response mapping.
      expect(out).toMatchObject({
        text: '{"score":80}',
        lane: 2,
        model: 'qwen3-27b',
        metered: false,
        promptTokens: 120,
        completionTokens: 40,
      });
    });

    it('a metered request WITHOUT ai-metered is downgraded to the bundled alias', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(
          jsonResponse({ choices: [{ message: { content: 'draft text' } }], model: 'local-27b' }),
        );
      global.fetch = fetchSpy as any;
      const client = new AgentInferenceClient(makeConfig(env));

      await client.complete(ctx(['customer-ops']), {
        task: 'follow-up-draft',
        tier: 'metered',
        messages: [{ role: 'user', content: 'draft a follow-up' }],
        responseFormat: 'text',
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      // Downgraded: bundled alias + tier even though 'metered' was requested.
      expect(body.model).toBe('uc-bundled');
      expect(body.metadata.tier).toBe('bundled');
    });

    it('a metered request WITH ai-metered uses the metered alias', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: 'x' } }],
          model: 'claude',
          x_uc_metered: true,
          x_uc_lane: 4,
        }),
      );
      global.fetch = fetchSpy as any;
      const client = new AgentInferenceClient(makeConfig(env));

      const out = await client.complete(ctx(['customer-ops', 'ai-metered']), {
        task: 'follow-up-draft',
        tier: 'metered',
        messages: [{ role: 'user', content: 'draft' }],
        responseFormat: 'text',
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('uc-metered');
      expect(out?.metered).toBe(true);
      expect(out?.lane).toBe(4);
    });

    it('DENIES (returns null, no fetch) when the bearer lacks customer-ops (strict)', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      const client = new AgentInferenceClient(makeConfig(env));
      const out = await client.complete(ctx([]), {
        task: 'lead-triage',
        tier: 'bundled',
        messages: [{ role: 'user', content: 'x' }],
        responseFormat: 'json',
      });
      expect(out).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null (never throws) on transport / HTTP / non-JSON / empty-content', async () => {
      const client = new AgentInferenceClient(makeConfig(env));

      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      await expect(
        client.complete(ctx(['customer-ops']), {
          task: 'lead-triage',
          tier: 'bundled',
          messages: [{ role: 'user', content: 'x' }],
          responseFormat: 'json',
        }),
      ).resolves.toBeNull();

      global.fetch = jest.fn().mockResolvedValue(jsonResponse({}, false, 502)) as any;
      await expect(
        client.complete(ctx(['customer-ops']), {
          task: 'lead-triage',
          tier: 'bundled',
          messages: [{ role: 'user', content: 'x' }],
          responseFormat: 'json',
        }),
      ).resolves.toBeNull();

      global.fetch = jest.fn().mockResolvedValue(jsonResponse({ choices: [] })) as any;
      await expect(
        client.complete(ctx(['customer-ops']), {
          task: 'lead-triage',
          tier: 'bundled',
          messages: [{ role: 'user', content: 'x' }],
          responseFormat: 'json',
        }),
      ).resolves.toBeNull();
    });
  });

  describe('complete() with CUSTOMER_OPS_USE_ORG_ROUTE enabled', () => {
    const orgEnv = {
      CUSTOMER_OPS_USE_ORG_ROUTE: 'true',
      ORG_GATEWAY_BASE_URL: 'https://org-gateway.example.test/',
      AGENT_INFERENCE_BASE_URL: 'https://legacy-instance.example.test/',
      AGENT_INFERENCE_SERVICE_TOKEN: 'legacy-service-token',
      UC_ENTITLEMENT_MODE: 'enforce',
    };

    it('uses the org key, bare concierge route, four UC headers, and never calls the old host', async () => {
      const keyProvider = {
        getKey: jest.fn().mockResolvedValue({
          key: 'org-key-for-tests',
          expiresAt: Date.now() + 60_000,
        }),
      };
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: 'org response' } }],
          model: 'gateway-target',
        }),
      );
      global.fetch = fetchSpy as any;
      const client = new AgentInferenceClient(makeConfig(orgEnv), keyProvider);

      const out = await client.complete(ctx(['customer-ops']), {
        task: 'lead-triage',
        tier: 'bundled',
        messages: [{ role: 'user', content: 'score this lead' }],
        responseFormat: 'json',
      });

      expect(keyProvider.getKey).toHaveBeenCalledWith('ws-aaaa');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://org-gateway.example.test/v1/chat/completions');
      expect(init.headers['Authorization']).toBe('Bearer org-key-for-tests');
      expect(init.headers['X-UC-Org-Id']).toBe('ws-aaaa');
      expect(init.headers['X-UC-App']).toBe('customer-ops');
      expect(init.headers['X-UC-Feature']).toBe('lead-triage');
      expect(init.headers['X-UC-User-Id']).toBe('uc-uid-1');
      expect(init.headers['X-Workspace-Id']).toBe('ws-aaaa');
      expect(url).not.toContain('legacy-instance.example.test');

      const body = JSON.parse(init.body);
      expect(body.model).toBe('concierge');
      expect(body.metadata).toBeUndefined();
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(out).toMatchObject({ text: 'org response', model: 'gateway-target' });
    });

    it('uses the bare batch route for an explicitly marked bulk path', async () => {
      const keyProvider = {
        getKey: jest.fn().mockResolvedValue({
          key: 'org-key-for-bulk-tests',
          expiresAt: Date.now() + 60_000,
        }),
      };
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'batch response' } }] }));
      global.fetch = fetchSpy as any;
      const client = new AgentInferenceClient(makeConfig(orgEnv), keyProvider);

      await client.complete(ctx(['customer-ops']), {
        task: 'lead-triage',
        tier: 'bundled',
        bulk: true,
        messages: [{ role: 'user', content: 'score this batch' }],
        responseFormat: 'text',
      });

      expect(JSON.parse(fetchSpy.mock.calls[0][1].body).model).toBe('batch');
    });

    it('fails visibly with an org gateway retry message when key fetch fails', async () => {
      const keyProvider = {
        getKey: jest.fn().mockRejectedValue(new Error('provider unavailable')),
      };
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      const client = new AgentInferenceClient(makeConfig(orgEnv), keyProvider);

      await expect(
        client.complete(ctx(['customer-ops']), {
          task: 'meeting-prep',
          tier: 'bundled',
          messages: [{ role: 'user', content: 'prepare' }],
          responseFormat: 'json',
        }),
      ).rejects.toThrow(/Org gateway.*retry/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does not silently call the old host when the org gateway returns an error', async () => {
      const keyProvider = {
        getKey: jest.fn().mockResolvedValue({
          key: 'org-key-for-failure-tests',
          expiresAt: Date.now() + 60_000,
        }),
      };
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse({}, false, 503));
      global.fetch = fetchSpy as any;
      const client = new AgentInferenceClient(makeConfig(orgEnv), keyProvider);

      await expect(
        client.complete(ctx(['customer-ops']), {
          task: 'next-best-action',
          tier: 'bundled',
          messages: [{ role: 'user', content: 'recommend' }],
          responseFormat: 'json',
        }),
      ).rejects.toThrow(/Org gateway/);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe(
        'https://org-gateway.example.test/v1/chat/completions',
      );
    });

    it('uses and counts the explicitly enabled instance migration fallback', async () => {
      const keyProvider = {
        getKey: jest.fn().mockRejectedValue(new Error('provider unavailable')),
      };
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(
          jsonResponse({ choices: [{ message: { content: 'fallback response' } }] }),
        );
      global.fetch = fetchSpy as any;
      const client = new AgentInferenceClient(
        makeConfig({ ...orgEnv, CUSTOMER_OPS_ORG_ROUTE_FALLBACK: 'instance' }),
        keyProvider,
      );

      const out = await client.complete(ctx(['customer-ops']), {
        task: 'follow-up-draft',
        tier: 'bundled',
        messages: [{ role: 'user', content: 'draft' }],
        responseFormat: 'text',
      });

      expect(out?.text).toBe('fallback response');
      expect(client.getOrgRouteFallbackCount()).toBe(1);
      expect(fetchSpy.mock.calls[0][0]).toBe(
        'https://legacy-instance.example.test/v1/chat/completions',
      );
      expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBe(
        'Bearer legacy-service-token',
      );
    });
  });

  describe('OpsCenterOrgGatewayKeyProvider', () => {
    it('fetches the v1 key endpoint and caches the key per org for at most ten minutes', async () => {
      const issuedAt = Date.now();
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse({
          key: 'provider-key-for-tests',
          expires_at: new Date(issuedAt + 60 * 60 * 1000).toISOString(),
        }),
      );
      global.fetch = fetchSpy as any;
      const provider = new OpsCenterOrgGatewayKeyProvider(
        makeConfig({
          OPS_CENTER_INTERNAL_URL: 'https://ops-center.internal.example.test/',
          OPS_CENTER_SERVICE_TOKEN: 'ops-service-token',
        }),
      );

      const first = await provider.getKey('org-aaaa');
      const second = await provider.getKey('org-aaaa');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe(
        'https://ops-center.internal.example.test/api/v1/internal/orgs/org-aaaa/gateway-key',
      );
      expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer ops-service-token');
      expect(first.key).toBe('provider-key-for-tests');
      expect(second).toEqual(first);

      // The key itself expires later, but the in-process cache must refresh at
      // the ten-minute cap.
      jest.spyOn(Date, 'now').mockReturnValue(issuedAt + ORG_GATEWAY_KEY_CACHE_MAX_MS + 1);
      await provider.getKey('org-aaaa');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});

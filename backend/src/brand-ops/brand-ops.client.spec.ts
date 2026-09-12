import { ConfigService } from '@nestjs/config';
import { BrandOpsClient, normalizeTokens } from './brand-ops.client';

const configOf = (values: Record<string, string>) => ({ get: (k: string) => values[k] }) as unknown as ConfigService;
const brigade = { exchangedToken: async () => null } as never;

describe('BrandOpsClient', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('is dormant without BRAND_OPS_BASE_URL: no fetch, null tokens, empty brands', async () => {
    const calls: unknown[] = [];
    global.fetch = (async (...a: unknown[]) => {
      calls.push(a);
      throw new Error('must not be called');
    }) as typeof fetch;
    const c = new BrandOpsClient(configOf({}), brigade);
    expect(c.isConfigured()).toBe(false);
    expect(await c.getBrandTokens('magic-unicorn')).toBeNull();
    expect(await c.listBrands()).toEqual([]);
    expect((await c.ping()).detail).toBe('not-configured');
    expect(calls).toEqual([]);
  });

  it('calls get_brand_tokens over MCP, parses structuredContent or text, and caches per slug', async () => {
    let n = 0;
    global.fetch = (async (_url: unknown, init: RequestInit) => {
      n += 1;
      const body = JSON.parse(String(init.body));
      expect(body.params.name).toBe('get_brand_tokens');
      expect(body.params.arguments).toEqual({ slug: 'magic-unicorn' });
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
      const payload = { brand: 'magic-unicorn', color: [{ name: 'brand/primary', value: '#b66eff', rgb: [182, 110, 255] }], typography: [{ name: 'font/display', value: 'Inter' }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }), { status: 200 });
    }) as typeof fetch;
    const c = new BrandOpsClient(configOf({ BRAND_OPS_BASE_URL: 'http://brand-ops.test/', BRAND_OPS_SERVICE_TOKEN: 'test-token' }), brigade);
    const t = await c.getBrandTokens('magic-unicorn');
    expect(t?.color[0]).toEqual({ name: 'brand/primary', value: '#b66eff' });
    expect(t?.typography[0].value).toBe('Inter');
    await c.getBrandTokens('Magic-Unicorn');
    expect(n).toBe(1);
  });

  it('folds transport, HTTP, JSON-RPC and tool errors to null (degrade-clean)', async () => {
    const c = new BrandOpsClient(configOf({ BRAND_OPS_BASE_URL: 'http://brand-ops.test' }), brigade);
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    expect(await c.getBrandTokens('a')).toBeNull();
    global.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    expect(await c.getBrandTokens('b')).toBeNull();
    global.fetch = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such tool' } }), { status: 200 })) as typeof fetch;
    expect(await c.getBrandTokens('c')).toBeNull();
    global.fetch = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'unknown brand' }] } }), { status: 200 })) as typeof fetch;
    expect(await c.getBrandTokens('d')).toBeNull();
    expect(await c.getBrandTokens('not a slug!')).toBeNull();
  });

  it('parses an SSE-framed Streamable HTTP reply and reports auth errors from ping', async () => {
    global.fetch = (async (_u: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === 'tools/list') return new Response('forbidden', { status: 403 });
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { brands: ['a', 'b'], count: 2 } } })}\n\n`, { status: 200 });
    }) as typeof fetch;
    const c = new BrandOpsClient(configOf({ BRAND_OPS_BASE_URL: 'http://brand-ops.test' }), brigade);
    expect(await c.listBrands()).toEqual(['a', 'b']);
    const h = await c.ping();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/^auth-error/);
  });

  it('normalizeTokens drops malformed entries and empty brands', () => {
    expect(normalizeTokens(null, 'x')).toBeNull();
    expect(normalizeTokens({ color: [], typography: [] }, 'x')).toBeNull();
    expect(normalizeTokens({ color: [{ name: 'brand/primary', value: '#fff' }, { bad: true }], typography: 'nope' }, 'x')).toEqual({ brand: 'x', color: [{ name: 'brand/primary', value: '#fff' }], typography: [], css: undefined });
  });
});

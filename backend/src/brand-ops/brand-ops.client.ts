/**
 * The concrete Brand-Ops federation client — JSON-RPC 2.0 over
 * `POST {BRAND_OPS_BASE_URL}/mcp` (Streamable HTTP; the server 406s unless the
 * client accepts both JSON and event-stream), tools `get_brand_tokens(slug)`
 * and `list_brands()`. Envelope: result.structuredContent (preferred) |
 * content[0].text (JSON). Application errors arrive as HTTP 200 +
 * result.isError or a JSON-RPC `error` — both fold to null.
 *
 * AUTH (mirrors the sibling clients): `static` forwards BRAND_OPS_SERVICE_TOKEN
 * when set (Brand-Ops on the internal network may need none); `brigade-sts`
 * exchanges a customer-ops client-credentials token for aud=brand-ops.
 *
 * CACHE: tokens are cached per slug for BRAND_OPS_CACHE_TTL_MS (default 10 min)
 * so a page render never waits on Brand-Ops twice; a failed lookup is cached
 * for one minute so a down Brand-Ops does not add latency to every render.
 *
 * DEGRADE-CLEAN (binding): unconfigured → every method returns null/[] with no
 * fetch, and the renderer uses the default theme.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';
import { SeamHealth } from '../health/seam-health';
import { shortBody } from '../health/probe-util';
import { BrandOpsPort } from './brand-ops.port';
import { BrandTokens } from './brand-ops.types';

interface JsonRpcResult {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: JsonRpcResult;
  error?: { code: number; message: string };
}

interface CacheEntry {
  value: BrandTokens | null;
  expiresAt: number;
}

@Injectable()
export class BrandOpsClient extends BrandOpsPort {
  private readonly logger = new Logger(BrandOpsClient.name);
  private rpcId = 0;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly config: ConfigService,
    private readonly brigade: BrigadeTokenSource,
  ) {
    super();
    if (!this.baseUrl) {
      this.logger.warn(
        'BRAND_OPS_BASE_URL unset — Brand-Ops federation is DORMANT; quotes render with the default theme.',
      );
    } else {
      this.logger.log(`Brand-Ops federation target: ${this.baseUrl} (auth=${this.authMode})`);
    }
  }

  // --- configuration seam -------------------------------------------------

  private get baseUrl(): string | null {
    const raw = this.config.get<string>('BRAND_OPS_BASE_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  private get timeoutMs(): number {
    const n = Number(this.config.get<string>('BRAND_OPS_TIMEOUT_MS'));
    return Number.isFinite(n) && n > 0 ? n : 5000;
  }

  private get cacheTtlMs(): number {
    const n = Number(this.config.get<string>('BRAND_OPS_CACHE_TTL_MS'));
    return Number.isFinite(n) && n > 0 ? n : 600_000;
  }

  private get authMode(): 'static' | 'brigade-sts' {
    return this.config.get<string>('BRAND_OPS_AUTH_MODE')?.trim() === 'brigade-sts'
      ? 'brigade-sts'
      : 'static';
  }

  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    let bearer: string | null = null;
    if (this.authMode === 'static') {
      const t = this.config.get<string>('BRAND_OPS_SERVICE_TOKEN');
      bearer = t && t.trim() ? t.trim() : null;
    } else {
      bearer = await this.brigade.exchangedToken({
        audience: this.config.get<string>('BRAND_OPS_AUDIENCE')?.trim() || 'brand-ops',
        scope: 'brands:read',
        workspaceId: this.config.get<string>('BRAND_OPS_WORKSPACE_ID')?.trim() || 'shared',
      });
    }
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    return headers;
  }

  // --- transport ----------------------------------------------------------

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Streamable-HTTP servers may answer as SSE; take the last `data:` JSON. */
  private parseRpc(text: string): JsonRpcResponse | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{')) {
      try {
        return JSON.parse(trimmed) as JsonRpcResponse;
      } catch {
        return null;
      }
    }
    const dataLines = trimmed.split('\n').filter((l) => l.startsWith('data:'));
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(dataLines[i].slice(5).trim()) as JsonRpcResponse;
      } catch {
        /* keep looking */
      }
    }
    return null;
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const base = this.baseUrl;
    if (!base) return null;
    const body = {
      jsonrpc: '2.0',
      id: ++this.rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    };
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${base}/mcp`, {
        method: 'POST',
        headers: await this.authHeaders(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.warn(`Brand-Ops MCP ${name} transport error: ${(err as Error).message}`);
      return null;
    }
    if (!res.ok) {
      this.logger.warn(`Brand-Ops MCP ${name} HTTP ${res.status}`);
      return null;
    }
    const payload = this.parseRpc(await res.text());
    if (!payload || payload.error) {
      this.logger.warn(
        `Brand-Ops MCP ${name} ${payload?.error ? `JSON-RPC error: ${payload.error.message}` : 'unparseable response'}`,
      );
      return null;
    }
    const result = payload.result;
    if (!result || result.isError) {
      this.logger.warn(
        `Brand-Ops MCP ${name} tool error: ${result?.content?.[0]?.text ?? 'unknown'}`,
      );
      return null;
    }
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.find((c) => c.type === 'text')?.text;
    if (!text) return null;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  // --- port ---------------------------------------------------------------

  async ping(): Promise<SeamHealth> {
    const base = this.baseUrl;
    if (!base)
      return {
        seam: 'brand-ops',
        configured: false,
        ok: false,
        status: null,
        detail: 'not-configured',
        latencyMs: null,
      };
    const started = Date.now();
    try {
      const res = await this.fetchWithTimeout(`${base}/mcp`, {
        method: 'POST',
        headers: await this.authHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++this.rpcId,
          method: 'tools/list',
          params: {},
        }),
      });
      const latencyMs = Date.now() - started;
      if (res.ok)
        return {
          seam: 'brand-ops',
          configured: true,
          ok: true,
          status: res.status,
          detail: 'ok',
          latencyMs,
        };
      const kind = res.status === 401 || res.status === 403 ? 'auth-error' : 'http-error';
      return {
        seam: 'brand-ops',
        configured: true,
        ok: false,
        status: res.status,
        detail: `${kind}: ${await shortBody(res)}`,
        latencyMs,
      };
    } catch (err) {
      return {
        seam: 'brand-ops',
        configured: true,
        ok: false,
        status: null,
        detail: `unreachable: ${(err as Error).message}`,
        latencyMs: Date.now() - started,
      };
    }
  }

  async getBrandTokens(slug: string): Promise<BrandTokens | null> {
    if (!this.isConfigured()) return null;
    const key = slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) return null;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const raw = await this.callTool('get_brand_tokens', { slug: key });
    const tokens = normalizeTokens(raw, key);
    this.cache.set(key, {
      value: tokens,
      expiresAt: Date.now() + (tokens ? this.cacheTtlMs : 60_000),
    });
    return tokens;
  }

  async listBrands(): Promise<string[]> {
    if (!this.isConfigured()) return [];
    const raw = await this.callTool('list_brands', {});
    const brands = raw?.brands;
    return Array.isArray(brands) ? brands.filter((b): b is string => typeof b === 'string') : [];
  }
}

/** Shape-check the wire result; a brand with neither colours nor type is null. */
export function normalizeTokens(
  raw: Record<string, unknown> | null,
  slug: string,
): BrandTokens | null {
  if (!raw) return null;
  const color = Array.isArray(raw.color)
    ? raw.color
        .filter(
          (c): c is { name: string; value: string } =>
            !!c &&
            typeof c === 'object' &&
            typeof (c as { name?: unknown }).name === 'string' &&
            typeof (c as { value?: unknown }).value === 'string',
        )
        .map((c) => ({ name: c.name, value: c.value }))
    : [];
  const typography = Array.isArray(raw.typography)
    ? raw.typography
        .filter(
          (t): t is { name: string; value: string } =>
            !!t &&
            typeof t === 'object' &&
            typeof (t as { name?: unknown }).name === 'string' &&
            typeof (t as { value?: unknown }).value === 'string',
        )
        .map((t) => ({ name: t.name, value: t.value }))
    : [];
  if (!color.length && !typography.length) return null;
  return {
    brand: typeof raw.brand === 'string' ? raw.brand : slug,
    color,
    typography,
    css: typeof raw.css === 'string' ? raw.css : undefined,
  };
}

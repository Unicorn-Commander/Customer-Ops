import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** The maximum amount of time a gateway key may live in this process. */
export const ORG_GATEWAY_KEY_CACHE_MAX_MS = 10 * 60 * 1000;
const ORG_GATEWAY_KEY_TIMEOUT_MS = 5_000;

/** The value returned by the internal key endpoint. */
export interface OrgGatewayKey {
  key: string;
  /** Epoch milliseconds, or an equivalent Date/ISO value from a test provider. */
  expiresAt: number | string | Date;
}

/** Supplies the opaque, app-scoped gateway key for one Ops-Center org. */
export interface OrgGatewayKeyProvider {
  getKey(orgId: string): Promise<OrgGatewayKey>;
}

/** Nest token for the provider interface. */
export const ORG_GATEWAY_KEY_PROVIDER = Symbol('ORG_GATEWAY_KEY_PROVIDER');

interface CachedOrgGatewayKey {
  key: string;
  expiresAt: number;
  cacheExpiresAt: number;
}

/**
 * v1 provider for the Customer-Ops org route.
 *
 * Ops-Center is the only service that can hand this app an org gateway key. The
 * key is kept only in this process, keyed by org id, and never appears in logs,
 * request metadata, or persistent storage.
 */
@Injectable()
export class OpsCenterOrgGatewayKeyProvider implements OrgGatewayKeyProvider {
  private readonly cache = new Map<string, CachedOrgGatewayKey>();
  private readonly inFlight = new Map<string, Promise<OrgGatewayKey>>();

  constructor(private readonly config: ConfigService) {}

  async getKey(orgId: string): Promise<OrgGatewayKey> {
    const normalizedOrgId = orgId.trim();
    if (!normalizedOrgId) throw new Error('org id is required for the gateway key');

    const now = Date.now();
    const cached = this.cache.get(normalizedOrgId);
    if (cached && cached.cacheExpiresAt > now) {
      return { key: cached.key, expiresAt: cached.expiresAt };
    }
    this.cache.delete(normalizedOrgId);

    const pending = this.inFlight.get(normalizedOrgId);
    if (pending) return pending;

    const request = this.fetchKey(normalizedOrgId);
    this.inFlight.set(normalizedOrgId, request);
    try {
      return await request;
    } finally {
      this.inFlight.delete(normalizedOrgId);
    }
  }

  /** Test/support seam. Production callers should only use getKey(). */
  clearCache(): void {
    this.cache.clear();
  }

  private get internalUrl(): string | null {
    const raw = this.config.get<string>('OPS_CENTER_INTERNAL_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/+$/, '') : null;
  }

  private get serviceToken(): string | null {
    const raw = this.config.get<string>('OPS_CENTER_SERVICE_TOKEN');
    return raw && raw.trim() ? raw.trim() : null;
  }

  private async fetchKey(orgId: string): Promise<OrgGatewayKey> {
    const base = this.internalUrl;
    if (!base) throw new Error('OPS_CENTER_INTERNAL_URL is not configured');
    const token = this.serviceToken;
    if (!token) throw new Error('OPS_CENTER_SERVICE_TOKEN is not configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ORG_GATEWAY_KEY_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(
        `${base}/api/v1/internal/orgs/${encodeURIComponent(orgId)}/gateway-key`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`gateway key endpoint returned HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('gateway key endpoint returned invalid JSON');
    }

    const rawKey =
      body && typeof body === 'object' && typeof (body as Record<string, unknown>).key === 'string'
        ? ((body as Record<string, unknown>).key as string).trim()
        : '';
    const rawExpiresAt =
      body && typeof body === 'object'
        ? ((body as Record<string, unknown>).expiresAt ??
          (body as Record<string, unknown>).expires_at)
        : undefined;
    const expiresAt = toEpochMs(rawExpiresAt);
    if (!rawKey || expiresAt === null || expiresAt <= Date.now()) {
      throw new Error('gateway key endpoint returned an invalid key or expiry');
    }

    const cacheExpiresAt = Math.min(Date.now() + ORG_GATEWAY_KEY_CACHE_MAX_MS, expiresAt);
    const value: CachedOrgGatewayKey = {
      key: rawKey,
      expiresAt,
      cacheExpiresAt,
    };
    this.cache.set(orgId, value);
    return { key: value.key, expiresAt: value.expiresAt };
  }
}

function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

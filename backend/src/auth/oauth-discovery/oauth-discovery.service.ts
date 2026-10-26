import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

export const MCP_PATH = '/api/v1/mcp';
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
export const RESOURCE_DOCUMENTATION_URL = 'https://unicorncommander.ai/platform/bring-your-own-ai';

export interface ConfigReader {
  get<T = any>(propertyPath: string, defaultValue?: T): T;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
  resource_name: string;
  resource_documentation: string;
}

/**
 * Builds RFC 9728 metadata from the same public URL and Keycloak settings used
 * by the API. A configured public URL is preferred; forwarded request headers
 * are the fallback for local/self-hosted instances behind a trusted proxy.
 */
@Injectable()
export class OAuthDiscoveryService {
  constructor(private readonly config: ConfigService) {}

  getMetadata(request: Request): ProtectedResourceMetadata {
    const publicOrigin = resolvePublicOrigin(request, this.config);
    return {
      resource: `${publicOrigin}${MCP_PATH}`,
      authorization_servers: [this.getAuthorizationServer()],
      bearer_methods_supported: ['header'],
      // Exactly what Keycloak's anonymous-DCR policy allows; the realm scope `mcp` carries this app's audience + uc_uid.
      scopes_supported: ['openid', 'profile', 'email', 'offline_access', 'mcp'],
      resource_name: 'Customer-Ops MCP',
      resource_documentation: RESOURCE_DOCUMENTATION_URL,
    };
  }

  getAuthorizationServer(): string {
    const base = (
      this.config.get<string>('KEYCLOAK_PUBLIC_URL') ||
      this.config.get<string>('KEYCLOAK_URL', 'http://127.0.0.1:8080') ||
      'http://127.0.0.1:8080'
    )
      .trim()
      .replace(/\/+$/, '');
    const realm = this.config.get<string>('KEYCLOAK_REALM', 'customer-ops') || 'customer-ops';
    return `${base}/realms/${encodeURIComponent(realm)}`;
  }
}

/**
 * Resolve only an origin. Rejecting userinfo, query strings, and fragments
 * prevents request-derived metadata from becoming a credential-bearing URL.
 */
export function resolvePublicOrigin(request: Request, config?: ConfigReader): string {
  const configured = config?.get<string>('PUBLIC_API_BASE_URL');
  if (configured?.trim()) {
    const origin = parseOrigin(configured.trim());
    if (origin) return origin;
  }

  const forwardedProto = firstHeader(request.headers['x-forwarded-proto']);
  const protocol = normalizeProtocol(forwardedProto || request.protocol || 'http');
  const forwardedHost = firstHeader(request.headers['x-forwarded-host']);
  const requestHost = typeof request.get === 'function' ? request.get('host') : undefined;
  const host = forwardedHost || firstHeader(request.headers.host) || requestHost;
  const origin = parseOrigin(`${protocol}://${host || 'localhost'}`);
  return origin || `${protocol}://localhost`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]?.split(',')[0]?.trim() || undefined;
  if (typeof value === 'string') return value.split(',')[0]?.trim() || undefined;
  return undefined;
}

function normalizeProtocol(value: string): 'http' | 'https' {
  return value.trim().toLowerCase() === 'https' ? 'https' : 'http';
}

function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

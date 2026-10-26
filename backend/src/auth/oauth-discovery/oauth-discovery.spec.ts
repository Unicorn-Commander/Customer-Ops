import { All, Controller, INestApplication, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'crypto';
import { AddressInfo } from 'net';
import * as jwt from 'jsonwebtoken';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { JwtStrategy } from '../strategies/jwt.strategy';
import { AuthService } from '../auth.service';
import { PatService } from '../pat/pat.service';
import { listMyWorkspaces } from '../../common/workspace/list-my-workspaces';
import { createMcpCorsMiddleware } from './mcp-cors';
import { OAuthDiscoveryController } from './oauth-discovery.controller';
import { OAuthDiscoveryService } from './oauth-discovery.service';

let jwksPublicKey = '';

jest.mock('jwks-rsa', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    getSigningKey: (_kid: string, callback: (error: Error | null, key?: any) => void) =>
      callback(null, { getPublicKey: () => jwksPublicKey }),
  })),
}));

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
jwksPublicKey = keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const localSecret = 'synthetic-local-secret-for-oauth-tests';
const realmIssuer = 'https://auth.example.com/realms/uchub';

@Controller('mcp')
class McpProbeController {
  @All()
  @UseGuards(JwtAuthGuard)
  handle(@Req() request: any) {
    return {
      ok: Boolean(request.user),
      ucUid: request.user?.__ucUid ?? null,
    };
  }
}

describe('Customer-Ops MCP OAuth discovery and resource-server boundary', () => {
  let app: INestApplication;
  let baseUrl = '';
  const configValues: Record<string, string | undefined> = {
    JWT_SECRET: localSecret,
    BRIGADE_TRUSTED_ISSUERS: '',
    KEYCLOAK_URL: 'https://auth.example.com',
    KEYCLOAK_REALM: 'uchub',
    KEYCLOAK_CLIENT_ID: 'customer-ops',
    CORS_ORIGIN: 'https://portal.example.com',
    FRONTEND_URL: 'https://portal.example.com',
    MCP_CORS_ORIGINS: 'https://allowed.example.com',
    PUBLIC_API_BASE_URL: 'https://api.customer-ops.example.com',
  };
  const config = {
    get: <T>(key: string, fallback?: T) => (configValues[key] ?? fallback) as T,
  } as unknown as ConfigService;
  const fixtureUser = {
    id: 'synthetic-local-user',
    email: 'tester@example.com',
    keycloakId: 'synthetic-uchub-sub',
    isActive: true,
  } as any;
  const authService = {
    validateJwtPayload: jest.fn().mockResolvedValue(fixtureUser),
  } as unknown as AuthService;
  const patService = {
    findByPlaintext: jest.fn(async () => null),
  } as unknown as PatService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [OAuthDiscoveryController, McpProbeController],
      providers: [
        OAuthDiscoveryService,
        JwtStrategy,
        JwtAuthGuard,
        { provide: ConfigService, useValue: config },
        { provide: PatService, useValue: patService },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(createMcpCorsMiddleware(config));
    app.enableCors({ origin: 'https://portal.example.com', credentials: true });
    app.setGlobalPrefix('api/v1', {
      exclude: [
        '.well-known/oauth-protected-resource',
        '.well-known/oauth-protected-resource/api/v1/mcp',
      ],
    });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (patService.findByPlaintext as jest.Mock).mockResolvedValue(null);
    (authService.validateJwtPayload as jest.Mock).mockResolvedValue(fixtureUser);
  });

  async function call(path: string, init: RequestInit = {}) {
    const response = await fetch(`${baseUrl}${path}`, init);
    const raw = await response.text();
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      // Keep non-JSON responses as text for diagnostics.
    }
    return { status: response.status, headers: response.headers, body };
  }

  function jsonBody() {
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  }

  function signedKeycloakToken(
    claims: Record<string, unknown> = {},
    secret: jwt.Secret = keyPair.privateKey,
  ) {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      {
        sub: 'synthetic-uchub-sub',
        iss: realmIssuer,
        azp: 'customer-ops',
        aud: 'account',
        iat: now - 10,
        exp: now + 300,
        ...claims,
      },
      secret,
      {
        algorithm: secret === keyPair.privateKey ? 'RS256' : 'HS256',
        keyid: 'synthetic-jwks-key',
      },
    );
  }

  it('serves both RFC 9728 metadata paths without auth and with cache/CORS headers', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/api/v1/mcp',
    ]) {
      const response = await call(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/application\/json/);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(Object.keys(response.body as object)).toEqual(
        expect.arrayContaining([
          'resource',
          'authorization_servers',
          'bearer_methods_supported',
          'scopes_supported',
          'resource_name',
          'resource_documentation',
        ]),
      );
      expect((response.body as any).resource).toBe(
        'https://api.customer-ops.example.com/api/v1/mcp',
      );
      expect((response.body as any).authorization_servers).toEqual([realmIssuer]);
    }
  });

  it('serves OPTIONS for both RFC 9728 metadata paths without auth', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/api/v1/mcp',
    ]) {
      const response = await call(path, { method: 'OPTIONS', headers: { Origin: 'https://outside.example.com' } });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    }
  });

  it('answers MCP preflight before auth and carries the Streamable HTTP header contract', async () => {
    const response = await call('/api/v1/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://allowed.example.com',
        'Access-Control-Request-Headers': 'Authorization, Mcp-Session-Id',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://allowed.example.com');
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(response.headers.get('access-control-allow-headers')).toContain('Mcp-Session-Id');
    expect(response.headers.get('access-control-allow-headers')).toContain('Mcp-Protocol-Version');
    expect(response.headers.get('access-control-allow-headers')).toContain('Last-Event-ID');
    expect(response.headers.get('access-control-expose-headers')).toBe('Mcp-Session-Id');
  });

  it('rejects a browser request from a disallowed origin before auth', async () => {
    const response = await call('/api/v1/mcp', {
      method: 'POST',
      headers: {
        Origin: 'https://outside.example.com',
        Authorization: 'Bearer co_pat_synthetic_invalid',
        'Content-Type': 'application/json',
      },
      body: jsonBody(),
    });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'origin_not_allowed' });
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  it('returns the discovery challenge for a missing bearer', async () => {
    const response = await call('/api/v1/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody(),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer realm="customer-ops-mcp", ' +
        'resource_metadata="https://api.customer-ops.example.com/.well-known/oauth-protected-resource/api/v1/mcp"',
    );
    expect(JSON.stringify(response.body)).not.toContain('co_pat_');
  });

  it('returns invalid_token discovery for an unknown PAT', async () => {
    const response = await call('/api/v1/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer co_pat_synthetic_invalid', 'Content-Type': 'application/json' },
      body: jsonBody(),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(patService.findByPlaintext).toHaveBeenCalledWith('co_pat_synthetic_invalid');
    expect(JSON.stringify(response.body)).not.toContain('co_pat_synthetic_invalid');
  });

  it('does not use a browser cookie/session to authenticate the MCP path', async () => {
    const response = await call('/api/v1/mcp', {
      method: 'POST',
      headers: { Cookie: 'access_token=synthetic-cookie-value', 'Content-Type': 'application/json' },
      body: jsonBody(),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).not.toContain('error="invalid_token"');
  });

  it('accepts a signed Keycloak RS256 token and resolves the same user path as REST', async () => {
    const response = await call('/api/v1/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${signedKeycloakToken()}`, 'Content-Type': 'application/json' },
      body: jsonBody(),
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, ucUid: 'synthetic-uchub-sub' });
    expect(authService.validateJwtPayload).toHaveBeenCalled();
  });

  it('rejects an expired signed Keycloak token', async () => {
    const response = await call('/api/v1/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signedKeycloakToken({ iat: Math.floor(Date.now() / 1000) - 600, exp: Math.floor(Date.now() / 1000) - 300 })}`,
        'Content-Type': 'application/json',
      },
      body: jsonBody(),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('rejects a Keycloak-looking HS256 token even when signed with the local secret', async () => {
    const response = await call('/api/v1/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${signedKeycloakToken({}, localSecret)}`, 'Content-Type': 'application/json' },
      body: jsonBody(),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('rejects an RS256 token from an issuer other than the configured realm', async () => {
    const response = await call('/api/v1/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signedKeycloakToken({ iss: 'https://other.example.com/realms/uchub' })}`,
        'Content-Type': 'application/json',
      },
      body: jsonBody(),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('accepts a wrong Keycloak audience while KEYCLOAK_ENFORCE_AUDIENCE is log-only', async () => {
    const response = await call('/api/v1/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signedKeycloakToken({ azp: 'sibling-app', aud: ['account'] })}`,
        'Content-Type': 'application/json',
      },
      body: jsonBody(),
    });

    expect(response.status).toBe(200);
    expect((response.body as any).ok).toBe(true);
  });

  it('rejects a wrong Keycloak audience when enforcement is enabled', async () => {
    const enforcingConfig = {
      get: <T>(key: string, fallback?: T) =>
        (key === 'KEYCLOAK_ENFORCE_AUDIENCE' ? 'true' : configValues[key] ?? fallback) as T,
    } as unknown as ConfigService;
    const enforcing = new JwtStrategy(enforcingConfig, {
      validateJwtPayload: jest.fn(),
    } as unknown as AuthService);

    await expect(
      enforcing.validate({
        iss: realmIssuer,
        azp: 'sibling-app',
        aud: 'account',
        sub: 'synthetic-uchub-sub',
      }),
    ).rejects.toThrow('not authorized for customer-ops');
  });

  it('uses ring-specific public origin and Keycloak issuer configuration', () => {
    const dogfoodConfig = {
      get: <T>(key: string, fallback?: T) =>
        (({
          PUBLIC_API_BASE_URL: 'https://customer-ops.magicunicorn.dev',
          KEYCLOAK_URL: 'https://auth.magicunicorn.dev',
          KEYCLOAK_REALM: 'uchub',
        })[key] ?? fallback) as T,
    } as unknown as ConfigService;
    const service = new OAuthDiscoveryService(dogfoodConfig);
    const metadata = service.getMetadata({
      headers: { host: 'internal:3000' },
      protocol: 'http',
      get: () => 'internal:3000',
    } as any);

    expect(metadata.resource).toBe('https://customer-ops.magicunicorn.dev/api/v1/mcp');
    expect(metadata.authorization_servers).toEqual(['https://auth.magicunicorn.dev/realms/uchub']);
  });

  it('falls back to forwarded public proto and host when no public URL is configured', () => {
    const forwardedConfig = {
      get: <T>(key: string, fallback?: T) =>
        (({ KEYCLOAK_URL: 'https://auth.example.com', KEYCLOAK_REALM: 'uchub' })[key] ?? fallback) as T,
    } as unknown as ConfigService;
    const service = new OAuthDiscoveryService(forwardedConfig);
    const metadata = service.getMetadata({
      headers: {
        host: 'internal:3000',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'api.customer-ops.example.com',
      },
      protocol: 'http',
      get: () => 'internal:3000',
    } as any);

    expect(metadata.resource).toBe('https://api.customer-ops.example.com/api/v1/mcp');
  });

  it('keys the workspace projection by the OAuth subject and returns empty for no membership', async () => {
    const membership = {
      listActiveMemberships: jest.fn().mockResolvedValue([]),
      findWorkspaces: jest.fn(),
    };
    const user = {
      id: 'synthetic-local-user',
      keycloakId: 'synthetic-unmatched-sub',
    } as any;

    await expect(listMyWorkspaces(membership as any, user)).resolves.toEqual([]);
    expect(membership.listActiveMemberships).toHaveBeenCalledWith(user);
    expect(membership.findWorkspaces).not.toHaveBeenCalled();
  });
});

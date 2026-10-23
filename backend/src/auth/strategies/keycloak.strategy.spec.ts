import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';
import { KeycloakStrategy } from './keycloak.strategy';

describe('KeycloakStrategy self-host endpoints', () => {
  const auth = { validateKeycloakUser: jest.fn() };
  const create = (config: Record<string, string> = {}) =>
    new KeycloakStrategy(new ConfigService(config), auth as unknown as AuthService);
  const endpoints = (strategy: KeycloakStrategy) => (strategy as any)._oauth2;

  afterEach(() => jest.restoreAllMocks());

  it('defaults to a local realm without a suite identity provider', () => {
    const oauth = endpoints(create());
    expect(oauth._authorizeUrl).toBe(
      'http://127.0.0.1:8080/realms/customer-ops/protocol/openid-connect/auth',
    );
    expect(oauth._accessTokenUrl).toBe(
      'http://127.0.0.1:8080/realms/customer-ops/protocol/openid-connect/token',
    );
  });

  it('preserves a configured single identity-provider URL', () => {
    const oauth = endpoints(
      create({ KEYCLOAK_URL: 'https://identity.example.test', KEYCLOAK_REALM: 'existing' }),
    );
    expect(oauth._authorizeUrl).toBe(
      'https://identity.example.test/realms/existing/protocol/openid-connect/auth',
    );
    expect(oauth._accessTokenUrl).toBe(
      'https://identity.example.test/realms/existing/protocol/openid-connect/token',
    );
  });

  it('uses the public URL for the browser and the internal URL for code exchange', () => {
    const oauth = endpoints(
      create({
        KEYCLOAK_URL: 'http://keycloak:8080/',
        KEYCLOAK_PUBLIC_URL: 'http://127.0.0.1:8080/',
      }),
    );
    expect(oauth._authorizeUrl).toBe(
      'http://127.0.0.1:8080/realms/customer-ops/protocol/openid-connect/auth',
    );
    expect(oauth._accessTokenUrl).toBe(
      'http://keycloak:8080/realms/customer-ops/protocol/openid-connect/token',
    );
  });

  it('fetches userinfo inside the compose network before resolving the identity', async () => {
    const profile = { sub: 'local-admin', email: 'admin@example.invalid', email_verified: true };
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => profile,
    } as Response);
    const strategy = create({ KEYCLOAK_URL: 'http://keycloak:8080' });
    await strategy.validate('test-access-token', '', {});
    expect(fetcher).toHaveBeenCalledWith(
      'http://keycloak:8080/realms/customer-ops/protocol/openid-connect/userinfo',
      { headers: { Authorization: 'Bearer test-access-token' } },
    );
    expect(auth.validateKeycloakUser).toHaveBeenCalledWith('local-admin', profile);
  });
});

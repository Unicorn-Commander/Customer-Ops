import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { WorkspaceContextService } from '../../common/workspace/workspace-context.service';
import { M365Config } from '../m365.config';
import { M365StateService } from './m365-state.service';
import { M365OAuthService } from './m365-oauth.service';
import { MsalClientFactory } from './msal-client.factory';
import { M365ConnectionStore } from '../store/m365-connection.store';
import { M365OAuthController } from './m365-oauth.controller';

/**
 * The OAuth handshake. MSAL + the store are MOCKED; the state uses a REAL
 * JwtService (so signature verification is genuinely exercised) signed with a
 * test JWT_SECRET. These pin the SECURITY CONTRACT:
 *   • the state is signed + single-use; a forged / expired / replayed state is rejected,
 *   • the refresh token is stored ENCRYPTED, never as plaintext,
 *   • the callback always 302s back to the SPA (connected | error), never leaking.
 */
const USER = { id: 'user-aaron', keycloakId: 'kc-aaron' } as User;
const WS = '0190a000-7e57-7000-8000-00000000c007';
const JWT_SECRET = 'test-jwt-secret-please-ignore';

function makeConfig(over: Record<string, string | undefined> = {}): M365Config {
  const env: Record<string, string | undefined> = {
    M365_CLIENT_ID: 'app-1',
    M365_CLIENT_SECRET: 'secret',
    M365_REDIRECT_URI: 'http://localhost:3000/api/v1/m365/oauth/callback',
    M365_SCOPES: 'offline_access User.Read Contacts.Read',
    FRONTEND_URL: 'http://localhost:3001',
    M365_STATE_TTL_SECONDS: '600',
    ...over,
  };
  return new M365Config({ get: (k: string) => env[k] } as unknown as ConfigService);
}

function build(configOver: Record<string, string | undefined> = {}) {
  const config = makeConfig(configOver);
  const jwt = new JwtService({ secret: JWT_SECRET });
  const state = new M365StateService(jwt, config);
  const workspaces = { resolveAuthorized: jest.fn().mockResolvedValue(WS) } as unknown as WorkspaceContextService;

  // A cipher stub that makes encryption observable WITHOUT echoing the plaintext
  // (so we can assert the STORED value is opaque ciphertext, never the token). A
  // base64 round-trip stands in for the real AES-256-GCM opaque output.
  const cipher = {
    encrypt: jest.fn((p: string) => `enc.${Buffer.from(p).toString('base64')}`),
    decrypt: jest.fn(),
  } as any;

  const msal = {
    getAuthCodeUrl: jest.fn().mockResolvedValue('https://login.microsoftonline.com/common/authorize?state=SIGNED'),
    acquireTokenByCode: jest.fn().mockResolvedValue({
      accessToken: 'access-token-1',
      refreshToken: 'refresh-token-SECRET',
      expiresOn: new Date('2026-06-23T01:00:00Z'),
      scopes: ['Contacts.Read'],
      account: { homeAccountId: 'home-1', username: 'aaron@contoso.com' },
    }),
  } as unknown as MsalClientFactory;

  const stored: any[] = [];
  const store = { upsert: jest.fn(async (input: any) => stored.push(input)) } as unknown as M365ConnectionStore;

  const service = new M365OAuthService(config, workspaces, state, msal, cipher, store);
  const controller = new M365OAuthController(service);
  return { config, jwt, state, workspaces, cipher, msal, store, stored, service, controller };
}

describe('M365 OAuth handshake', () => {
  describe('start', () => {
    it('signs a state and returns the MSAL consent URL', async () => {
      const { service, msal } = build();
      const { url } = await service.start(USER);
      expect(url).toContain('login.microsoftonline.com');
      // The signed state was handed to MSAL.
      const stateArg = (msal.getAuthCodeUrl as jest.Mock).mock.calls[0][0] as string;
      expect(stateArg.split('.')).toHaveLength(3); // a JWT
    });

    it('503s when the connector is dormant (no M365_CLIENT_ID)', async () => {
      const { service } = build({ M365_CLIENT_ID: undefined });
      await expect(service.start(USER)).rejects.toThrow(/not configured/);
    });
  });

  describe('complete — the security boundary', () => {
    it('verifies the signed state, redeems the code, and stores the refresh token ENCRYPTED (never plaintext)', async () => {
      const { service, state, stored, cipher } = build();
      const signed = state.sign(USER.id, WS);

      const out = await service.complete('auth-code-1', signed);
      expect(out).toEqual({ userId: USER.id, workspaceId: WS });

      expect(stored).toHaveLength(1);
      const row = stored[0];
      // The refresh token was encrypted before storage.
      expect(cipher.encrypt).toHaveBeenCalledWith('refresh-token-SECRET');
      // The PLAINTEXT token never appears anywhere in the stored row.
      expect(JSON.stringify(row)).not.toContain('refresh-token-SECRET');
      expect(row.refreshTokenEnc).toBe(`enc.${Buffer.from('refresh-token-SECRET').toString('base64')}`);
      // The access token is encrypted too; identity carried through.
      expect(JSON.stringify(row)).not.toContain('access-token-1');
      expect(row.m365UserPrincipal).toBe('aaron@contoso.com');
    });

    it('REJECTS a forged state (wrong signature)', async () => {
      const { service } = build();
      const forged = new JwtService({ secret: 'attacker-secret' }).sign({ uid: 'mallory', ws: WS, nonce: 'x' });
      await expect(service.complete('code', forged)).rejects.toThrow(/Invalid or expired/);
    });

    it('REJECTS an expired state', async () => {
      const { service } = build({ M365_STATE_TTL_SECONDS: '600' });
      // Sign a token that is already expired.
      const expired = new JwtService({ secret: JWT_SECRET }).sign(
        { uid: USER.id, ws: WS, nonce: 'n1' },
        { expiresIn: -10 },
      );
      await expect(service.complete('code', expired)).rejects.toThrow(/Invalid or expired/);
    });

    it('REJECTS a REPLAYED state (single-use nonce consumed on first success)', async () => {
      const { service, state } = build();
      const signed = state.sign(USER.id, WS);
      await service.complete('code', signed); // first use OK
      await expect(service.complete('code', signed)).rejects.toThrow(/already used/);
    });

    it('throws when Microsoft returns no refresh token (offline_access not granted)', async () => {
      const { service, state, msal } = build();
      (msal.acquireTokenByCode as jest.Mock).mockResolvedValue({
        accessToken: 'a',
        refreshToken: null,
        expiresOn: null,
        scopes: [],
        account: { homeAccountId: 'h' },
      });
      const signed = state.sign(USER.id, WS);
      await expect(service.complete('code', signed)).rejects.toThrow(/did not return a refresh token/);
    });
  });

  describe('callback controller — always redirects, never leaks', () => {
    function fakeRes() {
      return { redirect: jest.fn() } as any;
    }

    it('redirects to ?m365=connected on success', async () => {
      const { controller, state } = build();
      const res = fakeRes();
      const signed = state.sign(USER.id, WS);
      await controller.callback('code', signed, undefined, {}, res);
      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringContaining('/dashboard/settings/integrations?m365=connected'),
      );
    });

    it('redirects to ?m365=error on a forged state (no exception to the browser)', async () => {
      const { controller } = build();
      const res = fakeRes();
      await controller.callback('code', 'not-a-valid-jwt', undefined, {}, res);
      const target = res.redirect.mock.calls[0][0] as string;
      expect(target).toContain('m365=error');
    });

    it('redirects to ?m365=error when Entra returned an error (denied / admin consent)', async () => {
      const { controller } = build();
      const res = fakeRes();
      await controller.callback(undefined, undefined, 'access_denied', {}, res);
      const target = res.redirect.mock.calls[0][0] as string;
      expect(target).toContain('m365=error');
      expect(target).toContain('access_denied');
    });

    it('redirects to ?m365=error when code/state are missing', async () => {
      const { controller } = build();
      const res = fakeRes();
      await controller.callback(undefined, undefined, undefined, {}, res);
      expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('m365=error'));
    });
  });
});

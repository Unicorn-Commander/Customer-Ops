import { ConfigService } from '@nestjs/config';
import { M365Connection, M365ConnectionStatus } from '@prisma/client';
import { M365Config } from '../m365.config';
import { TokenCipher } from '../crypto/token-cipher';
import { MsalClientFactory } from '../oauth/msal-client.factory';
import { M365ConnectionStore } from '../store/m365-connection.store';
import { M365GraphClient, M365AuthRevokedError } from './m365-graph.client';

/**
 * M365GraphClient — Microsoft Graph is MOCKED via a fake global.fetch; MSAL +
 * the cipher + the store are stubbed. These pin the transport contract:
 *   • token: decrypt refresh → MSAL refresh → persist rotated token,
 *   • paging: follow @odata.nextLink, surface @odata.deltaLink,
 *   • throttling: 429 + Retry-After → retry then succeed,
 *   • invalid_grant → mark REVOKED + throw M365AuthRevokedError.
 */
function makeConfig(): M365Config {
  const env: Record<string, string> = {
    M365_CLIENT_ID: 'app-1',
    M365_CLIENT_SECRET: 'secret',
    M365_GRAPH_BASE_URL: 'https://graph.test/v1.0',
    M365_SYNC_PAGE_SIZE: '50',
    M365_TIMEOUT_MS: '15000',
  };
  return new M365Config({ get: (k: string) => env[k] } as unknown as ConfigService);
}

/** A cipher stub: decrypt strips a "enc:" prefix, encrypt adds it (deterministic). */
function makeCipher(): TokenCipher {
  return {
    decrypt: jest.fn((b: string) => b.replace(/^enc:/, '')),
    encrypt: jest.fn((p: string) => `enc:${p}`),
  } as unknown as TokenCipher;
}

function makeConnection(over: Partial<M365Connection> = {}): M365Connection {
  return {
    id: 'm365-1',
    userId: 'user-aaron',
    workspaceId: 'ws-1',
    m365UserId: 'graph-user-1',
    m365UserPrincipal: 'aaron@contoso.com',
    scopes: ['offline_access', 'Contacts.Read'],
    refreshTokenEnc: 'enc:refresh-token-1',
    accessTokenEnc: null,
    accessTokenExpires: null,
    status: M365ConnectionStatus.ACTIVE,
    deltaLinkContacts: null,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('M365GraphClient (Graph MOCKED)', () => {
  const origFetch = global.fetch;
  let cipher: TokenCipher;
  let store: jest.Mocked<Pick<M365ConnectionStore, 'updateTokens' | 'markRevoked'>>;
  let msal: jest.Mocked<Pick<MsalClientFactory, 'acquireTokenByRefreshToken'>>;
  let client: M365GraphClient;

  beforeEach(() => {
    cipher = makeCipher();
    store = { updateTokens: jest.fn().mockResolvedValue(undefined), markRevoked: jest.fn().mockResolvedValue(undefined) } as any;
    msal = {
      acquireTokenByRefreshToken: jest.fn().mockResolvedValue({
        accessToken: 'fresh-access-token',
        refreshToken: 'rotated-refresh-token',
        expiresOn: new Date('2026-06-23T01:00:00Z'),
        scopes: ['Contacts.Read'],
        account: null,
      }),
    } as any;
    client = new M365GraphClient(
      makeConfig(),
      cipher,
      msal as unknown as MsalClientFactory,
      store as unknown as M365ConnectionStore,
    );
  });

  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  describe('getAccessToken', () => {
    it('decrypts the refresh token, refreshes via MSAL, and persists the rotated token + fresh access token', async () => {
      const token = await client.getAccessToken(makeConnection());
      expect(token).toBe('fresh-access-token');
      expect(cipher.decrypt).toHaveBeenCalledWith('enc:refresh-token-1');
      expect(msal.acquireTokenByRefreshToken).toHaveBeenCalledWith('refresh-token-1');
      // Rotated refresh token re-encrypted + the fresh access token stored.
      expect(store.updateTokens).toHaveBeenCalledWith('user-aaron', 'm365-1', {
        refreshTokenEnc: 'enc:rotated-refresh-token',
        accessTokenEnc: 'enc:fresh-access-token',
        accessTokenExpires: new Date('2026-06-23T01:00:00Z'),
      });
    });

    it('marks REVOKED + throws M365AuthRevokedError on invalid_grant', async () => {
      msal.acquireTokenByRefreshToken.mockRejectedValue(new Error('invalid_grant: token expired'));
      await expect(client.getAccessToken(makeConnection())).rejects.toBeInstanceOf(M365AuthRevokedError);
      expect(store.markRevoked).toHaveBeenCalledWith('user-aaron', 'm365-1');
    });

    it('bubbles a transient (non-invalid_grant) error WITHOUT marking revoked', async () => {
      msal.acquireTokenByRefreshToken.mockRejectedValue(new Error('temporarily_unavailable'));
      await expect(client.getAccessToken(makeConnection())).rejects.toThrow(/temporarily_unavailable/);
      expect(store.markRevoked).not.toHaveBeenCalled();
    });

    it('marks REVOKED when the stored blob is undecryptable', async () => {
      (cipher.decrypt as jest.Mock).mockImplementation(() => {
        throw new Error('bad tag');
      });
      await expect(client.getAccessToken(makeConnection())).rejects.toBeInstanceOf(M365AuthRevokedError);
      expect(store.markRevoked).toHaveBeenCalledWith('user-aaron', 'm365-1');
    });
  });

  describe('listContacts paging', () => {
    it('follows @odata.nextLink across pages and returns the @odata.deltaLink', async () => {
      const fetchMock = jest
        .fn()
        // page 1 → has a nextLink
        .mockResolvedValueOnce(
          jsonResponse({ value: [{ id: 'c1', displayName: 'One' }], '@odata.nextLink': 'https://graph.test/v1.0/me/contacts/delta?$skiptoken=P2' }),
        )
        // page 2 → terminal, has the deltaLink
        .mockResolvedValueOnce(
          jsonResponse({ value: [{ id: 'c2', displayName: 'Two' }], '@odata.deltaLink': 'https://graph.test/v1.0/me/contacts/delta?$deltatoken=DELTA' }),
        );
      global.fetch = fetchMock as any;

      const page = await client.listContacts(makeConnection());
      expect(page.contacts.map((c) => c.id)).toEqual(['c1', 'c2']);
      expect(page.deltaLink).toBe('https://graph.test/v1.0/me/contacts/delta?$deltatoken=DELTA');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // First call hit the /me/contacts/delta endpoint with $select + $top.
      const firstUrl = fetchMock.mock.calls[0][0] as string;
      expect(firstUrl).toContain('/me/contacts/delta');
      expect(firstUrl).toContain('$top=50');
      // Bearer attached.
      expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer fresh-access-token');
    });

    it('replays a STORED delta link when present (incremental sync)', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse({ value: [], '@odata.deltaLink': 'https://graph.test/v1.0/me/contacts/delta?$deltatoken=NEXT' }),
      );
      global.fetch = fetchMock as any;

      const stored = 'https://graph.test/v1.0/me/contacts/delta?$deltatoken=PREV';
      await client.listContacts(makeConnection({ deltaLinkContacts: stored }));
      expect(fetchMock.mock.calls[0][0]).toBe(stored); // replayed verbatim, not a fresh enumerate
    });
  });

  describe('throttling', () => {
    it('honors Retry-After on a 429 then succeeds', async () => {
      jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
        fn(); // run the backoff immediately (no real wait in the test)
        return 0 as unknown as NodeJS.Timeout;
      }) as any);
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: 'throttled' }, 429, { 'retry-after': '1' }))
        .mockResolvedValueOnce(jsonResponse({ value: [{ id: 'c1' }] }));
      global.fetch = fetchMock as any;

      const page = await client.listContacts(makeConnection());
      expect(page.contacts.map((c) => c.id)).toEqual(['c1']);
      expect(fetchMock).toHaveBeenCalledTimes(2); // retried once after the 429
    });

    it('throws on a non-retryable HTTP error (e.g. 500 after no Retry-After path)', async () => {
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: { code: 'x', message: 'boom' } }, 500)) as any;
      await expect(client.listContacts(makeConnection())).rejects.toThrow(/HTTP 500/);
    });

    it('treats a mid-walk 401 as a revoke', async () => {
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401)) as any;
      await expect(client.listContacts(makeConnection())).rejects.toBeInstanceOf(M365AuthRevokedError);
    });
  });
});

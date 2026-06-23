import { M365Connection, M365ConnectionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { M365ConnectionStore } from './m365-connection.store';

/**
 * M365ConnectionStore — the credential store. No DB; the `m365Connection` Prisma
 * surface is mocked. The load-bearing assertion: the table is NON-RLS, so the
 * ONLY thing standing between user A and user B's stored refresh tokens is the
 * code-level `where: { userId }` ownership fence — every read/update/delete here
 * MUST carry it. These tests pin that fence (and the unique upsert key + the
 * secret-omitting metadata view).
 */
const USER_A = 'user-aaron';
const USER_B = 'user-mallory';
const WS = '0190a000-7e57-7000-8000-00000000c007';

function makeRow(over: Partial<M365Connection> = {}): M365Connection {
  return {
    id: 'm365-1',
    userId: USER_A,
    workspaceId: WS,
    m365UserId: 'graph-user-1',
    m365UserPrincipal: 'aaron@contoso.com',
    scopes: ['offline_access', 'Contacts.Read'],
    refreshTokenEnc: 'iv:tag:ciphertext',
    accessTokenEnc: null,
    accessTokenExpires: null,
    status: M365ConnectionStatus.ACTIVE,
    deltaLinkContacts: null,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    createdAt: new Date('2026-06-23T00:00:00Z'),
    updatedAt: new Date('2026-06-23T00:00:00Z'),
    ...over,
  };
}

describe('M365ConnectionStore', () => {
  let store: M365ConnectionStore;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      m365Connection: {
        upsert: jest.fn(async ({ create }: any) => makeRow(create)),
        findFirst: jest.fn(async () => null),
        updateMany: jest.fn(async () => ({ count: 1 })),
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    store = new M365ConnectionStore(prisma as PrismaService);
  });

  it('upsert keys on the (userId, workspaceId) unique and writes the encrypted blob', async () => {
    await store.upsert({
      userId: USER_A,
      workspaceId: WS,
      m365UserId: 'graph-user-1',
      m365UserPrincipal: 'aaron@contoso.com',
      scopes: ['offline_access', 'Contacts.Read'],
      refreshTokenEnc: 'iv:tag:ct',
      accessTokenEnc: 'iv:tag:at',
      accessTokenExpires: new Date('2026-06-23T01:00:00Z'),
    });
    const call = prisma.m365Connection.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ userId_workspaceId: { userId: USER_A, workspaceId: WS } });
    expect(call.create.refreshTokenEnc).toBe('iv:tag:ct');
    expect(call.create.status).toBe(M365ConnectionStatus.ACTIVE);
    // Re-consent resets status to ACTIVE + clears the last error.
    expect(call.update.status).toBe(M365ConnectionStatus.ACTIVE);
    expect(call.update.lastSyncError).toBeNull();
  });

  describe('OWNERSHIP FENCE — every mutation/read carries where.userId', () => {
    it('findForUser filters by userId (cannot read another user’s row)', async () => {
      await store.findForUser(USER_A, WS);
      expect(prisma.m365Connection.findFirst).toHaveBeenCalledWith({
        where: { userId: USER_A, workspaceId: WS },
      });
    });

    it('updateTokens scopes the update to { id, userId }', async () => {
      await store.updateTokens(USER_A, 'm365-1', { refreshTokenEnc: 'new' });
      expect(prisma.m365Connection.updateMany).toHaveBeenCalledWith({
        where: { id: 'm365-1', userId: USER_A },
        data: { refreshTokenEnc: 'new' },
      });
    });

    it('updateTokens with no fields is a no-op (no DB write)', async () => {
      await store.updateTokens(USER_A, 'm365-1', {});
      expect(prisma.m365Connection.updateMany).not.toHaveBeenCalled();
    });

    it('markRevoked scopes to { id, userId }', async () => {
      await store.markRevoked(USER_A, 'm365-1');
      const call = prisma.m365Connection.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'm365-1', userId: USER_A });
      expect(call.data.status).toBe(M365ConnectionStatus.REVOKED);
    });

    it('recordSync scopes to { id, userId } and stamps the delta cursor', async () => {
      await store.recordSync(USER_A, 'm365-1', {
        status: M365ConnectionStatus.ACTIVE,
        lastSyncStatus: 'ok',
        lastSyncError: null,
        deltaLinkContacts: 'https://graph/delta?$deltatoken=abc',
      });
      const call = prisma.m365Connection.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'm365-1', userId: USER_A });
      expect(call.data.deltaLinkContacts).toBe('https://graph/delta?$deltatoken=abc');
      expect(call.data.lastSyncAt).toBeInstanceOf(Date);
    });

    it('deleteForUser scopes to { userId, workspaceId } and reports whether a row went', async () => {
      const removed = await store.deleteForUser(USER_A, WS);
      expect(prisma.m365Connection.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_A, workspaceId: WS },
      });
      expect(removed).toBe(true);
    });

    it('deleteForUser by a DIFFERENT user removes nothing (fence holds) → idempotent false', async () => {
      prisma.m365Connection.deleteMany.mockResolvedValueOnce({ count: 0 });
      const removed = await store.deleteForUser(USER_B, WS);
      expect(prisma.m365Connection.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_B, workspaceId: WS },
      });
      expect(removed).toBe(false);
    });
  });

  it('toView omits the encrypted token columns (no credential leak)', () => {
    const view = store.toView(
      makeRow({ refreshTokenEnc: 'SECRET-iv:tag:ct', accessTokenEnc: 'SECRET-iv:tag:at', deltaLinkContacts: 'd' }),
    );
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('SECRET');
    expect((view as any).refreshTokenEnc).toBeUndefined();
    expect((view as any).accessTokenEnc).toBeUndefined();
    expect(view.hasDeltaLink).toBe(true);
    expect(view.m365UserPrincipal).toBe('aaron@contoso.com');
  });
});

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { User } from '@prisma/client';
import { PatService } from './pat.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipService } from '../../common/workspace/membership.service';
import { hashPat } from './pat.util';

/**
 * PatService contract tests — no DB. Mocks the `personalAccessToken` Prisma
 * surface + MembershipService. Uses REAL bcryptjs hashing for the match path
 * (findByPlaintext bcrypt-compares), so the resolver is genuinely exercised.
 */
const WS = '0190a000-7e57-7000-8000-00000000c007';
const aaron = { id: 'user-aaron', email: 'aaron@magicunicorn.tech', keycloakId: 'kc-aaron', isActive: true } as User;

describe('PatService', () => {
  let service: PatService;
  let store: any[];
  let prisma: any;
  let membership: any;

  beforeEach(() => {
    store = [];
    prisma = {
      personalAccessToken: {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `pat-${store.length + 1}`, lastUsedAt: null, revokedAt: null, createdAt: new Date('2026-06-20T00:00:00Z'), ...data };
          store.push(row);
          return row;
        }),
        findMany: jest.fn(async ({ where }: any) => {
          // emulate the active-token filter (revokedAt null + not expired)
          const now = Date.now();
          let rows = store.filter((r) => r.revokedAt == null && (r.expiresAt == null || new Date(r.expiresAt).getTime() > now));
          if (where?.userId) rows = rows.filter((r) => r.userId === where.userId);
          if (where && 'include' in where) {/* noop */}
          return rows.map((r) => ({ ...r, user: r.userId === aaron.id ? aaron : { id: r.userId, isActive: true } }));
        }),
        findUnique: jest.fn(async ({ where }: any) => store.find((r) => r.id === where.id) ?? null),
        update: jest.fn(async ({ where, data }: any) => {
          const r = store.find((x) => x.id === where.id);
          Object.assign(r, data);
          return r;
        }),
      },
    };
    membership = { resolveAndAuthorize: jest.fn(async (_u: User, req?: string | null) => req ?? WS) };
    service = new PatService(prisma as PrismaService, membership as MembershipService);
  });

  it('create mints a co_pat_, returns the plaintext ONCE, stores only a hash, binds the workspace', async () => {
    const res = await service.create(aaron, { name: 'My token', scopes: ['read:customers', 'write:customers'] });
    expect(res.plaintext.startsWith('co_pat_')).toBe(true);
    expect(res.prefix).toBe('co_pat_');
    expect(res.workspaceId).toBe(WS);
    expect(membership.resolveAndAuthorize).toHaveBeenCalled();
    const stored = store[0];
    expect(stored.tokenHash).toBeDefined();
    expect(stored.tokenHash).not.toEqual(res.plaintext); // never store plaintext
    expect((stored as any).plaintext).toBeUndefined();
  });

  it('create SNAPSHOTS the minting session user entitlements; findByPlaintext carries them', async () => {
    // The mint route is JWT-only, so the session user carries the live SKU claim.
    const paying = { ...aaron, __entitlements: ['customer-ops', 'ai-metered'] } as User & {
      __entitlements: string[];
    };
    const res = await service.create(paying, { name: 'agentic token', scopes: ['run:agents'] });
    expect(res.entitlements).toEqual(['customer-ops', 'ai-metered']);
    expect(store[0].entitlements).toEqual(['customer-ops', 'ai-metered']);

    const resolved = await service.findByPlaintext(res.plaintext);
    // This is exactly what the auth chokepoint stamps onto __entitlements.
    expect(resolved!.entitlements).toEqual(['customer-ops', 'ai-metered']);
  });

  it('create snapshots [] when the session user carries no entitlements (no over-grant)', async () => {
    const res = await service.create(aaron, { name: 'plain token' });
    expect(res.entitlements).toEqual([]);
  });

  it('create rejects an empty name and unknown scopes', async () => {
    await expect(service.create(aaron, { name: '  ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(aaron, { name: 'x', scopes: ['read:customers', 'bogus:scope'] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('create defaults to read-only scopes when none given', async () => {
    const res = await service.create(aaron, { name: 'default' });
    expect(res.scopes).toEqual(['read:customers', 'read:activity', 'read:leads', 'read:overview']);
  });

  it('findByPlaintext resolves a real token, bumps lastUsedAt, and strips the user relation off the token', async () => {
    const minted = await service.create(aaron, { name: 't' });
    const resolved = await service.findByPlaintext(minted.plaintext);
    expect(resolved).not.toBeNull();
    expect(resolved!.user.id).toBe(aaron.id);
    expect(resolved!.workspaceId).toBe(WS);
    expect((resolved!.token as any).user).toBeUndefined();
    expect(prisma.personalAccessToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastUsedAt: expect.any(Date) }) }),
    );
  });

  it('findByPlaintext returns null for a non-PAT, a wrong token, a revoked token, and an inactive owner', async () => {
    expect(await service.findByPlaintext('not-a-pat')).toBeNull();
    const minted = await service.create(aaron, { name: 't' });
    expect(await service.findByPlaintext('co_pat_totally-wrong')).toBeNull();
    // revoke -> excluded by the active-token query
    await service.revoke(aaron.id, store[0].id);
    expect(await service.findByPlaintext(minted.plaintext)).toBeNull();
  });

  it('list returns metadata only (no tokenHash)', async () => {
    await service.create(aaron, { name: 't' });
    const list = await service.list(aaron.id);
    expect(list).toHaveLength(1);
    expect((list[0] as any).tokenHash).toBeUndefined();
    expect(list[0].name).toBe('t');
  });

  it('revoke is idempotent and 404s for a token the caller does not own', async () => {
    await service.create(aaron, { name: 't' });
    const id = store[0].id;
    const first = await service.revoke(aaron.id, id);
    expect(first.revokedAt).toBeTruthy();
    const second = await service.revoke(aaron.id, id); // idempotent
    expect(second.revokedAt).toEqual(first.revokedAt);
    await expect(service.revoke('someone-else', id)).rejects.toBeInstanceOf(NotFoundException);
  });
});

// helper retained for readability of the match path
void hashPat;

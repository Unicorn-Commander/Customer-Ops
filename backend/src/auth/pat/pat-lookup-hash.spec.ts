import { createHash } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { User } from '@prisma/client';
import { PatService } from './pat.service';
import * as patUtil from './pat.util';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipService } from '../../common/workspace/membership.service';

/**
 * CUO-PAT-1: a bad PAT must not bcrypt-scan every active token. No DB — a Prisma
 * mock that honours the lookupHash unique index and the legacy (lookupHash IS
 * NULL) filter, with REAL bcryptjs, and a spy on verifyPat to count rounds.
 */
const WS = '0190a000-7e57-7000-8000-00000000c007';
const owner = { id: 'user-1', email: 'owner@example.com', isActive: true } as User;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function world(opts: { ownerActive?: boolean } = {}) {
  const store: any[] = [];
  const user = { ...owner, isActive: opts.ownerActive ?? true };
  const prisma = {
    personalAccessToken: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `pat-${store.length + 1}`,
          lastUsedAt: null,
          revokedAt: null,
          expiresAt: null,
          createdAt: new Date(),
          lookupHash: null,
          ...data,
        };
        store.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const r = store.find((x) => x.lookupHash === where.lookupHash);
        return r ? { ...r, user } : null;
      }),
      findMany: jest.fn(async ({ where, take }: any) => {
        const now = Date.now();
        const rows = store
          .filter(
            (r) =>
              (where.lookupHash !== null || r.lookupHash == null) &&
              r.revokedAt == null &&
              (r.expiresAt == null || new Date(r.expiresAt).getTime() > now),
          )
          .map((r) => ({ ...r, user }));
        return take ? rows.slice(0, take) : rows;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = store.find((x) => x.id === where.id);
        Object.assign(r, data);
        return r;
      }),
    },
  } as unknown as PrismaService;
  const membership = {
    resolveAndAuthorize: jest.fn(async (_u: User, req?: string | null) => req ?? WS),
  } as unknown as MembershipService;
  const service = new PatService(prisma, membership);
  /** Seed a pre-migration token: bcrypt hash only, lookupHash NULL. */
  const seedLegacy = async (extra: Record<string, unknown> = {}) => {
    const { plaintext, hash } = patUtil.generatePat();
    const row = await (prisma as any).personalAccessToken.create({
      data: {
        userId: owner.id,
        workspaceId: WS,
        name: 'legacy',
        prefix: 'co_pat_',
        tokenHash: await hash,
        scopes: [],
        entitlements: [],
        ...extra,
      },
    });
    return { plaintext, row };
  };
  return { service, store, prisma: prisma as any, seedLegacy };
}

describe('PAT lookupHash (CUO-PAT-1a)', () => {
  let verify: jest.SpyInstance;
  beforeEach(() => {
    verify = jest.spyOn(patUtil, 'verifyPat');
  });
  afterEach(() => verify.mockRestore());

  it('create stores the SHA-256 lookupHash of the plaintext', async () => {
    const { service, store } = world();
    const res = await service.create(owner, { name: 't' });
    expect(store[0].lookupHash).toBe(sha(res.plaintext));
    expect(store[0].lookupHash).not.toBe(store[0].tokenHash);
  });

  it('a new token resolves with exactly one verifyPat call and no scan', async () => {
    const { service, prisma } = world();
    await service.create(owner, { name: 'other-1' });
    await service.create(owner, { name: 'other-2' });
    const res = await service.create(owner, { name: 'mine' });
    verify.mockClear();
    const got = await service.findByPlaintext(res.plaintext);
    expect(got?.token.id).toBe(res.id);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(prisma.personalAccessToken.findMany).not.toHaveBeenCalled();
  });

  it('a garbage prefix token with zero legacy rows costs zero verifyPat calls', async () => {
    const { service } = world();
    await service.create(owner, { name: 'a' });
    await service.create(owner, { name: 'b' });
    verify.mockClear();
    await expect(service.findByPlaintext('co_pat_not-a-real-token')).resolves.toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it('a legacy token resolves, gets its lookupHash set, and the next call is indexed', async () => {
    const { service, store, prisma, seedLegacy } = world();
    await service.create(owner, { name: 'new' });
    const { plaintext, row } = await seedLegacy();
    expect(row.lookupHash).toBeNull();

    const first = await service.findByPlaintext(plaintext);
    expect(first?.token.id).toBe(row.id);
    await new Promise((r) => setImmediate(r)); // fire-and-forget update
    expect(store.find((r) => r.id === row.id).lookupHash).toBe(sha(plaintext));

    prisma.personalAccessToken.findMany.mockClear();
    verify.mockClear();
    const second = await service.findByPlaintext(plaintext);
    expect(second?.token.id).toBe(row.id);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(prisma.personalAccessToken.findMany).not.toHaveBeenCalled();
  });

  it('the legacy scan never touches rows that already have a lookupHash', async () => {
    const { service, seedLegacy } = world();
    await service.create(owner, { name: 'n1' });
    await service.create(owner, { name: 'n2' });
    await seedLegacy();
    verify.mockClear();
    await expect(service.findByPlaintext('co_pat_garbage')).resolves.toBeNull();
    expect(verify).toHaveBeenCalledTimes(1); // only the one legacy row
  });

  describe.each([
    ['indexed', false],
    ['legacy', true],
  ])('%s path still refuses', (_label, legacy) => {
    const mint = async (w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) => {
      if (legacy) return (await w.seedLegacy(extra)).plaintext;
      const res = await w.service.create(owner, { name: 'x' });
      Object.assign(w.store[w.store.length - 1], extra);
      return res.plaintext;
    };

    it('a revoked token', async () => {
      const w = world();
      const t = await mint(w, { revokedAt: new Date() });
      await expect(w.service.findByPlaintext(t)).resolves.toBeNull();
    });
    it('an expired token', async () => {
      const w = world();
      const t = await mint(w, { expiresAt: new Date(Date.now() - 1000) });
      await expect(w.service.findByPlaintext(t)).resolves.toBeNull();
    });
    it('an inactive owner', async () => {
      const w = world({ ownerActive: false });
      const t = await mint(w);
      await expect(w.service.findByPlaintext(t)).resolves.toBeNull();
    });
    it.each([null, '', '   '])('a blank workspace (%p)', async (ws) => {
      const w = world();
      const t = await mint(w, { workspaceId: ws });
      await expect(w.service.findByPlaintext(t)).resolves.toBeNull();
    });
    it('a good token still resolves (control)', async () => {
      const w = world();
      const t = await mint(w);
      await expect(w.service.findByPlaintext(t)).resolves.toMatchObject({ workspaceId: WS });
    });
  });
});

describe('PAT legacy scan cap (CUO-PAT-1b)', () => {
  let verify: jest.SpyInstance;
  beforeEach(() => {
    verify = jest.spyOn(patUtil, 'verifyPat');
  });
  afterEach(() => verify.mockRestore());

  it('asks for at most 50 legacy rows, most recently used first, nulls last', async () => {
    const { service, prisma } = world();
    await service.findByPlaintext('co_pat_garbage');
    const arg = prisma.personalAccessToken.findMany.mock.calls[0][0];
    expect(arg.take).toBe(50);
    expect(arg.orderBy).toEqual({ lastUsedAt: { sort: 'desc', nulls: 'last' } });
    expect(arg.where.lookupHash).toBeNull();
  });

  it('scans no more than 50 rows and WARNs (no token material) when the cap is hit', async () => {
    const w = world();
    // One cheap (cost 4) hash shared by 60 rows keeps the test fast; verifyPat
    // still runs a real bcrypt compare per row.
    const cheap = bcrypt.hashSync('co_pat_someone-elses', 4);
    for (let i = 0; i < 60; i++) {
      // eslint-disable-next-line no-await-in-loop
      await w.seedLegacy({ tokenHash: `${cheap}` });
    }
    const warn = jest.spyOn((w.service as any).logger, 'warn').mockImplementation(() => undefined);
    verify.mockClear();
    await expect(w.service.findByPlaintext('co_pat_garbage')).resolves.toBeNull();
    expect(verify).toHaveBeenCalledTimes(50);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('50');
    expect(msg).not.toContain('garbage');
    expect(msg).not.toContain(sha('co_pat_garbage'));
  });

  it('does not WARN under the cap', async () => {
    const w = world();
    await w.seedLegacy();
    const warn = jest.spyOn((w.service as any).logger, 'warn').mockImplementation(() => undefined);
    await w.service.findByPlaintext('co_pat_garbage');
    expect(warn).not.toHaveBeenCalled();
  });
});

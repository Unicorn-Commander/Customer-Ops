import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipService } from '../../common/workspace/membership.service';
import { WorkspaceContextService } from '../../common/workspace/workspace-context.service';
import { DEFAULT_WORKSPACE_FALLBACK } from '../../common/workspace/workspace.util';
import { PatService } from './pat.service';

/**
 * A BLANK `DEFAULT_WORKSPACE_ID` MUST NOT BRICK A LEGITIMATELY-MINTED PAT.
 *
 * The chokepoint sentinel added for defect 7 refuses any PAT whose `workspaceId`
 * is null OR BLANK — correct, because such a token skips every workspace fence.
 * The earlier analysis justified it with "create() can never produce such a row,
 * MembershipService.resolveAndAuthorize always returns a string". True for NULL.
 * NOT true for a BLANK: `ConfigService.get(key, default)` only applies its
 * default to `undefined`, so an explicitly-empty `DEFAULT_WORKSPACE_ID=` (trivial
 * to produce from a compose file or a templated env) made
 * `bootstrapWorkspaceId` return `''`, `resolveAndAuthorize` return `''`, and
 * `create()` persist `workspaceId: ''`. The user got a `201 Created` with a
 * plaintext token that the sentinel then 401'd on every single request, forever —
 * a token that worked before the branch.
 *
 * Fix: BLANK IS ABSENT at the write side. `bootstrapWorkspaceId` normalises to
 * DEFAULT_WORKSPACE_FALLBACK, and `create()` refuses outright rather than
 * persisting an unbindable binding.
 */

const aaron = {
  id: 'user-aaron',
  email: 'aaron@magicunicorn.tech',
  keycloakId: 'kc-aaron',
  isActive: true,
} as User;

/** ConfigService semantics, faithfully: the default fires ONLY on `undefined`. */
function configWith(env: Record<string, string | undefined>): ConfigService {
  return {
    get: (k: string, d?: unknown) => {
      const v = env[k];
      return v === undefined ? d : v;
    },
  } as unknown as ConfigService;
}

function patWorld(env: Record<string, string | undefined>) {
  const rows: any[] = [];
  const prisma = {
    personalAccessToken: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `pat-${rows.length + 1}`,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
          ...data,
        };
        rows.push(row);
        return row;
      }),
      findMany: jest.fn(async () => rows.map((r) => ({ ...r, user: aaron }))),
      update: jest.fn(async () => undefined),
    },
    membership: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    workspace: { findUnique: jest.fn(async () => null) },
  } as unknown as PrismaService;

  const config = configWith(env);
  // The REAL MembershipService — the blank flows from its bootstrapWorkspaceId.
  const membership = new MembershipService(prisma, config);
  // No resolver injected: this is about the workspace BINDING, not entitlements.
  const pats = new PatService(prisma, membership);
  return { pats, membership, prisma, rows, config };
}

const BLANK_ENV = {
  // Tenancy off (the shipping default) + an explicitly-empty default workspace.
  CUSTOMER_OPS_TENANCY_ENABLED: undefined,
  DEFAULT_WORKSPACE_ID: '',
};

describe('a blank DEFAULT_WORKSPACE_ID is treated as ABSENT', () => {
  it('MembershipService.bootstrapWorkspaceId falls back instead of returning ""', () => {
    const { membership } = patWorld(BLANK_ENV);
    expect(membership.bootstrapWorkspaceId).toBe(DEFAULT_WORKSPACE_FALLBACK);
  });

  it('resolveAndAuthorize (tenancy off) never yields a blank workspace id', async () => {
    const { membership } = patWorld(BLANK_ENV);
    await expect(membership.resolveAndAuthorize(aaron, null)).resolves.toBe(
      DEFAULT_WORKSPACE_FALLBACK,
    );
    // A blank REQUESTED id is likewise absent, not a binding.
    await expect(membership.resolveAndAuthorize(aaron, '   ')).resolves.toBe(
      DEFAULT_WORKSPACE_FALLBACK,
    );
  });

  it('WorkspaceContextService.defaultWorkspaceId falls back too', () => {
    const { prisma, membership, config } = patWorld(BLANK_ENV);
    const ws = new WorkspaceContextService(config, prisma, membership);
    expect(ws.defaultWorkspaceId).toBe(DEFAULT_WORKSPACE_FALLBACK);
  });

  it('a whitespace-only DEFAULT_WORKSPACE_ID is absent as well', () => {
    const { membership } = patWorld({ ...BLANK_ENV, DEFAULT_WORKSPACE_ID: '   ' });
    expect(membership.bootstrapWorkspaceId).toBe(DEFAULT_WORKSPACE_FALLBACK);
  });

  it('an explicitly-set DEFAULT_WORKSPACE_ID is still honoured (no widening)', () => {
    const explicit = '0190a000-7e57-7000-8000-0000000000a1';
    const { membership } = patWorld({ ...BLANK_ENV, DEFAULT_WORKSPACE_ID: explicit });
    expect(membership.bootstrapWorkspaceId).toBe(explicit);
  });
});

describe('PatService.create under a blank DEFAULT_WORKSPACE_ID', () => {
  it('persists a REAL workspace binding — not "" — so the sentinel cannot brick it', async () => {
    const { pats, rows } = patWorld(BLANK_ENV);
    const minted = await pats.create(aaron, { name: 'ci' });

    expect(minted.workspaceId).toBe(DEFAULT_WORKSPACE_FALLBACK);
    expect(rows[0].workspaceId).toBe(DEFAULT_WORKSPACE_FALLBACK);
    // The defect, stated directly: this row must not be blank.
    expect(String(rows[0].workspaceId).trim()).not.toBe('');
  });

  it('the minted token still AUTHENTICATES — the round-trip the blank used to 401 forever', async () => {
    const { pats } = patWorld(BLANK_ENV);
    const minted = await pats.create(aaron, { name: 'ci' });

    const resolved = await pats.findByPlaintext(minted.plaintext);
    expect(resolved).not.toBeNull();
    expect(resolved!.workspaceId).toBe(DEFAULT_WORKSPACE_FALLBACK);
  });

  it('refuses to persist a binding at all if resolution somehow still returns blank', async () => {
    const { prisma, rows } = patWorld(BLANK_ENV);
    // Second line of defence: bypass the normalisation and hand create() a blank
    // directly. Minting a permanently-dead credential with a 201 is worse than
    // a loud, retryable failure.
    const membership = {
      resolveAndAuthorize: jest.fn(async () => ''),
    } as unknown as MembershipService;
    const pats = new PatService(prisma, membership);

    await expect(pats.create(aaron, { name: 'ci' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(rows).toHaveLength(0);
    expect((prisma as any).personalAccessToken.create).not.toHaveBeenCalled();
  });
});

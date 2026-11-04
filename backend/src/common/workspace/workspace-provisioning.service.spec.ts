import { ConflictException } from '@nestjs/common';
import { MembershipStatus, Prisma, User, WorkspaceRole } from '@prisma/client';
import { WorkspaceProvisioningService } from './workspace-provisioning.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MintedWorkspaceId, UcRegistryClient } from '../uc-registry/uc-registry.client';
import { isUuidV7 } from '../uc-registry/uuidv7';

/**
 * WorkspaceProvisioningService is the self-serve onboarding keystone (open
 * signup). It must, atomically: create the User, create the Workspace mirror
 * (id == the uc-registry-minted id), and create an OWNER membership with
 * isDefault=true — keyed by the uchub sub. It runs the external mint OUTSIDE the
 * tx, and surfaces a concurrent-signup race as a ConflictException.
 */
describe('WorkspaceProvisioningService', () => {
  const identity = {
    keycloakId: 'kc-dana-sub',
    email: 'dana@newco.example',
    username: 'dana',
    firstName: 'Dana',
    lastName: 'Scully',
  };

  /** A Prisma fake whose withWorkspace runs the callback with a recording tx. */
  function makePrisma(overrides?: { onUserCreate?: () => any }) {
    const created: Record<string, any[]> = { user: [], workspace: [], membership: [] };
    const tx = {
      user: {
        create: jest.fn(async ({ data }: any) => {
          if (overrides?.onUserCreate) return overrides.onUserCreate();
          const row = { id: 'local-' + data.keycloakId, isActive: true, ...data };
          created.user.push(row);
          return row;
        }),
      },
      workspace: {
        create: jest.fn(async ({ data }: any) => {
          created.workspace.push(data);
          return data;
        }),
      },
      membership: {
        create: jest.fn(async ({ data }: any) => {
          created.membership.push(data);
          return data;
        }),
      },
    };
    const prisma = {
      withWorkspace: jest.fn(async (_ws: string, _uc: string, fn: any) => fn(tx)),
    } as unknown as PrismaService;
    return { prisma, tx, created };
  }

  function makeRegistry(
    minted: MintedWorkspaceId = {
      workspaceId: '0190a000-7e57-7000-8000-00000000d00d',
      source: 'uc-registry',
    },
  ) {
    return {
      mintWorkspaceId: jest.fn(async () => minted),
    } as unknown as UcRegistryClient;
  }

  function makeEntitledPrisma() {
    const workspaces = new Map<string, any>();
    const memberships = new Map<string, any>();
    const tx = {
      workspace: {
        findUnique: jest.fn(async ({ where }: any) => workspaces.get(where.id) ?? null),
        create: jest.fn(async ({ data }: any) => {
          workspaces.set(data.id, data);
          return data;
        }),
      },
      membership: {
        findFirst: jest.fn(async ({ where }: any) => {
          for (const membership of memberships.values()) {
            if (membership.userKey === where.userKey) return membership;
          }
          return null;
        }),
        upsert: jest.fn(async ({ where, update, create }: any) => {
          const key = `${where.userKey_workspaceId.userKey}:${where.userKey_workspaceId.workspaceId}`;
          const existing = memberships.get(key);
          if (existing) {
            const updated = { ...existing, ...update };
            memberships.set(key, updated);
            return updated;
          }
          const created = { ...create };
          memberships.set(key, created);
          return created;
        }),
      },
    };
    const prisma = {
      workspace: {
        findUnique: jest.fn(async ({ where }: any) => workspaces.get(where.id) ?? null),
      },
      withWorkspace: jest.fn(async (_workspaceId: string, _userKey: string, fn: any) => fn(tx)),
    } as unknown as PrismaService;
    return { prisma, tx, workspaces, memberships };
  }

  it('provisions User + Workspace + OWNER membership in one transaction, keyed by sub', async () => {
    const { prisma, tx, created } = makePrisma();
    const registry = makeRegistry();
    const svc = new WorkspaceProvisioningService(prisma, registry);

    const res = await svc.provisionSelfServeUser(identity);

    // The mint ran OUTSIDE the tx (before withWorkspace), with owner attribution.
    expect(registry.mintWorkspaceId).toHaveBeenCalledTimes(1);
    expect((registry.mintWorkspaceId as jest.Mock).mock.calls[0][0]).toMatchObject({
      ownerUcUid: 'kc-dana-sub',
    });

    // withWorkspace addressed the MINTED id + the owner's uc_uid.
    const [wsArg, ucArg] = (prisma.withWorkspace as jest.Mock).mock.calls[0];
    expect(wsArg).toBe('0190a000-7e57-7000-8000-00000000d00d');
    expect(ucArg).toBe('kc-dana-sub');

    // All three rows created.
    expect(tx.user.create).toHaveBeenCalledTimes(1);
    expect(tx.workspace.create).toHaveBeenCalledTimes(1);
    expect(tx.membership.create).toHaveBeenCalledTimes(1);

    // Workspace mirror: id == minted id, slug is url-safe + unique-suffixed.
    expect(created.workspace[0].id).toBe('0190a000-7e57-7000-8000-00000000d00d');
    expect(created.workspace[0].slug).toMatch(/^dana-[0-9a-f]{8}$/);
    expect(created.workspace[0].displayName).toBe("Dana Scully's Workspace");

    // Membership: OWNER, ACTIVE, default, keyed by the uchub sub.
    expect(created.membership[0]).toMatchObject({
      userKey: 'kc-dana-sub',
      workspaceId: '0190a000-7e57-7000-8000-00000000d00d',
      role: WorkspaceRole.OWNER,
      status: MembershipStatus.ACTIVE,
      isDefault: true,
    });

    expect(res.workspaceId).toBe('0190a000-7e57-7000-8000-00000000d00d');
    expect(res.workspaceIdSource).toBe('uc-registry');
    expect(res.user.keycloakId).toBe('kc-dana-sub');
  });

  it('uses the local-fallback id verbatim when uc-registry degraded', async () => {
    const local: MintedWorkspaceId = {
      workspaceId: '0190a000-7e57-7000-8000-0000000000ff',
      source: 'local-fallback',
    };
    const { prisma, created } = makePrisma();
    const registry = makeRegistry(local);
    const svc = new WorkspaceProvisioningService(prisma, registry);

    const res = await svc.provisionSelfServeUser(identity);

    expect(isUuidV7(res.workspaceId)).toBe(true);
    expect(res.workspaceId).toBe(local.workspaceId);
    expect(res.workspaceIdSource).toBe('local-fallback');
    expect(created.workspace[0].id).toBe(local.workspaceId);
  });

  it('derives a sane display name + slug when names are absent', async () => {
    const { prisma, created } = makePrisma();
    const svc = new WorkspaceProvisioningService(prisma, makeRegistry());

    await svc.provisionSelfServeUser({ keycloakId: 'kc-x', email: 'sam.iam+tag@big-co.test' });

    expect(created.workspace[0].displayName).toBe("sam.iam+tag's Workspace");
    // local-part lowercased to [a-z0-9-]; '+' collapsed to '-'.
    expect(created.workspace[0].slug).toMatch(/^sam-iam-tag-[0-9a-f]{8}$/);
  });

  it('translates a unique-violation (concurrent signup) into a ConflictException', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
    });
    const { prisma } = makePrisma({
      onUserCreate: () => {
        throw p2002;
      },
    });
    const svc = new WorkspaceProvisioningService(prisma, makeRegistry());

    await expect(svc.provisionSelfServeUser(identity)).rejects.toThrow(ConflictException);
  });

  it('re-throws a non-unique DB error unchanged', async () => {
    const boom = new Error('connection reset');
    const { prisma } = makePrisma({
      onUserCreate: () => {
        throw boom;
      },
    });
    const svc = new WorkspaceProvisioningService(prisma, makeRegistry());

    await expect(svc.provisionSelfServeUser(identity)).rejects.toThrow('connection reset');
  });

  it('uses the Ops-Center org id for an entitled owner and joins a second user to it', async () => {
    const orgId = '6e40af62-214d-4155-86f1-37dea8bcc53b';
    const { prisma, tx, workspaces } = makeEntitledPrisma();
    const registry = makeRegistry({ workspaceId: orgId, source: 'local-fallback' });
    const svc = new WorkspaceProvisioningService(prisma, registry);
    const owner = {
      id: 'local-owner',
      keycloakId: 'kc-lantern-owner',
      email: 'owner@lantern-harbor.example',
    } as User;
    const member = {
      id: 'local-member',
      keycloakId: 'kc-lantern-member',
      email: 'member@lantern-harbor.example',
    } as User;

    const first = await svc.provisionEntitledOrgWorkspace({
      user: owner,
      orgId,
      orgName: 'Lantern Harbor Advisory',
      role: 'owner',
    });
    const second = await svc.provisionEntitledOrgWorkspace({
      user: member,
      orgId,
      orgName: 'A changed name must not rename the workspace',
      role: 'member',
    });

    expect(first.workspaceId).toBe(orgId);
    expect(second.workspaceId).toBe(orgId);
    expect(first.membership.role).toBe(WorkspaceRole.OWNER);
    expect(second.membership.role).toBe(WorkspaceRole.MEMBER);
    expect(workspaces.get(orgId)).toMatchObject({
      id: orgId,
      displayName: 'Lantern Harbor Advisory',
    });
    expect(registry.mintWorkspaceId).toHaveBeenCalledTimes(1);
    expect(tx.workspace.create).toHaveBeenCalledTimes(1);
  });

  it('keeps the org id when the registry cannot confirm a non-v7 org UUID', async () => {
    const orgId = '6e40af62-214d-4155-86f1-37dea8bcc53b';
    const { prisma, workspaces } = makeEntitledPrisma();
    const registry = makeRegistry({
      workspaceId: '0190a000-7e57-7000-8000-00000000d00d',
      source: 'local-fallback',
    });
    const svc = new WorkspaceProvisioningService(prisma, registry);

    const result = await svc.provisionEntitledOrgWorkspace({
      user: {
        id: 'local-owner',
        keycloakId: 'kc-lantern-owner',
        email: 'owner@lantern-harbor.example',
      } as User,
      orgId,
      role: 'owner',
    });

    expect(result.workspaceId).toBe(orgId);
    expect(result.workspaceIdSource).toBe('local-fallback');
    expect(workspaces.has(orgId)).toBe(true);
  });
});

import { AuditAction, User } from '@prisma/client';
import { AuditService } from './audit.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';

/**
 * AuditService contract tests — no database (the RLS fence itself is proven in
 * the SQL acceptance). The WorkspaceContext GUC chokepoint is faked by running
 * fn(tx) directly against a stateful fake `auditLog` surface. Pins:
 *   - the WRITE goes through the workspace GUC (runInWorkspace), never a bare create;
 *   - a DTO with no workspaceId is SKIPPED (a bare insert would RLS-drop under the
 *     live app role) — returns null, nothing written;
 *   - log() NEVER throws (a failure returns null);
 *   - reads scope through runForUser and return {logs,total}.
 */
const WS = '0190a000-7e57-7000-8000-00000000c007';
const UC_UID = 'kc-aaron-sub';

describe('AuditService', () => {
  let service: AuditService;
  let created: any[];
  let runInWorkspace: jest.Mock;
  let runForUser: jest.Mock;

  beforeEach(() => {
    created = [];
    const tx: any = {
      auditLog: {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `al-${created.length + 1}`, timestamp: new Date('2026-06-20T00:00:00Z'), ...data };
          created.push(row);
          return row;
        }),
        findMany: jest.fn(async () => [...created].reverse()),
        count: jest.fn(async () => created.length),
      },
    };
    runInWorkspace = jest.fn(async (_ws: string, _uc: unknown, fn: any) => fn(tx));
    runForUser = jest.fn(async (_user: unknown, fn: any) => fn(tx));
    const workspaces = { runInWorkspace, runForUser } as unknown as WorkspaceContextService;
    service = new AuditService(workspaces);
  });

  it('writes through the workspace GUC (runInWorkspace) with the right data', async () => {
    const row = await service.log({
      workspaceId: WS,
      userId: UC_UID,
      action: AuditAction.UPDATE,
      resource: 'customer',
      resourceId: 'c-1',
      details: { kind: 'transition', toStage: 'QUALIFIED' },
    });

    expect(runInWorkspace).toHaveBeenCalledWith(WS, UC_UID, expect.any(Function));
    expect(row).toMatchObject({
      workspaceId: WS,
      userId: UC_UID,
      action: 'UPDATE',
      resource: 'customer',
      resourceId: 'c-1',
    });
    expect(created).toHaveLength(1);
  });

  it('SKIPS (returns null, no write) when there is no workspaceId — a bare insert would RLS-drop', async () => {
    const row = await service.log({ action: AuditAction.LOGIN, resource: 'session' });

    expect(row).toBeNull();
    expect(runInWorkspace).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('NEVER throws — a write failure resolves to null', async () => {
    runInWorkspace.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.log({ workspaceId: WS, action: AuditAction.CREATE, resource: 'customer', resourceId: 'c-2' }),
    ).resolves.toBeNull();
  });

  it('findForUser scopes via runForUser and returns {logs,total}', async () => {
    await service.log({ workspaceId: WS, action: AuditAction.CREATE, resource: 'customer', resourceId: 'c-3' });

    const res = await service.findForUser({ id: 'u' } as User, WS, { take: 10 });

    expect(runForUser).toHaveBeenCalled();
    expect(res.total).toBe(1);
    expect(res.logs).toHaveLength(1);
  });
});

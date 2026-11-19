import { ConfigService } from '@nestjs/config';
import { FederationWorkspaceMapService } from './federation-workspace-map.service';

/**
 * R3-2: the FEDERATION_WORKSPACE_MAP_SEED is not a contact-ops writer (only the
 * org-lookup-fenced writers are), and it never overwrites any existing row.
 * Postgres is faked; fictional ids only.
 */
const WS_A = '0190e000-7e57-7000-8000-00000000000a';
const WS_B = '0190e000-7e57-7000-8000-00000000000b';

type Row = { localWorkspaceId: string; targetApp: string; targetWorkspaceId: string };

function setup(seed: unknown, pre: Row[]) {
  const rows = pre.map((r) => ({ ...r }));
  const find = (k: any) =>
    rows.find((r) => r.localWorkspaceId === k.localWorkspaceId && r.targetApp === k.targetApp);
  const fwm = {
    findMany: jest.fn(async () => rows.map((r) => ({ ...r }))),
    findUnique: jest.fn(async ({ where }: any) => find(where.localWorkspaceId_targetApp) ?? null),
    create: jest.fn(async ({ data }: any) => {
      rows.push({ ...data });
      return data;
    }),
    upsert: jest.fn(async ({ where, update, create }: any) => {
      const r = find(where.localWorkspaceId_targetApp);
      if (r) Object.assign(r, update);
      else rows.push({ ...create });
      return r ?? create;
    }),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  const config = {
    get: (k: string) => (k === 'FEDERATION_WORKSPACE_MAP_SEED' ? JSON.stringify(seed) : undefined),
  } as unknown as ConfigService;
  const svc = new FederationWorkspaceMapService({ federationWorkspaceMap: fwm } as any, config);
  return { svc, rows, fwm };
}

describe('FederationWorkspaceMapService seed (R3-2)', () => {
  let svc: FederationWorkspaceMapService | undefined;
  afterEach(() => svc?.onModuleDestroy());

  it('skips every contact-ops entry and never overwrites an existing row', async () => {
    const t = setup(
      {
        [WS_A]: { 'contact-ops': 'seed-contact-a', 'email-ops': 'seed-email-a' },
        [WS_B]: { 'contact-ops': 'seed-contact-b', 'project-ops': 'seed-project-b' },
      },
      [
        { localWorkspaceId: WS_A, targetApp: 'email-ops', targetWorkspaceId: 'kept-email-a' },
        { localWorkspaceId: WS_B, targetApp: 'contact-ops', targetWorkspaceId: 'kept-contact-b' },
      ],
    );
    svc = t.svc;
    await svc.onModuleInit();
    expect(t.rows).toEqual([
      { localWorkspaceId: WS_A, targetApp: 'email-ops', targetWorkspaceId: 'kept-email-a' },
      { localWorkspaceId: WS_B, targetApp: 'contact-ops', targetWorkspaceId: 'kept-contact-b' },
      { localWorkspaceId: WS_B, targetApp: 'project-ops', targetWorkspaceId: 'seed-project-b' },
    ]);
    expect(svc.resolveSync(WS_A, 'contact-ops')).toBeNull();
    expect(svc.resolveSync(WS_B, 'contact-ops')).toBe('kept-contact-b');
  });

  it('is idempotent across restarts', async () => {
    const t = setup({ [WS_A]: { 'email-ops': 'seed-email-a' } }, []);
    svc = t.svc;
    await svc.onModuleInit();
    svc.onModuleDestroy();
    await svc.onModuleInit();
    expect(t.rows).toEqual([
      { localWorkspaceId: WS_A, targetApp: 'email-ops', targetWorkspaceId: 'seed-email-a' },
    ]);
  });
});

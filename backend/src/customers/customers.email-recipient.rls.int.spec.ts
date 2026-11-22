/**
 * AUD-CR-3 cross-org proof on REAL PostgreSQL (the NOBYPASSRLS app role).
 *
 * A provisional lead's recipient comes from its intake row through
 * LeadIntakeService.labels, whose query filters by resolvedContactId only; the
 * workspace fence is RLS (runForUser sets app.current_workspace). This proves
 * the fence holds for that exact read: the same 'prov:' id seeded in two
 * workspaces, each caller gets only its own workspace's address, and a
 * workspace with no intake row for that id gets none.
 *
 * Runs only when CUSTOMER_OPS_RLS_TEST_DATABASE_URL is set (CI sets it).
 * Fictional people and hosts (example.com) only.
 */

import { PrismaClient, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LeadIntakeService } from '../lead-intake/lead-intake.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';

const DB_URL = process.env.CUSTOMER_OPS_RLS_TEST_DATABASE_URL;
const OWNER_URL = process.env.CUSTOMER_OPS_RLS_OWNER_DATABASE_URL || DB_URL;
const describeIfDb = DB_URL ? describe : describe.skip;

const WS_A = '0190a000-7e57-7000-8000-0000000c3a01';
const WS_B = '0190a000-7e57-7000-8000-0000000c3b01';
const WS_EMPTY = '0190a000-7e57-7000-8000-0000000c3e01';
const PROV = 'prov:cr3-cross-org';

describeIfDb('AUD-CR-3 provisional lead email is workspace-fenced (real DB, RLS)', () => {
  let app!: PrismaService;
  let owner!: PrismaClient;
  let leads!: LeadIntakeService;
  const user = { id: 'local-cr3', keycloakId: 'kc-cr3', email: 'rep@example.com' } as User;

  beforeAll(async () => {
    app = new PrismaService({ datasources: { db: { url: DB_URL! } } } as any);
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL! } } });
    await app.$connect();
    await owner.$connect();
    for (const id of [WS_A, WS_B, WS_EMPTY]) {
      await owner.workspace.upsert({
        where: { id },
        update: {},
        create: { id, slug: `cr3-${id.slice(-4)}`, displayName: `CR3 ${id.slice(-4)}` },
      });
    }
    for (const [ws, email] of [
      [WS_A, 'rosa@a.example.com'],
      [WS_B, 'other@b.example.com'],
    ] as const) {
      await owner.leadIntake.create({
        data: {
          workspaceId: ws,
          source: 'manual',
          sourceDedupKey: `cr3-${ws}`,
          status: 'RESOLVED',
          displayName: 'Same Lead Id',
          email,
          resolvedContactId: PROV,
          provisional: true,
        },
      });
    }
    // The workspace choice runForUser makes is the requested id (membership is
    // checked elsewhere); the RLS GUC is what this test exercises.
    const workspaces = {
      runForUser: (_u: User, fn: any, ws?: string | null) => app.withWorkspace(ws!, 'kc-cr3', fn),
    } as unknown as WorkspaceContextService;
    leads = new LeadIntakeService(
      workspaces,
      {} as ContactOpsPort,
      { get: () => undefined } as any,
      {} as any,
    );
  });

  afterAll(async () => {
    try {
      await owner.leadIntake.deleteMany({ where: { workspaceId: { in: [WS_A, WS_B, WS_EMPTY] } } });
      await owner.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B, WS_EMPTY] } } });
    } catch {
      /* best-effort */
    }
    await app?.$disconnect();
    await owner?.$disconnect();
  });

  it('each workspace sees only its own intake email for the same prov: id', async () => {
    const a = await leads.labels(user as any, WS_A, [PROV]);
    const b = await leads.labels(user as any, WS_B, [PROV]);
    expect(a.get(PROV)?.primaryEmail).toBe('rosa@a.example.com');
    expect(b.get(PROV)?.primaryEmail).toBe('other@b.example.com');
  });

  it("a workspace with no intake row for that id gets no address (never another org's)", async () => {
    const none = await leads.labels(user as any, WS_EMPTY, [PROV]);
    expect(none.size).toBe(0);
  });
});

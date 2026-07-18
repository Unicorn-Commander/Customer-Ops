/**
 * Workspace-RBAC proof at the HTTP layer for a newly-gated mutation route.
 *
 * The WorkspaceRoleGuard is unit-tested against a synthetic ExecutionContext in
 * workspace-role.guard.spec.ts; this complements it by booting a MINIMAL Nest
 * app (no DB, no full AppModule) that mounts the REAL LeadIntakeController with
 * the REAL guard, then firing a live HTTP request to prove a VIEWER is 403'd on
 * `POST …/leads/ingest` through the full guard chain — the coverage that the
 * customers/agents controllers had but lead-intake/relations-officer/graph were
 * missing.
 *
 * DB-free: MembershipService is a stub that answers `roleInWorkspace`, and the
 * auth/membership guards are stubbed to inject the acting user + resolved
 * workspace the way JwtAuthGuard/WorkspaceMembershipGuard would. Tenancy is
 * forced ON so the (otherwise inert) role gate actually enforces.
 */

import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { WorkspaceRole } from '@prisma/client';
import { request as httpRequest } from 'http';
import { AddressInfo } from 'net';
import { MembershipService } from '../common/workspace/membership.service';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { WorkspaceRoleGuard } from '../common/workspace/workspace-role.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { LeadIntakeController } from './lead-intake.controller';
import { LeadIntakeService } from './lead-intake.service';

const WORKSPACE_ID = 'ws-under-test';
const FAKE_USER = { id: 'u1', keycloakId: 'kc-viewer', email: 'viewer@example.com' };

/** Stub auth guard: injects the acting user the way JwtAuthGuard would. */
class StubAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest().user = FAKE_USER;
    return true;
  }
}

/** Stub membership guard: stashes the resolved workspace the role guard reads. */
class StubMembershipGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest().workspaceId = WORKSPACE_ID;
    return true;
  }
}

/** POST helper against the booted app; resolves status + raw body. */
function post(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('WorkspaceRoleGuard — VIEWER is blocked on POST /leads/ingest (live request)', () => {
  let app: INestApplication;
  let port: number;
  let role: WorkspaceRole;
  const ingestForUser = jest.fn().mockResolvedValue({ intake: { id: 'i1' }, outcome: 'RESOLVED' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LeadIntakeController],
      providers: [
        WorkspaceRoleGuard,
        { provide: LeadIntakeService, useValue: { ingestForUser } },
        // Answer the role lookup from the mutable `role` — no DB.
        { provide: MembershipService, useValue: { roleInWorkspace: async () => role } },
        // Force tenancy ON so the (otherwise inert) role gate actually enforces.
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === 'CUSTOMER_OPS_TENANCY_ENABLED' ? 'true' : undefined) },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(StubAuthGuard)
      .overrideGuard(WorkspaceMembershipGuard)
      .useClass(StubMembershipGuard)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
  });

  const ingestPath = `/workspaces/${WORKSPACE_ID}/leads/ingest`;
  const validBody = { source: 'test', sourceDedupKey: 'k1', contact: { email: 'lead@example.com' } };

  it('403s a VIEWER before the handler runs', async () => {
    role = WorkspaceRole.VIEWER;
    ingestForUser.mockClear();

    const res = await post(port, ingestPath, validBody);

    expect(res.status).toBe(403);
    // The gate short-circuits: the ingest service is never reached.
    expect(ingestForUser).not.toHaveBeenCalled();
  });

  it('admits a MEMBER (the gate discriminates by role, not a blanket block)', async () => {
    role = WorkspaceRole.MEMBER;
    ingestForUser.mockClear();

    const res = await post(port, ingestPath, validBody);

    expect(res.status).toBeLessThan(400);
    expect(ingestForUser).toHaveBeenCalledTimes(1);
  });
});

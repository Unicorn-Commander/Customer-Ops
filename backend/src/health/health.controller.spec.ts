/**
 * Seam-status and channel-catalog health routes require a workspace member.
 * Liveness (`/health`, `/health/live`, `/health/ready`) stays public.
 *
 * People, firms, and workspace ids in this file are fictional.
 */
import 'reflect-metadata';
import { INestApplication, Injectable } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { HealthCheckService, MemoryHealthIndicator } from '@nestjs/terminus';
import { MembershipStatus } from '@prisma/client';
import { sign } from 'jsonwebtoken';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { REQUIRE_SCOPES_KEY } from '../auth/decorators/require-scopes.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MembershipService } from '../common/workspace/membership.service';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { AccountingOpsPort } from '../accounting-ops/accounting-ops.port';
import { OutreachPort } from '../outreach-ops/outreach-ops.port';
import { EmailOpsPort } from '../email-ops/email-ops.port';
import { ConversationsOpsPort } from '../conversations-ops/conversations-ops.port';
import { MeetingOpsPort } from '../meeting-ops/meeting-ops.port';
import { ProjectOpsPort } from '../project-ops/project-ops.port';
import { M365HealthIndicator } from '../m365/m365.health';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './prisma.health';

const SPEC_JWT_SECRET = 'spec-only-not-a-credential';
const WS = 'ws-example-1';
const MEMBER_KEY = 'usr_casey_north';
const GUEST_KEY = 'usr_river_guest';

@Injectable()
class SpecJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: SPEC_JWT_SECRET,
    });
  }

  validate(payload: { sub: string; workspace_id?: string }) {
    const member = payload.sub === MEMBER_KEY;
    return {
      id: payload.sub,
      email: member ? 'casey.north@example.com' : 'river.guest@example.com',
      keycloakId: payload.sub,
      __workspaceClaim: payload.workspace_id ?? null,
    };
  }
}

function bearer(sub: string): string {
  return sign({ sub, workspace_id: WS }, SPEC_JWT_SECRET, { expiresIn: '10m' });
}

function seamPing(seam: string) {
  return jest.fn(async () => ({
    seam,
    configured: false,
    ok: false,
    status: null,
    detail: 'not-configured',
    latencyMs: null,
  }));
}

describe('health routes auth', () => {
  const pings = {
    contact: seamPing('contact-ops'),
    accounting: seamPing('accounting-ops'),
    outreach: seamPing('outreach'),
    email: seamPing('email-ops'),
    conversations: seamPing('conversations-ops'),
    meeting: seamPing('meeting-ops'),
    project: seamPing('project-ops'),
    m365: seamPing('m365'),
  };

  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const prisma = {
      membership: {
        findFirst: jest.fn(async ({ where }: { where: { userKey: string } }) => {
          // A row already exists, so the allow-list seeder does not run.
          if (where.userKey === MEMBER_KEY || where.userKey === GUEST_KEY) {
            return { userKey: where.userKey };
          }
          return null;
        }),
        findMany: jest.fn(
          async ({ where }: { where: { userKey: string; status?: MembershipStatus } }) => {
            if (where.userKey === MEMBER_KEY && where.status === MembershipStatus.ACTIVE) {
              return [
                {
                  userKey: MEMBER_KEY,
                  workspaceId: WS,
                  status: MembershipStatus.ACTIVE,
                  isDefault: true,
                },
              ];
            }
            return [];
          },
        ),
      },
      workspace: { findUnique: jest.fn(async () => null) },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [HealthController],
      providers: [
        SpecJwtStrategy,
        JwtAuthGuard,
        WorkspaceMembershipGuard,
        MembershipService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'CUSTOMER_OPS_TENANCY_ENABLED') return 'true';
              if (key === 'DEFAULT_WORKSPACE_ID') return WS;
              return undefined;
            },
          },
        },
        {
          provide: HealthCheckService,
          useValue: {
            check: async (fns: Array<() => Promise<Record<string, unknown>>>) => {
              const info: Record<string, unknown> = {};
              for (const fn of fns) Object.assign(info, await fn());
              return { status: 'ok', info, error: {}, details: info };
            },
          },
        },
        {
          provide: MemoryHealthIndicator,
          useValue: {
            checkHeap: async (key: string) => ({ [key]: { status: 'up' } }),
            checkRSS: async (key: string) => ({ [key]: { status: 'up' } }),
          },
        },
        {
          provide: PrismaHealthIndicator,
          useValue: { isHealthy: async (key: string) => ({ [key]: { status: 'up' } }) },
        },
        { provide: ContactOpsPort, useValue: { ping: pings.contact } },
        { provide: AccountingOpsPort, useValue: { ping: pings.accounting } },
        { provide: OutreachPort, useValue: { ping: pings.outreach } },
        {
          provide: EmailOpsPort,
          useValue: { ping: pings.email, isConfigured: () => false },
        },
        {
          provide: ConversationsOpsPort,
          useValue: {
            ping: pings.conversations,
            activation: () => ({
              bridgeConfigured: false,
              liveSendEnabled: false,
              enabledChannels: [],
              liveSendChannels: [],
              workspaceAllowlist: [],
              blockers: [],
            }),
          },
        },
        { provide: MeetingOpsPort, useValue: { ping: pings.meeting } },
        { provide: ProjectOpsPort, useValue: { ping: pings.project } },
        { provide: M365HealthIndicator, useValue: { ping: pings.m365 } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    for (const ping of Object.values(pings)) ping.mockClear();
  });

  function guardsOf(handler: (...args: never[]) => unknown) {
    return Reflect.getMetadata(GUARDS_METADATA, handler);
  }

  it('puts the cockpit guards and read:overview on the two catalog routes only', () => {
    for (const name of ['integrations', 'channels'] as const) {
      const handler = HealthController.prototype[name];
      expect(guardsOf(handler)).toEqual([JwtAuthGuard, WorkspaceMembershipGuard]);
      expect(Reflect.getMetadata(REQUIRE_SCOPES_KEY, handler)).toEqual(['read:overview']);
    }
    for (const name of ['check', 'liveness', 'readiness'] as const) {
      expect(guardsOf(HealthController.prototype[name])).toBeUndefined();
      expect(
        Reflect.getMetadata(REQUIRE_SCOPES_KEY, HealthController.prototype[name]),
      ).toBeUndefined();
    }
  });

  async function get(path: string, token?: string) {
    const res = await fetch(`${base}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  it('returns 401 for integrations and channels with no caller, and does not probe', async () => {
    const integrations = await get('/api/v1/health/integrations');
    const channels = await get('/api/v1/health/channels');
    const garbage = await get('/api/v1/health/integrations', 'not-a-token');

    expect(integrations.status).toBe(401);
    expect(channels.status).toBe(401);
    expect(garbage.status).toBe(401);
    expect(JSON.stringify(integrations.body)).not.toContain('contact-ops');
    expect(JSON.stringify(channels.body)).not.toContain('enterprise-sms');
    for (const ping of Object.values(pings)) expect(ping).not.toHaveBeenCalled();
  });

  it('returns 403 for an authenticated caller who is not an active member', async () => {
    const res = await get('/api/v1/health/integrations', bearer(GUEST_KEY));
    expect(res.status).toBe(403);
    expect(pings.contact).not.toHaveBeenCalled();
  });

  it('returns the seam catalog to an active member', async () => {
    const res = await get('/api/v1/health/integrations', bearer(MEMBER_KEY));
    expect(res.status).toBe(200);
    const body = res.body as { seams: { seam: string }[]; checkedAt: string };
    expect(body.seams.map((row) => row.seam)).toEqual([
      'contact-ops',
      'accounting-ops',
      'outreach',
      'email-ops',
      'conversations-ops',
      'meeting-ops',
      'project-ops',
      'm365',
    ]);
    expect(typeof body.checkedAt).toBe('string');
    for (const ping of Object.values(pings)) expect(ping).toHaveBeenCalledTimes(1);
  });

  it('returns the channel catalog to an active member', async () => {
    const res = await get('/api/v1/health/channels', bearer(MEMBER_KEY));
    expect(res.status).toBe(200);
    const body = res.body as { channels: { id: string }[]; checkedAt: string };
    expect(body.channels.map((row) => row.id)).toEqual([
      'email',
      'imessage',
      'sms',
      'enterprise-sms',
    ]);
    expect(body.checkedAt).toEqual(expect.any(String));
  });

  it('leaves liveness, readiness, and the plain health check public', async () => {
    const live = await get('/api/v1/health/live');
    const ready = await get('/api/v1/health/ready');
    const health = await get('/api/v1/health');

    expect(live.status).toBe(200);
    expect(live.body).toEqual(
      expect.objectContaining({ status: 'ok', timestamp: expect.any(String) }),
    );
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual(expect.objectContaining({ status: 'ok' }));
    expect(health.status).toBe(200);
    expect(health.body).toEqual(expect.objectContaining({ status: 'ok' }));
    for (const ping of Object.values(pings)) expect(ping).not.toHaveBeenCalled();
  });
});

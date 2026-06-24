import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthCheck, HealthCheckService, MemoryHealthIndicator } from '@nestjs/terminus';
import { PrismaHealthIndicator } from './prisma.health';
import { SeamHealth } from './seam-health';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { AccountingOpsPort } from '../accounting-ops/accounting-ops.port';
import { OutreachPort } from '../outreach-ops/outreach-ops.port';
import { EmailOpsPort } from '../email-ops/email-ops.port';
import { ConversationsOpsPort } from '../conversations-ops/conversations-ops.port';
import { MeetingOpsPort } from '../meeting-ops/meeting-ops.port';
import { ProjectOpsPort } from '../project-ops/project-ops.port';
import { M365HealthIndicator } from '../m365/m365.health';

@ApiTags('health')
// Named throttlers ('short' + 'long') require an explicit map in
// @nestjs/throttler v5 — bare @SkipThrottle() is a no-op against named
// throttlers, so probes would 429 once probe + public traffic exceed the limit.
@SkipThrottle({ short: true, long: true })
@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private memory: MemoryHealthIndicator,
    private prismaHealth: PrismaHealthIndicator,
    private contactOps: ContactOpsPort,
    private accountingOps: AccountingOpsPort,
    private outreach: OutreachPort,
    private emailOps: EmailOpsPort,
    private conversationsOps: ConversationsOpsPort,
    private meetingOps: MeetingOpsPort,
    private projectOps: ProjectOpsPort,
    private m365: M365HealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Health check endpoint' })
  @ApiResponse({ status: 200, description: 'Service is healthy' })
  @ApiResponse({ status: 503, description: 'Service is unhealthy' })
  check() {
    return this.health.check([
      () => this.prismaHealth.isHealthy('database'),
      () => this.memory.checkHeap('memory_heap', 200 * 1024 * 1024), // 200MB
      () => this.memory.checkRSS('memory_rss', 400 * 1024 * 1024), // 400MB
    ]);
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiResponse({ status: 200, description: 'Service is live' })
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe' })
  @ApiResponse({ status: 200, description: 'Service is ready' })
  @ApiResponse({ status: 503, description: 'Service is not ready' })
  readiness() {
    return this.health.check([() => this.prismaHealth.isHealthy('database')]);
  }

  /**
   * Per-seam federation health. Probes EACH of the 6 sibling-app seams with a
   * lightweight, side-effect-free MCP `tools/list` (via the same transport/auth a
   * real read uses) so a SILENT auth failure (a 401/403 that otherwise hides
   * behind a degrade-clean empty panel) becomes visible, PLUS the `m365` connector
   * seam (configuration-only — its target is Microsoft Graph, not a UC seam).
   * Unauthenticated like the other `/health` routes — it exposes only seam up/down
   * + a short probe detail, never tenant data. Each `ping()` never throws, so this
   * always returns 200.
   */
  @Get('integrations')
  @ApiOperation({ summary: 'Federation seam health (per sibling-app integration)' })
  @ApiResponse({ status: 200, description: 'Per-seam probe results' })
  async integrations(): Promise<{ seams: SeamHealth[]; checkedAt: string }> {
    const seams = await Promise.all([
      this.contactOps.ping(),
      this.accountingOps.ping(),
      this.outreach.ping(),
      this.emailOps.ping(),
      this.conversationsOps.ping(),
      this.meetingOps.ping(),
      this.projectOps.ping(),
      this.m365.ping(),
    ]);
    return { seams, checkedAt: new Date().toISOString() };
  }
}

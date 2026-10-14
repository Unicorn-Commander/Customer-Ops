import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { ChannelStatusRow } from '../conversations-ops/conversations-ops.types';

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
    private config: ConfigService,
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

  /**
   * Omnichannel channel-status matrix (email + SMS + iMessage + enterprise SMS).
   * Unauthenticated like other `/health` routes — never includes secrets or tenant
   * data. Marketing pages and ops runbooks key "live / dogfood / coming" labels from
   * this payload; the static source of truth is `docs/CHANNEL-STATUS.md`.
   *
   * Runtime flags influence dogfood posture; production live claims require explicit
   * CHANNEL_*_PROD_ENABLED=true (never implied by dogfood bridge config alone).
   */
  @Get('channels')
  @ApiOperation({
    summary: 'Omnichannel messaging status matrix (email / SMS / iMessage) for marketing + ops',
  })
  @ApiResponse({ status: 200, description: 'Channel status rows' })
  channels(): {
    channels: ChannelStatusRow[];
    checkedAt: string;
    docs: string;
    rolloutOrder: string[];
  } {
    const emailConfigured = this.emailOps.isConfigured();
    const emailProd =
      this.config.get<string>('CHANNEL_EMAIL_PROD_ENABLED')?.trim().toLowerCase() === 'true';
    const act = this.conversationsOps.activation();
    const smsEnabled = act.enabledChannels.includes('SMS');
    const imsgEnabled = act.enabledChannels.includes('iMessage');
    const smsLive = act.liveSendEnabled && act.liveSendChannels.includes('SMS');
    const imsgLive = act.liveSendEnabled && act.liveSendChannels.includes('iMessage');
    const smsProd =
      this.config.get<string>('CHANNEL_SMS_PROD_ENABLED')?.trim().toLowerCase() === 'true' &&
      smsLive;
    const imsgProd =
      this.config.get<string>('CHANNEL_IMESSAGE_PROD_ENABLED')?.trim().toLowerCase() === 'true' &&
      imsgLive;
    // Enterprise Twilio SMS lives in Email-Ops; Customer-Ops does not federate it yet.
    const enterpriseTwilioConfigured = !!(
      this.config.get<string>('TWILIO_ACCOUNT_SID')?.trim() &&
      this.config.get<string>('TWILIO_AUTH_TOKEN')?.trim()
    );
    // Note: Twilio env is Email-Ops-side; CO typically won't have it. Matrix still
    // documents the lane so marketing does not conflate device SMS with shared-line.

    const marketing = (
      built: boolean,
      dogfood: boolean,
      prod: boolean,
    ): ChannelStatusRow['marketingLabel'] => {
      if (prod) return 'live';
      if (dogfood) return 'dogfood';
      if (built) return 'coming';
      return 'coming';
    };

    const channels: ChannelStatusRow[] = [
      {
        id: 'email',
        label: 'Email',
        built: true,
        enabledDogfood: emailConfigured,
        enabledProd: emailProd,
        dryRunDefault: false,
        marketingLabel: marketing(true, emailConfigured, emailProd),
        provider: 'Email-Ops → Apache James / Postmark',
        blockers: emailConfigured
          ? emailProd
            ? []
            : ['CHANNEL_EMAIL_PROD_ENABLED not set — dogfood/configured only']
          : ['EMAIL_OPS_BASE_URL unset'],
        notes: 'Mailbox threads + send/draft; agent-inbox approval path.',
      },
      {
        id: 'imessage',
        label: 'iMessage',
        built: true,
        enabledDogfood: act.bridgeConfigured && imsgEnabled,
        enabledProd: imsgProd,
        dryRunDefault: !imsgLive,
        marketingLabel: marketing(true, act.bridgeConfigured && imsgEnabled, imsgProd),
        provider: 'Device Messages.app via UUDC (CONVERSATIONS_OPS_*)',
        blockers: [
          ...(!act.bridgeConfigured
            ? ['Device bridge not configured (CONVERSATIONS_OPS_BASE_URL + mTLS materials)']
            : []),
          ...(!imsgEnabled ? ['iMessage not in CONVERSATIONS_OPS_CHANNELS'] : []),
          ...(!imsgLive
            ? [
                'CONVERSATIONS_OPS_LIVE_SEND_ENABLED≠true — dry-run only (Aaron checkpoint before live dogfood sends)',
              ]
            : []),
          ...(!imsgProd ? ['CHANNEL_IMESSAGE_PROD_ENABLED≠true — no production claim'] : []),
          'Requires signed-in Apple ID + continuous UUDC device/relay availability',
        ],
        notes:
          'Worker-device channel. Reads when bridge configured; live send needs explicit flags + Aaron checkpoint.',
      },
      {
        id: 'sms',
        label: 'SMS (device / Continuity)',
        built: true,
        enabledDogfood: act.bridgeConfigured && smsEnabled,
        enabledProd: smsProd,
        dryRunDefault: !smsLive,
        marketingLabel: marketing(true, act.bridgeConfigured && smsEnabled, smsProd),
        provider: 'Device Messages.app SMS-via-Continuity via UUDC',
        blockers: [
          ...(!act.bridgeConfigured
            ? ['Device bridge not configured (CONVERSATIONS_OPS_BASE_URL + mTLS materials)']
            : []),
          ...(!smsEnabled ? ['SMS not in CONVERSATIONS_OPS_CHANNELS'] : []),
          ...(!smsLive
            ? [
                'CONVERSATIONS_OPS_LIVE_SEND_ENABLED≠true — dry-run only (Aaron checkpoint before live dogfood sends)',
              ]
            : []),
          ...(!smsProd ? ['CHANNEL_SMS_PROD_ENABLED≠true — no production claim'] : []),
          'Device SMS depends on iPhone Continuity / Personal Hotspot path via UUDC',
        ],
        notes: 'Worker-device SMS. Distinct from enterprise shared-line SMS (Email-Ops/Twilio).',
      },
      {
        id: 'enterprise-sms',
        label: 'SMS (enterprise shared line)',
        built: true,
        enabledDogfood: enterpriseTwilioConfigured,
        enabledProd: false,
        dryRunDefault: true,
        marketingLabel: marketing(true, enterpriseTwilioConfigured, false),
        provider: 'Email-Ops → Twilio (SmsAccount / compose_sms)',
        blockers: [
          'Not yet federated into Customer-Ops customer-360 (lives in Email-Ops engine)',
          ...(enterpriseTwilioConfigured
            ? []
            : ['TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN unset on Email-Ops']),
          'Requires Twilio number provisioned as SmsAccount per workspace',
          'Aaron checkpoint before any customer-visible Twilio send',
        ],
        notes:
          'Built in Email-Ops with full governance (kill switch, autonomy, agent-inbox). CO federation is a follow-on track.',
      },
    ];

    return {
      channels,
      checkedAt: new Date().toISOString(),
      docs: 'docs/CHANNEL-STATUS.md',
      rolloutOrder: [
        '1. email (already production-grade when EMAIL_OPS connected)',
        '2. device iMessage+SMS reads in dogfood (bridge + workspace allowlist)',
        '3. device dry-run sends in dogfood (default)',
        '4. device live sends in dogfood after Aaron checkpoint (LIVE_SEND_ENABLED)',
        '5. enterprise Twilio SMS federation into CO cockpit (follow-on)',
        '6. production CHANNEL_*_PROD_ENABLED only after dogfood E2E proven',
      ],
    };
  }
}

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { QuotesRenderModule } from './quotes-render/quotes-render.module';
import { quotesEnabled } from './quotes/quotes-enabled';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { RedisService } from './common/redis/redis.service';
import { SecurityStoreModule } from './common/security/security-store.module';
import { WorkspaceModule } from './common/workspace/workspace.module';
import { FederationAuthModule } from './common/federation/federation-auth.module';
import { ObservabilityModule } from './common/observability/observability.module';
import { RequestContextMiddleware } from './common/observability/request-context.middleware';
import { AllExceptionsFilter } from './common/observability/all-exceptions.filter';
import { RequestLoggingInterceptor } from './common/observability/request-logging.interceptor';
import { FriendlyThrottlerGuard } from './common/security/friendly-throttler.guard';
import { buildThrottlers } from './common/security/throttler.config';
import { RedisThrottlerStorage } from './common/security/redis-throttler.storage';
import { ReconciliationSchedulerModule } from './common/scheduler/reconciliation-scheduler.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { McpModule } from './mcp/mcp.module';
import { ContactOpsModule } from './contact-ops/contact-ops.module';
import { AccountingOpsModule } from './accounting-ops/accounting-ops.module';
import { OutreachOpsModule } from './outreach-ops/outreach-ops.module';
import { EmailOpsModule } from './email-ops/email-ops.module';
import { ConversationsOpsModule } from './conversations-ops/conversations-ops.module';
import { MeetingOpsModule } from './meeting-ops/meeting-ops.module';
import { ProjectOpsModule } from './project-ops/project-ops.module';
import { AgentInferenceModule } from './agents/inference/agent-inference.module';
import { AgentsModule } from './agents/agents.module';
import { RelationsOfficerModule } from './relations-officer/relations-officer.module';
import { CustomersModule } from './customers/customers.module';
import { OverviewModule } from './overview/overview.module';
import { AuditModule } from './audit/audit.module';
import { WorkspaceAdminModule } from './common/workspace/workspace-admin.module';
import { LeadIntakeModule } from './lead-intake/lead-intake.module';
import { GraphModule } from './graph/graph.module';
import { GdprModule } from './gdpr/gdpr.module';
import { M365Module } from './m365/m365.module';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { FederationWorkspaceMapModule } from './common/federation/federation-workspace-map.module';
import { EntitlementsInterceptor } from './entitlements/entitlements.interceptor';

@Module({
  imports: [
    // Configuration — global, sourced from .env.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Register renderer routes only when quote drafts are enabled. The M1
    // public source fails closed until persisted sharing arrives in M2.
    QuotesRenderModule.register(quotesEnabled(process.env.QUOTES_ENABLED)),

    // Rate limiting — named throttlers ('short' burst + 'long' sustained),
    // env-tunable via RATE_LIMIT_* with defaults == the prior hard-coded values
    // (see common/security/throttler.config). Async so it can read ConfigService.
    // When REDIS_URL is set the counter is SHARED across replicas (a Redis
    // fixed-window store) instead of per-process; without it, the stock in-memory
    // store (unchanged single-replica behavior).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, RedisService],
      useFactory: (config: ConfigService, redis: RedisService) => {
        const throttlers = buildThrottlers(config);
        return redis.enabled
          ? { throttlers, storage: new RedisThrottlerStorage(redis) }
          : throttlers;
      },
    }),

    // Core
    // The shared Redis plane (global; degrade-clean without REDIS_URL). Imported
    // before ThrottlerModule so RedisService resolves in the throttler factory.
    RedisModule,
    // The shared single-use / pending-action security stores (global).
    SecurityStoreModule,
    PrismaModule,
    WorkspaceModule,
    // Cross-cutting error-tracking hook (degrade-clean; no-op without SENTRY_DSN).
    ObservabilityModule,
    // Shared app-to-app federation credential (Brigade RFC-8693 token source).
    FederationAuthModule,
    AuthModule,
    // Entitlements source: the EntitlementsInterceptor stamps endpoint-sourced
    // SKUs onto the request after auth (dormant until ENTITLEMENTS_ENDPOINT_URL).
    EntitlementsModule,
    // Per-workspace federation target map (multi-tenant-safe; replaces the
    // global *_WORKSPACE_OVERRIDE envs). @Global so every *-ops client injects it.
    FederationWorkspaceMapModule,
    HealthModule,
    // Phase 2 — the relationship cockpit + the Contact-Ops federation seam.
    ContactOpsModule,
    // Phase 3 — the invoicing surface (the Accounting-Ops AR federation seam).
    AccountingOpsModule,
    // Phase 4 — the Outreach + Email surfaces (the Outreach + Email-Ops app seams).
    OutreachOpsModule,
    EmailOpsModule,
    // The omni-channel conversation surface — first channel: the worker's device
    // (iMessage + SMS) via the UUDC `messages.*` bridge. DORMANT without
    // CONVERSATIONS_OPS_BASE_URL.
    ConversationsOpsModule,
    // Phase 5 — the Meeting-Ops signal seam + the 4-lane inference port.
    MeetingOpsModule,
    // The Project-Ops delivery/projects federation seam (customer-360 projects).
    ProjectOpsModule,
    AgentInferenceModule,
    // Phase 6 — the lead-ingestion front door (the `ingest_lead` keystone).
    // Registered before CustomersModule so its LeadLabelResolver is available
    // for the provisional cockpit-label fallback.
    LeadIntakeModule,
    CustomersModule,
    // The system audit trail (append-only audit_logs): the relationship write
    // paths record who/what/when via AuditService; also mounts the workspace-
    // scoped read surface. After CustomersModule (which writes through it).
    AuditModule,
    // The workspace settings surface (identity + member roster + owner-gated
    // member management). After AuditModule — it audits membership mutations.
    WorkspaceAdminModule,
    // The command-center OVERVIEW surface: workspace-wide rollups of the local
    // invoice/outreach/email link tables (read-only; reuses the RLS chokepoint +
    // the Contact-Ops batch name-resolution). After CustomersModule — it reads the
    // same link tables the cockpit writes.
    OverviewModule,
    // The per-workspace FalkorDB knowledge graph (degrade-clean; DORMANT without
    // FALKORDB_URL). After CustomersModule — the ingest/query phases compose the
    // relationship + federation data this module already wires.
    GraphModule,
    // The GDPR data-lifecycle surface: right-to-erasure + portability export +
    // workspace offboarding + the flag-gated dormant-record retention sweep.
    // After GraphModule — it uses GraphIngestService for the FalkorDB cleanup and
    // AuditModule for the DELETE/EXPORT trail.
    GdprModule,
    // The Microsoft 365 (Graph) connector — a signed-in user links their own M365
    // account and pulls contacts INTO the cockpit through the lead-intake funnel.
    // DORMANT without M365_CLIENT_ID. After LeadIntakeModule — it funnels through it.
    M365Module,
    // Phase 5 — the relationship agents (compose the federation ports + inference).
    AgentsModule,
    // The Relations Officer — the conversational orchestrator (advisor + operator
    // modes) over the cockpit's reads + the 4 confirm-gated relationship writes.
    RelationsOfficerModule,
    // MCP last so it can consume the cockpit tools + the agents.
    McpModule,
    // The background maintenance loop — runs lead-reconciliation / invoice-refresh
    // / graph-repair per workspace on an interval (flag-gated OFF by default via
    // RECONCILE_SCHEDULER_ENABLED). After the feature modules it composes.
    ReconciliationSchedulerModule,
  ],
  providers: [
    // Rate limiting globally via the friendly guard (same limiting as the stock
    // ThrottlerGuard; humane 429 message).
    {
      provide: APP_GUARD,
      useClass: FriendlyThrottlerGuard,
    },
    // Every error leaves the API as one RFC-7807 problem+json body.
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    // One PII-safe structured access line per request (probes excluded).
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor,
    },
    // After auth, re-source req.user.__entitlements from the Ops-Center
    // entitlements endpoint (feeds the dual-SKU federation gates). No-op when
    // ENTITLEMENTS_ENDPOINT_URL is unset — the token claim stays the source.
    {
      provide: APP_INTERCEPTOR,
      useClass: EntitlementsInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  /**
   * Stamp every request with a correlation id BEFORE guards/pipes/throttler run,
   * so even a 401/403/429 carries an `X-Request-Id`. Applied to all routes.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

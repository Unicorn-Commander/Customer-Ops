import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { PrismaModule } from './prisma/prisma.module';
import { WorkspaceModule } from './common/workspace/workspace.module';
import { FederationAuthModule } from './common/federation/federation-auth.module';
import { ObservabilityModule } from './common/observability/observability.module';
import { RequestContextMiddleware } from './common/observability/request-context.middleware';
import { AllExceptionsFilter } from './common/observability/all-exceptions.filter';
import { RequestLoggingInterceptor } from './common/observability/request-logging.interceptor';
import { FriendlyThrottlerGuard } from './common/security/friendly-throttler.guard';
import { buildThrottlers } from './common/security/throttler.config';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { McpModule } from './mcp/mcp.module';
import { ContactOpsModule } from './contact-ops/contact-ops.module';
import { AccountingOpsModule } from './accounting-ops/accounting-ops.module';
import { OutreachOpsModule } from './outreach-ops/outreach-ops.module';
import { EmailOpsModule } from './email-ops/email-ops.module';
import { MeetingOpsModule } from './meeting-ops/meeting-ops.module';
import { ProjectOpsModule } from './project-ops/project-ops.module';
import { AgentInferenceModule } from './agents/inference/agent-inference.module';
import { AgentsModule } from './agents/agents.module';
import { RelationsOfficerModule } from './relations-officer/relations-officer.module';
import { CustomersModule } from './customers/customers.module';
import { OverviewModule } from './overview/overview.module';
import { LeadIntakeModule } from './lead-intake/lead-intake.module';
import { GraphModule } from './graph/graph.module';

@Module({
  imports: [
    // Configuration — global, sourced from .env.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Rate limiting — named throttlers ('short' burst + 'long' sustained),
    // env-tunable via RATE_LIMIT_* with defaults == the prior hard-coded values
    // (see common/security/throttler.config). Async so it can read ConfigService.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => buildThrottlers(config),
    }),

    // Core
    PrismaModule,
    WorkspaceModule,
    // Cross-cutting error-tracking hook (degrade-clean; no-op without SENTRY_DSN).
    ObservabilityModule,
    // Shared app-to-app federation credential (Brigade RFC-8693 token source).
    FederationAuthModule,
    AuthModule,
    HealthModule,
    // Phase 2 — the relationship cockpit + the Contact-Ops federation seam.
    ContactOpsModule,
    // Phase 3 — the invoicing surface (the Accounting-Ops AR federation seam).
    AccountingOpsModule,
    // Phase 4 — the Outreach + Email surfaces (the Outreach + Email-Ops app seams).
    OutreachOpsModule,
    EmailOpsModule,
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
    // The command-center OVERVIEW surface: workspace-wide rollups of the local
    // invoice/outreach/email link tables (read-only; reuses the RLS chokepoint +
    // the Contact-Ops batch name-resolution). After CustomersModule — it reads the
    // same link tables the cockpit writes.
    OverviewModule,
    // The per-workspace FalkorDB knowledge graph (degrade-clean; DORMANT without
    // FALKORDB_URL). After CustomersModule — the ingest/query phases compose the
    // relationship + federation data this module already wires.
    GraphModule,
    // Phase 5 — the relationship agents (compose the federation ports + inference).
    AgentsModule,
    // The Relations Officer — the conversational orchestrator (advisor + operator
    // modes) over the cockpit's reads + the 4 confirm-gated relationship writes.
    RelationsOfficerModule,
    // MCP last so it can consume the cockpit tools + the agents.
    McpModule,
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

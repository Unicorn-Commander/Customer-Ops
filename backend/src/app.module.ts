import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import { PrismaModule } from './prisma/prisma.module';
import { WorkspaceModule } from './common/workspace/workspace.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { McpModule } from './mcp/mcp.module';
import { ContactOpsModule } from './contact-ops/contact-ops.module';
import { AccountingOpsModule } from './accounting-ops/accounting-ops.module';
import { OutreachOpsModule } from './outreach-ops/outreach-ops.module';
import { EmailOpsModule } from './email-ops/email-ops.module';
import { MeetingOpsModule } from './meeting-ops/meeting-ops.module';
import { AgentInferenceModule } from './agents/inference/agent-inference.module';
import { AgentsModule } from './agents/agents.module';
import { CustomersModule } from './customers/customers.module';
import { LeadIntakeModule } from './lead-intake/lead-intake.module';

@Module({
  imports: [
    // Configuration — global, sourced from .env.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Rate limiting — named throttlers for different security levels.
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 60000, limit: 20 },
      { name: 'long', ttl: 3600000, limit: 200 },
    ]),

    // Core
    PrismaModule,
    WorkspaceModule,
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
    AgentInferenceModule,
    // Phase 6 — the lead-ingestion front door (the `ingest_lead` keystone).
    // Registered before CustomersModule so its LeadLabelResolver is available
    // for the provisional cockpit-label fallback.
    LeadIntakeModule,
    CustomersModule,
    // Phase 5 — the relationship agents (compose the federation ports + inference).
    AgentsModule,
    // MCP last so it can consume the cockpit tools + the agents.
    McpModule,
  ],
  providers: [
    // Rate limiting globally via guard.
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}

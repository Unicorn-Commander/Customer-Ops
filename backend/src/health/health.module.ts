import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './prisma.health';
import { ContactOpsModule } from '../contact-ops/contact-ops.module';
import { AccountingOpsModule } from '../accounting-ops/accounting-ops.module';
import { OutreachOpsModule } from '../outreach-ops/outreach-ops.module';
import { EmailOpsModule } from '../email-ops/email-ops.module';
import { MeetingOpsModule } from '../meeting-ops/meeting-ops.module';
import { ProjectOpsModule } from '../project-ops/project-ops.module';

@Module({
  // Each ops module EXPORTS its federation port; importing them lets the
  // HealthController inject the 6 ports for the `/health/integrations` probe.
  imports: [
    TerminusModule,
    ContactOpsModule,
    AccountingOpsModule,
    OutreachOpsModule,
    EmailOpsModule,
    MeetingOpsModule,
    ProjectOpsModule,
  ],
  controllers: [HealthController],
  providers: [PrismaHealthIndicator],
})
export class HealthModule {}

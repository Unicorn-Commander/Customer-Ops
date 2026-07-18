import { Module } from '@nestjs/common';
import { LeadIntakeModule } from '../../lead-intake/lead-intake.module';
import { CustomersModule } from '../../customers/customers.module';
import { GraphModule } from '../../graph/graph.module';
import { ReconciliationSchedulerService } from './reconciliation-scheduler.service';

/**
 * The background reconciliation scheduler. Composes the three services whose
 * reconcile/refresh/repair jobs it runs on an interval (LeadIntakeService,
 * CustomersService, GraphIngestService) — each already exported by its module.
 * PrismaService (workspace enumeration) + ConfigService are global.
 *
 * The scheduler is flag-gated OFF by default; importing this module is inert
 * until RECONCILE_SCHEDULER_ENABLED=true.
 */
@Module({
  imports: [LeadIntakeModule, CustomersModule, GraphModule],
  providers: [ReconciliationSchedulerService],
})
export class ReconciliationSchedulerModule {}

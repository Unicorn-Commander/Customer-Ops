import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { AuthModule } from '../auth/auth.module';
import { CustomersModule } from '../customers/customers.module';
import { AgentInferenceModule } from '../agents/inference/agent-inference.module';
import { RelationsOfficerService } from './relations-officer.service';
import { RelationsOfficerController } from './relations-officer.controller';

/**
 * The Relations Officer module — the cockpit's CONVERSATIONAL orchestrator.
 *
 * Wires the RelationsOfficerService (persona + grounding + the advisor/operator
 * modes + the single-use confirm-gated write pattern) and its REST surface. It
 * REUSES the existing relationship logic + inference seam rather than forking any:
 *   - CustomersModule  — the exported CustomersService: the customer-360 / pipeline
 *     READS for grounding, and the 4 relationship WRITES (transitionForUser /
 *     addNoteForUser / markLostForUser / reopenForUser) the operator executes on
 *     confirm (each already audits via a customer activity). The ONLY writes it can
 *     do; no invoice/email/send/charge path exists here.
 *   - AgentInferenceModule — the 4-lane inference port (entitlement/metering-gated;
 *     mockable; degrade-clean when the gateway is unconfigured).
 *   - WorkspaceModule  — the GUC chokepoint + membership guard (RLS tenancy + RBAC),
 *     and the workspace resolver used to bind/verify a pending action's workspace.
 *   - AuthModule       — the JwtAuthGuard for the workspace-scoped routes.
 *
 * The service's pending-action store is the shared PendingActionStore
 * (SecurityStoreModule, global): Redis-backed when REDIS_URL is set (a pending
 * confirm survives a restart + works across replicas, consumed atomically via
 * GETDEL) and an in-process TTL map otherwise (single replica).
 */
@Module({
  imports: [WorkspaceModule, AuthModule, CustomersModule, AgentInferenceModule],
  providers: [RelationsOfficerService],
  controllers: [RelationsOfficerController],
  exports: [RelationsOfficerService],
})
export class RelationsOfficerModule {}

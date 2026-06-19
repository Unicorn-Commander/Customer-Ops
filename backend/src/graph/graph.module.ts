import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { ContactOpsModule } from '../contact-ops/contact-ops.module';
import { AccountingOpsModule } from '../accounting-ops/accounting-ops.module';
import { OutreachOpsModule } from '../outreach-ops/outreach-ops.module';
import { EmailOpsModule } from '../email-ops/email-ops.module';
import { MeetingOpsModule } from '../meeting-ops/meeting-ops.module';
import { FalkorDbService } from './falkordb.service';
import { GraphService } from './graph.service';
import { GraphIngestService } from './graph-ingest.service';
import { GraphController } from './graph.controller';

/**
 * The knowledge-graph module — the per-workspace FalkorDB relationship graph.
 *
 * Owns the FalkorDB connection lifecycle (FalkorDbService) + the injection-safe
 * write primitives + read surface (GraphService) + the ingest/backfill
 * (GraphIngestService), and exposes the workspace-scoped read/reindex routes
 * (GraphController). The graph KEY is always derived via graphKeyFor from the
 * membership-resolved workspace — never a raw client value.
 *
 * Dependencies (mirrors CustomersModule, since the graph reads the same
 * relationship data + federates the same sources):
 *   - ConfigModule       — FALKORDB_URL read (global, imported defensively).
 *   - AuthModule         — JwtAuthGuard strategy for the workspace-scoped routes.
 *   - WorkspaceModule    — WorkspaceMembershipGuard (authz) + WorkspaceContextService
 *                          (the RLS GUC chokepoint used by ingest's reads).
 *   - Contact/Accounting/Outreach/Email/Meeting-OpsModule — the 5 federation ports
 *     the ingest enriches the graph from (best-effort, degrade-clean). PrismaService
 *     injects globally (PrismaModule is @Global).
 *
 * DEGRADE-CLEAN: nothing here hard-requires FalkorDB. With FALKORDB_URL unset the
 * service boots DORMANT, reads 503 (frontend falls back to its DB-derived graph),
 * and ingest no-ops.
 */
@Module({
  imports: [
    ConfigModule,
    AuthModule,
    WorkspaceModule,
    ContactOpsModule,
    AccountingOpsModule,
    OutreachOpsModule,
    EmailOpsModule,
    MeetingOpsModule,
  ],
  providers: [FalkorDbService, GraphService, GraphIngestService],
  controllers: [GraphController],
  exports: [GraphService, GraphIngestService],
})
export class GraphModule {}

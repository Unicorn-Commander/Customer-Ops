/**
 * The knowledge-graph read surface — the relationship cockpit's data plane.
 *
 * Mounted under the workspace-scoped path `…/workspaces/:workspaceId/graph`
 * (SUITE-IDENTITY §D4 addressing precedence: path → header → claim). Both the
 * JwtAuthGuard (authn) and the WorkspaceMembershipGuard (authz: membership-gated
 * when tenancy is live; no-op today) apply, exactly like CustomersController. The
 * membership guard resolves + stashes the effective workspace on `req.workspaceId`;
 * we derive the FalkorDB graph key from THAT via graphKeyFor — NEVER from a raw
 * client-supplied value — so the per-workspace fence can't be bypassed by a
 * hand-built path param.
 *
 * DEGRADE-CLEAN: when FalkorDB is dormant the GraphService reads throw
 * ServiceUnavailableException; we let it surface as a 503 (no catch) and the
 * frontend falls back to its DB-derived relationship graph.
 *
 * The reindex/ingest route is deliberately NOT here — it needs the ingest service
 * and is wired separately in integration.
 */

import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireScopes } from '../auth/decorators/require-scopes.decorator';
import { RequireWorkspaceRole } from '../auth/decorators/require-workspace-role.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { WorkspaceRoleGuard } from '../common/workspace/workspace-role.guard';
import { graphKeyFor } from './graph-key';
import { GraphService } from './graph.service';
import { GraphIngestService } from './graph-ingest.service';
import {
  NEIGHBORHOOD_DEFAULT_DEPTH,
  NEIGHBORHOOD_DEFAULT_LIMIT,
  NeighborhoodQueryDto,
} from './dto/graph-query.dto';
import { GraphDataDTO, NodeDetailDTO } from './graph.types';

@ApiTags('graph')
@ApiBearerAuth()
// authn → membership authz → role RBAC. GET reads stay VIEWER-level; the
// reindex backfill mutates the graph, so it requires MEMBER.
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard, WorkspaceRoleGuard)
@Controller('workspaces/:workspaceId/graph')
export class GraphController {
  constructor(
    private readonly graph: GraphService,
    private readonly ingest: GraphIngestService,
  ) {}

  @Post('reindex')
  @ApiOperation({
    summary:
      "Rebuild this workspace's knowledge graph from local relationship data + " +
      'federated sources (idempotent backfill). Membership-gated; no-op (0/0) when ' +
      'the graph is dormant.',
  })
  @RequireScopes('write:customers')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  async reindex(@Req() req: Request): Promise<{ nodes: number; edges: number }> {
    return this.ingest.backfillWorkspace(workspaceIdOf(req));
  }

  @Get()
  @ApiOperation({
    summary:
      'The top-level relationship constellation: the workspace Hub + connected ' +
      'orgs (≤10) + top people (≤28), from the persisted knowledge graph. 503 ' +
      'when the graph is dormant (frontend falls back to its DB-derived graph).',
  })
  @RequireScopes('read:customers')
  async workspaceGraph(@Req() req: Request): Promise<GraphDataDTO> {
    return this.graph.getWorkspaceGraph(graphKeyFor(workspaceIdOf(req)));
  }

  @Get('nodes/:nodeKey/neighborhood')
  @ApiOperation({
    summary:
      "Expand a node's 1..depth neighborhood (depth≤3, limit≤200) for the " +
      'cockpit click-to-expand. 503 when the graph is dormant.',
  })
  @RequireScopes('read:customers')
  async neighborhood(
    @Req() req: Request,
    @Param('nodeKey') nodeKey: string,
    @Query() query: NeighborhoodQueryDto,
  ): Promise<GraphDataDTO> {
    return this.graph.getNeighborhood(
      graphKeyFor(workspaceIdOf(req)),
      nodeKey,
      query.depth ?? NEIGHBORHOOD_DEFAULT_DEPTH,
      query.limit ?? NEIGHBORHOOD_DEFAULT_LIMIT,
    );
  }

  @Get('nodes/:nodeKey')
  @ApiOperation({
    summary:
      'Aggregate detail for one node (org: people/pipeline/last-touch; person: ' +
      'interactions/last-touch; hub: workspace rollup). 503 when dormant.',
  })
  @RequireScopes('read:customers')
  async nodeDetail(@Req() req: Request, @Param('nodeKey') nodeKey: string): Promise<NodeDetailDTO> {
    return this.graph.getNodeDetail(graphKeyFor(workspaceIdOf(req)), nodeKey);
  }
}

/**
 * The membership-resolved workspace id the guard stashed on the request. We read
 * it from `req.workspaceId` (NOT the raw path param) so the graph key is built
 * from the authorized workspace — the same chokepoint discipline the customers
 * service uses for the RLS GUC.
 */
function workspaceIdOf(req: Request): string {
  const resolved = (req as Request & { workspaceId?: string }).workspaceId;
  if (typeof resolved === 'string' && resolved) return resolved;
  // Defensive: the guard always sets this. If it's somehow absent, fail closed
  // (graphKeyFor would also throw on an empty id, but be explicit here).
  throw new Error('workspaceId was not resolved by the membership guard');
}

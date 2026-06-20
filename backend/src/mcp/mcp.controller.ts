/**
 * Streamable HTTP transport endpoint for the Customer-Ops MCP server.
 *
 * Brigade (and any MCP client) sends POST/GET/DELETE on /api/v1/mcp. We
 * authenticate via JWT, mint a per-request MCP server scoped to the user, and
 * let the SDK transport handle the protocol framing. Stateless: each request is
 * its own session (Brigade re-authenticates per call).
 */

import { All, Controller, Logger, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireScopes } from '../auth/decorators/require-scopes.decorator';
import { McpService } from './mcp.service';
import { PersonalAccessToken, User } from '@prisma/client';

@ApiTags('mcp')
@ApiBearerAuth()
// MCP is the most expensive + most attacker-interesting surface: a `co_pat_`-
// prefixed bearer triggers the O(n) bcrypt scan in PatService BEFORE auth
// succeeds, so an unlimited endpoint is a pre-auth CPU-exhaustion vector. Rather
// than blanket-@SkipThrottle (the prior posture), apply an MCP-appropriate
// per-IP cap — generous for a busy agent, but a hard ceiling on a bcrypt flood.
@Throttle({ short: { limit: 60, ttl: 60_000 }, long: { limit: 1000, ttl: 3_600_000 } })
// A PAT may drive MCP; the route admits any authenticated PAT and the per-tool
// scope gate (MCP_TOOL_SCOPE_MAP) enforces least-privilege inside the dispatch.
@RequireScopes()
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(private readonly mcp: McpService) {}

  @All()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'MCP Streamable HTTP endpoint. Auth as a Customer-Ops user; agent acts on their behalf.',
  })
  async handle(@Req() req: Request, @Res() res: Response) {
    const user = req.user as User | undefined;
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    // When the caller authenticated with a PAT, pass its granted scopes + bound
    // workspace into the server so the per-tool gate enforces least-privilege.
    // A JWT/federation caller has no `req.pat` → null scopes → full RBAC.
    const pat = (req as Request & { pat?: PersonalAccessToken }).pat;
    const grantedScopes = pat ? pat.scopes : null;
    const patWorkspaceId = pat ? pat.workspaceId : null;

    // Lazy require: the SDK ships dual CJS/ESM; resolve only when MCP is called.
    const sdk = require('@modelcontextprotocol/sdk/server/streamableHttp.js'); // eslint-disable-line @typescript-eslint/no-var-requires
    const StreamableHTTPServerTransport = sdk.StreamableHTTPServerTransport;

    const transport = new StreamableHTTPServerTransport({
      // Stateless — no session ID assignment, MCP clients send their own.
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close().catch(() => undefined);
    });

    try {
      const server = await this.mcp.createServerForUser(user, grantedScopes, patWorkspaceId);
      await server.connect(transport);
      // body has already been parsed by express.json — pass it through.
      await transport.handleRequest(req, res, (req as any).body);
    } catch (err) {
      this.logger.error(`MCP request failed (user=${user.email}): ${(err as Error).message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'mcp_internal_error' });
      }
    }
  }
}

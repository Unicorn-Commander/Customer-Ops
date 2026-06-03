/**
 * Builds a per-request MCP server scoped to one authenticated user.
 *
 * Brigade (or any MCP client) opens a Streamable HTTP session against
 * /api/v1/mcp. For each request we mint a fresh McpServer + transport, register
 * the Customer-Ops tool set, and let the SDK handle the protocol. The user is
 * captured by closure on the tool handlers, so all data access runs with their
 * identity / membership and inside the RLS transaction (via CustomersService).
 */

import { Injectable, Logger } from '@nestjs/common';
import { User } from '@prisma/client';
import { z } from 'zod';
import { MembershipService } from '../common/workspace/membership.service';
import { CustomersService } from '../customers/customers.service';
import { CustomerOpsTools } from './mcp.tools';

// The funnel stages, as a zod enum for tool input validation.
const STAGE = z.enum(['LEAD', 'PROSPECT', 'CUSTOMER']);

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  constructor(
    private readonly membership: MembershipService,
    private readonly customers: CustomersService,
  ) {}

  /**
   * Build a fresh MCP server bound to one authenticated user. Returns the
   * server instance; the caller connects a transport to it. The SDK is imported
   * lazily so we pay the resolve cost only when MCP is actually called.
   */
  async createServerForUser(user: User) {
    // Lazy require: the SDK ships dual CJS/ESM; resolve only when MCP is called.
    const sdk = require('@modelcontextprotocol/sdk/server/mcp.js'); // eslint-disable-line @typescript-eslint/no-var-requires
    const McpServer = sdk.McpServer;

    const server = new McpServer(
      {
        name: 'customer-ops',
        version: '0.2.0',
      },
      {
        capabilities: { tools: {} },
        instructions:
          'Customer-Ops MCP server. Foundation tools check service health and ' +
          'list the caller’s workspaces. Cockpit tools drive the relationship ' +
          'funnel: list relationships by stage, read a customer-360 (the local ' +
          'relationship + the FEDERATED Contact-Ops contact), view the pipeline ' +
          'board, move a relationship through the funnel, and add timeline notes. ' +
          'Contacts are federated from Contact-Ops, never copied.',
      },
    );

    const tools = new CustomerOpsTools(this.membership, this.customers);

    // ── Foundation tools ──

    server.registerTool(
      'health',
      {
        title: 'Customer-Ops health',
        description:
          'Liveness + configuration check. Returns service status, whether ' +
          'suite tenancy is enabled, and the server time.',
        inputSchema: {},
      },
      async () => wrap(tools.health()),
    );

    server.registerTool(
      'list_my_workspaces',
      {
        title: 'List my workspaces',
        description:
          'Return the workspaces the calling user is an active member of, with ' +
          'their canonical suite role and which one is the default. Empty when ' +
          'the user has no membership.',
        inputSchema: {
          _ack: z.boolean().optional(),
        },
      },
      async () => wrap(await tools.listMyWorkspaces(user)),
    );

    // ── Phase 2 cockpit tools ──

    server.registerTool(
      'list_customers',
      {
        title: 'List relationships',
        description:
          'List the workspace’s customer relationships, optionally filtered by ' +
          'funnel stage, owner, or lost-status. Each row carries the FEDERATED ' +
          'contact summary (resolved from Contact-Ops, never copied).',
        inputSchema: {
          workspace_id: z.string().optional(),
          stage: STAGE.optional(),
          owner_user_key: z.string().optional(),
          include_lost: z.boolean().optional(),
          with_contacts: z.boolean().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
      },
      async (args: any) => wrap(await tools.listCustomers(user, args ?? {})),
    );

    server.registerTool(
      'get_customer_360',
      {
        title: 'Customer 360',
        description:
          'The full relationship view: the local relationship + lifecycle stage ' +
          '+ activity timeline, plus the FEDERATED Contact-Ops contact detail. ' +
          'Invoice/meeting/email slots are present but Phase-3 (empty for now).',
        inputSchema: {
          customer_id: z.string(),
          workspace_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.getCustomer360(user, args)),
    );

    server.registerTool(
      'pipeline_board',
      {
        title: 'Pipeline board',
        description:
          'The kanban pipeline: every non-lost relationship bucketed by funnel ' +
          'stage (lead/prospect/customer), with per-lane counts + summed ' +
          'expected value, and the federated contact label on each card.',
        inputSchema: {
          workspace_id: z.string().optional(),
          with_contacts: z.boolean().optional(),
        },
      },
      async (args: any) => wrap(await tools.pipelineBoard(user, args ?? {})),
    );

    server.registerTool(
      'transition_customer_stage',
      {
        title: 'Move relationship stage',
        description:
          'Move a relationship to a new funnel stage. Funnel rules are enforced: ' +
          'forward one step at a time (no skipping qualification); backward moves ' +
          'allowed. Writes an activity-log entry in the same transaction.',
        inputSchema: {
          customer_id: z.string(),
          to_stage: STAGE,
          note: z.string().max(2000).optional(),
          workspace_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.transitionStage(user, args)),
    );

    server.registerTool(
      'add_customer_note',
      {
        title: 'Add relationship note',
        description: 'Append a freeform note to a relationship’s activity timeline.',
        inputSchema: {
          customer_id: z.string(),
          body: z.string().min(1).max(4000),
          workspace_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.addNote(user, args)),
    );

    return server;
  }
}

function wrap(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

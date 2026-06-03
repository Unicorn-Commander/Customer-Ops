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
// Phase-4 engagement signals + email send mode, as zod enums.
const ENGAGEMENT = z.enum(['opened', 'clicked', 'replied', 'bounced', 'unsubscribed']);
const EMAIL_MODE = z.enum(['send', 'draft']);

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
        version: '0.3.0',
      },
      {
        capabilities: { tools: {} },
        instructions:
          'Customer-Ops MCP server. Foundation tools check service health and ' +
          'list the caller’s workspaces. Cockpit tools drive the relationship ' +
          'funnel: list relationships by stage, read a customer-360 (the local ' +
          'relationship + the FEDERATED Contact-Ops contact + Accounting-Ops ' +
          'invoices + Outreach campaigns/touches + Email-Ops threads), view the ' +
          'pipeline board, move a relationship through the funnel, and add ' +
          'timeline notes. Invoicing tools federate to Accounting-Ops (the AR ' +
          'engine / ledger). Outreach tools federate to the Outreach app ' +
          '(Listmonk + Postiz): list campaigns/touches, start a campaign. Email ' +
          'tools federate to the Email-Ops app (Stalwart): list mailbox threads, ' +
          'send/draft an email. The engagement tool advances the funnel stage on ' +
          'an inbound reply/click. Everything (contacts, invoices, campaigns, ' +
          'mail) is federated from its owning app at read time, never copied.',
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
          '+ activity timeline, plus the FEDERATED Contact-Ops contact detail and ' +
          'the FEDERATED Accounting-Ops invoice panel (live status). Meeting/email ' +
          'slots are present but later-phase (empty for now).',
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

    // ── Phase 3 invoicing tools (federate to Accounting-Ops) ──

    server.registerTool(
      'list_customer_invoices',
      {
        title: 'List customer invoices',
        description:
          'This customer’s invoices, FEDERATED from Accounting-Ops (the AR engine ' +
          '/ ledger system-of-record) with live status polled. The result reports ' +
          'degrade-clean / entitlement affordances (configured, entitled, ' +
          'canCreate) — Accounting-Ops must be connected and the workspace must ' +
          'carry both customer-ops and accounting-ops entitlements to create.',
        inputSchema: {
          customer_id: z.string(),
          workspace_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.listCustomerInvoices(user, args)),
    );

    server.registerTool(
      'create_customer_invoice',
      {
        title: 'Create customer invoice',
        description:
          'Assemble a draft from this customer and create the invoice in ' +
          'Accounting-Ops (the ledger SoR). Idempotent on a deterministic ' +
          'external_ref derived from the optional idempotency_key (a retry with ' +
          'the same key returns the same invoice). Requires BOTH customer-ops and ' +
          'accounting-ops entitlements. Money fields are decimal STRINGS (never ' +
          'float). Does NOT post a ledger entry locally — Accounting-Ops does.',
        inputSchema: {
          customer_id: z.string(),
          workspace_id: z.string().optional(),
          entity_id: z.string(),
          customer_name: z.string().min(1).max(300),
          customer_email: z.string().max(320).optional(),
          billing_address: z.string().max(2000).optional(),
          line_items: z
            .array(
              z.object({
                description: z.string().min(1).max(1000),
                quantity: z.string().optional(),
                unit_price: z.string().optional(),
                amount: z.string().optional(),
                tax_code: z.string().max(64).optional(),
                tax_amount: z.string().optional(),
                revenue_account_id: z.string().max(64).optional(),
                source_ref: z.string().max(256).optional(),
              }),
            )
            .min(1),
          currency: z.string().max(8).optional(),
          issue_date: z.string().optional(),
          due_date: z.string().optional(),
          net_terms: z.number().int().min(0).max(3650).optional(),
          discount: z.string().optional(),
          notes: z.string().max(4000).optional(),
          po_number: z.string().max(128).optional(),
          auto_send: z.boolean().optional(),
          idempotency_key: z.string().max(200).optional(),
        },
      },
      async (args: any) => wrap(await tools.createCustomerInvoice(user, args)),
    );

    // ── Phase 4 outreach tools (federate to the Outreach app) ──

    server.registerTool(
      'list_customer_outreach',
      {
        title: 'List customer outreach',
        description:
          'This customer’s outreach, FEDERATED from the Outreach app (Listmonk ' +
          'campaigns + Postiz social): the live campaigns available to enroll into, ' +
          'the live touch history for the contact, and the local enrollment links. ' +
          'Reports degrade-clean / entitlement affordances (configured, entitled, ' +
          'canStart) — Outreach must be connected and the workspace must carry both ' +
          'customer-ops and outreach entitlements to start a campaign.',
        inputSchema: {
          customer_id: z.string(),
          workspace_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.listCustomerOutreach(user, args)),
    );

    server.registerTool(
      'start_customer_campaign',
      {
        title: 'Start customer campaign',
        description:
          'Enroll this customer’s contact into an Outreach campaign/sequence ' +
          '(Listmonk email or a multi-step sequence). Idempotent on a deterministic ' +
          'external_ref derived from the optional idempotency_key (a retry with the ' +
          'same key returns the same enrollment, queues no second send). Requires ' +
          'BOTH customer-ops and outreach entitlements. The Outreach app owns the ' +
          'campaign + every send — Customer-Ops only records a thin link.',
        inputSchema: {
          customer_id: z.string(),
          workspace_id: z.string().optional(),
          campaign_id: z.string(),
          contact_email: z.string().max(320).optional(),
          merge_fields: z.record(z.string()).optional(),
          idempotency_key: z.string().max(200).optional(),
        },
      },
      async (args: any) => wrap(await tools.startCustomerCampaign(user, args)),
    );

    // ── Phase 4 email tools (federate to the Email-Ops app) ──

    server.registerTool(
      'list_customer_email',
      {
        title: 'List customer email',
        description:
          'This customer’s email, FEDERATED from the Email-Ops app (the Stalwart ' +
          'mailbox surface): the live mailbox threads with the contact + the local ' +
          'outbound links. Reports degrade-clean / entitlement affordances ' +
          '(configured, entitled, canSend). Reading threads is viewer-level; sending ' +
          'requires both customer-ops and email-ops entitlements.',
        inputSchema: {
          customer_id: z.string(),
          workspace_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.listCustomerEmail(user, args)),
    );

    server.registerTool(
      'send_customer_email',
      {
        title: 'Send customer email',
        description:
          'Send or draft an outbound email to this customer’s contact via the ' +
          'Email-Ops app. mode=send queues delivery now; mode=draft stages the ' +
          'agent-inbox approval surface (the safe default for an agent — a human ' +
          'approves before it leaves). Idempotent on a deterministic external_ref. ' +
          'Requires BOTH customer-ops and email-ops entitlements. The Email-Ops app ' +
          'owns the mailbox + message — Customer-Ops stores no message body.',
        inputSchema: {
          customer_id: z.string(),
          workspace_id: z.string().optional(),
          to_address: z.string().max(320).optional(),
          subject: z.string().min(1).max(500),
          body: z.string().min(1).max(50000),
          in_reply_to_thread_id: z.string().max(200).optional(),
          mode: EMAIL_MODE.optional(),
          idempotency_key: z.string().max(200).optional(),
        },
      },
      async (args: any) => wrap(await tools.sendCustomerEmail(user, args)),
    );

    // ── Phase 4 engagement → stage hook ──

    server.registerTool(
      'record_customer_engagement',
      {
        title: 'Record customer engagement',
        description:
          'Record an inbound engagement signal on a customer (a reply/click/open ' +
          'from Outreach or Email-Ops, or a bounce) and advance the funnel stage when ' +
          'it warrants it: a reply or click advances exactly one step (never skipping ' +
          'qualification); an open is recorded but does not advance; a bounce/' +
          'unsubscribe never advances. Logs the stage change + the engagement ' +
          'provenance in one transaction.',
        inputSchema: {
          customer_id: z.string(),
          workspace_id: z.string().optional(),
          kind: ENGAGEMENT,
          source: z.enum(['outreach', 'email-ops']).optional(),
          external_ref: z.string().max(200).optional(),
          detail: z.string().max(2000).optional(),
        },
      },
      async (args: any) => wrap(await tools.recordCustomerEngagement(user, args)),
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

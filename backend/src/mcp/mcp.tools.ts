/**
 * Tool implementations for the Customer-Ops MCP server.
 *
 * Each tool runs as the *calling user*: the controller pulls the user out of
 * the JWT and passes it in. Phase 1 foundation tools:
 *   - health              — liveness + tenancy-flag visibility (no auth scope).
 *   - list_my_workspaces  — the caller's active workspaces (membership-gated),
 *                           identical shape to the REST `GET /auth/me/workspaces`.
 *
 * Phase 2 cockpit tools (the relationship surface for agents — lead-triage,
 * follow-up drafter, collections-nudge all build on these). They DELEGATE to the
 * same CustomersService the REST surface uses, so an agent and a human hit one
 * implementation, one set of funnel rules, one RLS path:
 *   - list_customers      — relationships filtered by stage/priority/owner.
 *   - get_customer_360    — relationship + timeline + FEDERATED contact + invoices.
 *   - pipeline_board      — relationships bucketed by funnel stage.
 *   - transition_customer_stage — move a relationship through the funnel.
 *   - add_customer_note   — append a note to the relationship timeline.
 *
 * Phase 3 invoicing tools (the AR surface for agents — collections-nudge reads
 * status here). Same delegation: AO is the ledger SoR, federated over MCP:
 *   - list_customer_invoices   — this customer's invoices + live AO status (poll).
 *   - create_customer_invoice  — assemble a draft + create it in Accounting-Ops
 *                                (idempotent; dual-SKU entitlement-gated).
 *
 * Contact details are FEDERATED from Contact-Ops, invoices from Accounting-Ops,
 * at read time — never copied.
 */

import { User } from '@prisma/client';
import { RelationshipStage } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { listMyWorkspaces, MyWorkspace } from '../common/workspace/list-my-workspaces';
import { tenancyEnabled } from '../common/workspace/feature-flags';
import { CustomersService } from '../customers/customers.service';
import { CreateInvoiceDto } from '../customers/dto/customer.dto';

export class CustomerOpsTools {
  constructor(
    private readonly membership: MembershipService,
    private readonly customers: CustomersService,
  ) {}

  /** Health/info — safe for any authenticated caller. */
  health(): { status: string; service: string; tenancyEnabled: boolean; time: string } {
    return {
      status: 'ok',
      service: 'customer-ops',
      tenancyEnabled: tenancyEnabled(),
      time: new Date().toISOString(),
    };
  }

  /** The caller's active workspaces (membership-gated; empty when none). */
  async listMyWorkspaces(user: User): Promise<{ workspaces: MyWorkspace[]; count: number }> {
    const workspaces = await listMyWorkspaces(this.membership, user);
    return { workspaces, count: workspaces.length };
  }

  // ── Phase 2 cockpit tools (delegate to CustomersService) ──

  async listCustomers(
    user: User,
    args: {
      workspace_id?: string;
      stage?: RelationshipStage;
      owner_user_key?: string;
      include_lost?: boolean;
      with_contacts?: boolean;
      limit?: number;
    },
  ) {
    return this.customers.listForUser(
      user,
      {
        stage: args.stage,
        ownerUserKey: args.owner_user_key,
        includeLost: args.include_lost,
        withContacts: args.with_contacts ?? true,
        limit: args.limit,
      },
      args.workspace_id ?? null,
    );
  }

  async getCustomer360(user: User, args: { customer_id: string; workspace_id?: string }) {
    return this.customers.customer360ForUser(user, args.customer_id, args.workspace_id ?? null);
  }

  async pipelineBoard(user: User, args: { workspace_id?: string; with_contacts?: boolean }) {
    return this.customers.pipelineForUser(
      user,
      args.workspace_id ?? null,
      args.with_contacts ?? true,
    );
  }

  async transitionStage(
    user: User,
    args: {
      customer_id: string;
      to_stage: RelationshipStage;
      note?: string;
      workspace_id?: string;
    },
  ) {
    return this.customers.transitionForUser(
      user,
      args.customer_id,
      { toStage: args.to_stage, note: args.note },
      args.workspace_id ?? null,
    );
  }

  async addNote(user: User, args: { customer_id: string; body: string; workspace_id?: string }) {
    return this.customers.addNoteForUser(
      user,
      args.customer_id,
      { body: args.body },
      args.workspace_id ?? null,
    );
  }

  // ── Phase 3 invoicing tools (delegate to CustomersService → Accounting-Ops) ──

  /** This customer's invoices + live AO status. Degrade-clean / entitlement
   *  affordances are in the result (configured/entitled/canCreate). */
  async listCustomerInvoices(user: User, args: { customer_id: string; workspace_id?: string }) {
    return this.customers.invoicesForUser(user, args.customer_id, args.workspace_id ?? null);
  }

  /** Assemble a draft + create the invoice in Accounting-Ops (idempotent on the
   *  deterministic external_ref; requires customer-ops + accounting-ops). The
   *  args mirror CreateInvoiceDto so the agent and the REST caller hit one path. */
  async createCustomerInvoice(
    user: User,
    args: {
      customer_id: string;
      workspace_id?: string;
      entity_id: string;
      customer_name: string;
      customer_email?: string;
      billing_address?: string;
      line_items: Array<{
        description: string;
        quantity?: string;
        unit_price?: string;
        amount?: string;
        tax_code?: string;
        tax_amount?: string;
        revenue_account_id?: string;
        source_ref?: string;
      }>;
      currency?: string;
      issue_date?: string;
      due_date?: string;
      net_terms?: number;
      discount?: string;
      notes?: string;
      po_number?: string;
      auto_send?: boolean;
      idempotency_key?: string;
    },
  ) {
    const dto: CreateInvoiceDto = {
      entityId: args.entity_id,
      customerName: args.customer_name,
      customerEmail: args.customer_email,
      billingAddress: args.billing_address,
      lineItems: (args.line_items ?? []).map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unit_price,
        amount: li.amount,
        taxCode: li.tax_code,
        taxAmount: li.tax_amount,
        revenueAccountId: li.revenue_account_id,
        sourceRef: li.source_ref,
      })),
      currency: args.currency,
      issueDate: args.issue_date,
      dueDate: args.due_date,
      netTerms: args.net_terms,
      discount: args.discount,
      notes: args.notes,
      poNumber: args.po_number,
      autoSend: args.auto_send,
      idempotencyKey: args.idempotency_key,
    };
    return this.customers.createInvoiceForUser(
      user,
      args.customer_id,
      dto,
      args.workspace_id ?? null,
    );
  }
}

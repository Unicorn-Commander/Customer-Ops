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
 *   - get_customer_360    — relationship + timeline + FEDERATED contact.
 *   - pipeline_board      — relationships bucketed by funnel stage.
 *   - transition_customer_stage — move a relationship through the funnel.
 *   - add_customer_note   — append a note to the relationship timeline.
 *
 * Contact details are FEDERATED from Contact-Ops at read time — never copied.
 */

import { User } from '@prisma/client';
import { RelationshipStage } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { listMyWorkspaces, MyWorkspace } from '../common/workspace/list-my-workspaces';
import { tenancyEnabled } from '../common/workspace/feature-flags';
import { CustomersService } from '../customers/customers.service';

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
}

/**
 * Tool implementations for the Customer-Ops MCP server (Phase 1 skeleton).
 *
 * Each tool runs as the *calling user*: the controller pulls the user out of
 * the JWT and passes it in. Phase 1 exposes only the foundation tools:
 *   - health              — liveness + tenancy-flag visibility (no auth scope).
 *   - list_my_workspaces  — the caller's active workspaces (membership-gated),
 *                           identical shape to the REST `GET /auth/me/workspaces`.
 *
 * The relationship/CRM tools (lead triage, stage transitions, the contact 360,
 * invoicing surface) are Phase 2+; the structure is left ready for them.
 */

import { User } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { listMyWorkspaces, MyWorkspace } from '../common/workspace/list-my-workspaces';
import { tenancyEnabled } from '../common/workspace/feature-flags';

export class CustomerOpsTools {
  constructor(private readonly membership: MembershipService) {}

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
}

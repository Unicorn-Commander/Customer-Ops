import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { PrismaService, WorkspaceTxClient } from '../../prisma/prisma.service';
import { MembershipService } from './membership.service';
import {
  defaultWorkspaceId as defaultWorkspaceIdFromEnv,
  entitlementsOf,
  intersectEntitlements,
  parseWorkspaceEntitlements,
  resolveWorkspaceId,
  ucUidOf,
  WithWorkspaceClaim,
} from './workspace.util';
import { WorkspaceEntitlementsResolver } from './workspace-entitlements.resolver';

/**
 * Injectable wrapper around the workspace resolution seam, for services and
 * the REST layer. See workspace.util.ts for the full rationale.
 *
 * This is the app-layer half of the GUC chokepoint: the workspace id it
 * resolves (claim → default, gated by membership when tenancy is on) is the
 * exact value fed into PrismaService.withWorkspace, so the DB Row Level
 * Security GUC is always whatever this service decided. The columns, indices,
 * and RLS policies are already workspace-ready; this is the ONE place app-layer
 * resolution meets the database fence.
 */
@Injectable()
export class WorkspaceContextService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly membership: MembershipService,
    /**
     * The server-side, per-workspace entitlement resolver (operator pin ->
     * endpoint -> durable mirror, with a bounded cache). @Optional so unit tests
     * that only need the workspace/GUC seam can construct this service with the
     * original three deps; when absent we fall back to the pre-resolver
     * behaviour (read `Workspace.entitlementCache` directly).
     *
     * With the resolver PRESENT this lane is not literally the same code as
     * before — it gains the endpoint/mirror layers. What it does keep is the
     * property that mattered: NO added staleness. `workspaceEntitlements` passes
     * `maxAgeMs: 0`, so the operator pin is re-read per request exactly as it was.
     * On a node with no server-side source the resolver answers `null` and the
     * observable behaviour is identical.
     */
    @Optional()
    private readonly entitlementsResolver?: WorkspaceEntitlementsResolver,
  ) {}

  /**
   * Max staleness this (JWT/session) lane accepts from the resolver's in-process
   * cache. DEFAULT 0 = none.
   *
   * WHY 0: before the resolver existed, `workspaceEntitlements` read
   * `Workspace.entitlementCache` straight from Postgres on EVERY request, so an
   * operator editing the pin saw it take effect on the next call. Routing this
   * lane through the resolver's 60s cache would have opened a 60-second
   * under-enforcement window on a lane that previously had none — a silent
   * regression dressed up as a refactor. Default 0 keeps the old behaviour
   * exactly; an operator who later configures a network entitlements source and
   * wants to cut its request volume can set
   * `WORKSPACE_ENTITLEMENTS_JWT_TTL_MS` explicitly and accept the window.
   *
   * ⚠️ 0 DOES NOT MEAN "one fetch per call site". `effectiveEntitlements` has a
   * dozen production call sites (customers.service x5, the five relationship
   * agents, the relations officer), so a max-age of 0 on its own turned ONE
   * inbound request into a dozen outbound entitlement fetches and a dozen mirror
   * UPSERTs. That amplification is collapsed by the resolver's REQUEST-SCOPED
   * memo (common/workspace/entitlement-request-scope.ts): one source read per
   * workspace per request, reused by every call site, discarded when the request
   * ends. So this lane is both un-stale AND un-amplified — the two are not in
   * tension, and this default must NOT be raised to "fix" request volume.
   */
  private get jwtLaneMaxAgeMs(): number {
    const raw = (this.config.get<string>('WORKSPACE_ENTITLEMENTS_JWT_TTL_MS') ?? '').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * A BLANK `DEFAULT_WORKSPACE_ID` is treated as ABSENT — ConfigService's default
   * argument only fires on `undefined`, so an explicitly-empty env var would
   * otherwise resolve every claim-less request to the workspace id `''`. See
   * MembershipService.bootstrapWorkspaceId for what that broke.
   */
  get defaultWorkspaceId(): string {
    return defaultWorkspaceIdFromEnv((k) => this.config.get<string>(k));
  }

  /** Resolve the active workspace id for the given (claim-augmented) user. */
  resolve(user: Partial<WithWorkspaceClaim> | null | undefined): string {
    return resolveWorkspaceId(user, this.defaultWorkspaceId);
  }

  /**
   * Dispatch guard for the runtime, workspace-scoped kill switch: throw 403 when
   * the workspace has agents/outbound paused. Delegates to MembershipService (the
   * flag owner) so agent + send paths depend only on this seam. Re-read on every
   * call — a toggle takes effect immediately, no restart.
   */
  async assertAgentsNotPaused(workspaceId: string): Promise<void> {
    return this.membership.assertAgentsNotPaused(workspaceId);
  }

  /**
   * Resolve the active workspace for `user` AND authorize membership (a no-op
   * while CUSTOMER_OPS_TENANCY_ENABLED is off — see MembershipService). Use this
   * on workspace-scoped request paths; it 403s when tenancy is live and the
   * user has no membership in the resolved workspace.
   */
  async resolveAuthorized(
    user: User & Partial<WithWorkspaceClaim>,
    requestedWorkspaceId?: string | null,
  ): Promise<string> {
    const claim = requestedWorkspaceId ?? this.resolve(user);
    return this.membership.resolveAndAuthorize(user, claim);
  }

  /**
   * The acting workspace's server-side entitlement SKUs — or `null` when the
   * workspace has NO server-side source at all (no operator pin, no mirror row).
   * `null` means "trust the token claim"; a present (possibly empty) answer is
   * authoritative and the intersector denies everything outside it.
   *
   * Delegates to WorkspaceEntitlementsResolver, which layers:
   *   Workspace.entitlementCache (operator pin) -> entitlements endpoint ->
   *   the durable `workspace_entitlements` mirror -> null.
   * An EXPIRED mirror row is indeterminate and resolves to `[]` (fail closed).
   *
   * Without the resolver injected (unit tests) this falls back to the original
   * behaviour: read `Workspace.entitlementCache` directly. Workspace is a control
   * table (not RLS-fenced), so this reads the plain client — no GUC needed.
   *
   * FRESHNESS: this lane passes `maxAgeMs: 0` by default, so the resolver's
   * in-process cache is NOT served here and an operator pin edit takes effect on
   * the very next request — same as before the resolver existed. See
   * {@link jwtLaneMaxAgeMs}.
   */
  async workspaceEntitlements(workspaceId: string): Promise<string[] | null> {
    if (this.entitlementsResolver) {
      return this.entitlementsResolver.skusFor(workspaceId, { maxAgeMs: this.jwtLaneMaxAgeMs });
    }
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { entitlementCache: true },
    });
    if (!ws) return null;
    return parseWorkspaceEntitlements(ws.entitlementCache);
  }

  /**
   * The entitlement SKUs to gate on for `user` acting in `workspaceId`: the
   * caller's token/PAT claim (`entitlementsOf`) BOUND to the workspace by
   * intersecting it with the workspace's server-side entitlements. This is the
   * (user, workspace) binding every federation/inference gate consumes — a token
   * carrying `customer-ops` from another org is denied it in a workspace whose
   * server-side cache lacks it, while a workspace with no cache falls back to the
   * claim (today's behavior). Callers pass the workspace they have ALREADY
   * resolved+authorized (resolveAuthorized), so this adds no membership decision.
   */
  async effectiveEntitlements(
    user: User & Partial<WithWorkspaceClaim>,
    workspaceId: string,
  ): Promise<string[]> {
    return intersectEntitlements(
      entitlementsOf(user),
      await this.workspaceEntitlements(workspaceId),
    );
  }

  /**
   * Run `fn` inside the resolved workspace's RLS transaction. Resolves the
   * workspace id from the user's claim (authorizing membership when tenancy is
   * on), pins the `app.current_workspace` + `app.uc_uid` GUCs via
   * PrismaService.withWorkspace, and invokes `fn(tx)`.
   *
   *   workspaceContext.runForUser(user, (tx) => tx.customer.findMany());
   *
   * This is the recommended call shape for any service that needs tenant-scoped
   * DB access: it guarantees the DB GUC matches the app-layer decision.
   */
  async runForUser<T>(
    user: User & Partial<WithWorkspaceClaim>,
    fn: (tx: WorkspaceTxClient) => Promise<T>,
    requestedWorkspaceId?: string | null,
  ): Promise<T> {
    const workspaceId = await this.resolveAuthorized(user, requestedWorkspaceId);
    return this.prisma.withWorkspace(workspaceId, ucUidOf(user), fn);
  }

  /**
   * Read-only counterpart of runForUser: same workspace resolution + RLS GUC,
   * but the transaction is marked READ ONLY. Use on pure-read request handlers
   * (e.g. the pipeline board) so Postgres rejects an accidental write and the
   * read never pays for write-side bookkeeping. `fn` must not mutate.
   */
  async runForUserReadOnly<T>(
    user: User & Partial<WithWorkspaceClaim>,
    fn: (tx: WorkspaceTxClient) => Promise<T>,
    requestedWorkspaceId?: string | null,
  ): Promise<T> {
    const workspaceId = await this.resolveAuthorized(user, requestedWorkspaceId);
    return this.prisma.withWorkspaceReadOnly(workspaceId, ucUidOf(user), fn);
  }

  /**
   * Lower-level: run `fn` inside an explicit workspace's RLS transaction. For
   * system jobs / already-resolved workspace ids that don't carry a request user.
   */
  async runInWorkspace<T>(
    workspaceId: string,
    ucUid: string | null | undefined,
    fn: (tx: WorkspaceTxClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.withWorkspace(workspaceId, ucUid, fn);
  }
}

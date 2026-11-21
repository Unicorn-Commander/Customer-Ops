import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RelationshipStage, User, WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { appPublicUrl } from './home-summary.config';
import { emailAuditHash, normalizeEmail } from './home-summary.caller';

/** One metric ring on the Home card (0..4 of these). */
export interface HomeMetric {
  label: string;
  value: number | string;
  href: string | null;
}

/** One item row under the rings (0..5 of these, newest/most urgent first). */
export interface HomeItem {
  title: string;
  subtitle: string | null;
  href: string | null;
  at: string | null;
  kind: string;
}

export interface HomeSummary {
  state: 'ok' | 'empty' | 'not_member';
  updatedAt: string;
  metrics: HomeMetric[];
  items: HomeItem[];
}

/**
 * The metric rings this app contributes (CONTRACT v1.1, DESKO-136/137). They
 * are emitted in THIS order, each ONLY when its value is > 0, then cut to the
 * first HOME_METRIC_CAP — so when all five are positive "Quotes out" (last)
 * drops off.
 */
export const HOME_METRIC_LABELS = {
  customers: 'Customers',
  prospects: 'Prospects',
  openLeads: 'Open leads',
  followUpsDue: 'Follow-ups due',
  quotesOut: 'Quotes out',
} as const;

/** The Home card shows at most four metric rings (CONTRACT cap). */
export const HOME_METRIC_CAP = 4;

/** The item window: the next 5 follow-ups by due date. */
export const HOME_FOLLOW_UP_ITEMS = 5;
/** A follow-up note's first line is capped so the Home row stays one line. */
export const HOME_FOLLOW_UP_SUBTITLE_MAX = 80;

/**
 * The SCOPE of a Home summary, decided by the person's role in the workspace.
 *   - 'workspace' — OWNER / ADMIN: all live rows in the workspace.
 *   - 'own'       — MEMBER (and MANAGER): only rows with ownerUserKey = the
 *                   person's own app user key.
 *   - 'none'      — VIEWER, or no role: nothing (CONTRACT v1 behaviour for a
 *                   viewer), matching what the app UI shows a viewer.
 */
export type HomeScope = 'workspace' | 'own' | 'none';

/**
 * The ONE place the role -> scope ladder is defined (CONTRACT v1.1). It reads a
 * STORED Membership role; a missing role fails closed to 'none'.
 */
export function homeScopeForRole(role: WorkspaceRole | null | undefined): HomeScope {
  switch (role) {
    case WorkspaceRole.OWNER:
    case WorkspaceRole.ADMIN:
      return 'workspace';
    case WorkspaceRole.MANAGER:
    case WorkspaceRole.MEMBER:
      return 'own';
    default:
      return 'none';
  }
}

/**
 * The read-only HOME-SUMMARY service (HOME-SUMMARY CONTRACT v1.1).
 *
 * CONTRACT v1.1: the person's role in THIS workspace decides the SCOPE of every
 * metric and item — OWNER/ADMIN see WORKSPACE TOTALS, MEMBER sees only their own
 * book (ownerUserKey = their app user key), VIEWER sees nothing. The scope comes
 * from the STORED Membership row (resolveMember), never a claim or a header.
 * It is strictly a read — the only side effect the route may have is the audit
 * log line the caller writes — and every query runs inside the app's own RLS
 * transaction (PrismaService.withWorkspaceReadOnly) with the person's own role,
 * so a viewer never sees a number the app UI hides from them.
 *
 * Person resolution mirrors the app's own identity model: `email` ->
 * EXACTLY ONE active, email-verified User -> an ACTIVE Membership in `workspace`.
 * Zero/many/deactivated/not-a-member all collapse to `not_member` with nothing in
 * it (never say why).
 */
@Injectable()
export class HomeSummaryService {
  private readonly logger = new Logger(HomeSummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly contactOps: ContactOpsPort,
  ) {}

  /**
   * Compute the summary for (email, workspace). `org`/`sub` are informational
   * only — the answer is always for one named person in this app's workspace.
   */
  async forPerson(params: { email: string; workspace: string; azp: string }): Promise<HomeSummary> {
    const startedAt = Date.now();
    const email = normalizeEmail(params.email);

    const resolution = await this.resolveMember(email, params.workspace);
    if (!resolution) {
      const summary = this.notMember();
      this.logCall(params, email, summary.state, startedAt);
      return summary;
    }

    const { user, role } = resolution;
    const summary = await this.computeForMember(user, params.workspace, role);
    this.logCall(params, email, summary.state, startedAt);
    return summary;
  }

  /**
   * Resolve `email` to exactly one active + verified User that is an ACTIVE
   * member of `workspace`, and take that member's role. Anything else -> null.
   */
  private async resolveMember(
    email: string,
    workspaceId: string,
  ): Promise<{ user: User; role: WorkspaceRole } | null> {
    if (!email || !workspaceId) return null;

    const matches = await this.prisma.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' } },
      take: 2,
    });
    if (matches.length !== 1) return null;
    const user = matches[0];
    if (!user.isActive) return null;

    // The membership key the rest of the app uses is the uchub sub (keycloakId),
    // never the local row id. A user with no sub cannot hold a membership.
    const userKey = user.keycloakId ?? '';
    if (!userKey) return null;

    const membership = await this.prisma.membership.findUnique({
      where: { userKey_workspaceId: { userKey, workspaceId } },
    });
    if (!membership || membership.status !== 'ACTIVE') return null;

    return { user, role: membership.role };
  }

  /**
   * The member's own book, read inside the workspace RLS transaction (READ ONLY
   * — the transaction refuses any accidental write) as the member themselves.
   */
  private async computeForMember(
    user: User,
    workspaceId: string,
    role: WorkspaceRole,
  ): Promise<HomeSummary> {
    const base = appPublicUrl(this.config);
    const customerHref = `${base}/dashboard/customers`;
    const pipelineHref = `${base}/dashboard/pipeline`;
    const quotesHref = `${base}/dashboard/invoices`;

    // CONTRACT v1.1: the STORED membership role decides the scope. OWNER/ADMIN
    // get workspace totals (no ownerKey filter at all — the RLS fence is already
    // this workspace); MEMBER gets only their own book; VIEWER gets nothing
    // (CONTRACT v1 behaviour, matching the app UI).
    const scope = homeScopeForRole(role);
    // The person's own owner key is the APP's user id resolved from email — the
    // `ownerUserKey` the cockpit writes: the acting caller's ucUid, which is
    // `__ucUid` (the token sub) or, failing that, `keycloakId` / `id`
    // (workspace.util.ts ucUidOf; customers.controller.ts:51-65 passes the acting
    // user into the list/write paths). Not the Ops-Center sub.
    const ownKey = user.keycloakId ?? null;
    if (scope === 'none') {
      return { state: 'empty', updatedAt: new Date().toISOString(), metrics: [], items: [] };
    }
    if (scope === 'own' && !ownKey) {
      return { state: 'empty', updatedAt: new Date().toISOString(), metrics: [], items: [] };
    }
    // The owner filter for this scope: undefined => the whole workspace (OWNER/
    // ADMIN, already fenced to this workspace by RLS); a key => that person only.
    const ownerUserKey = scope === 'own' ? ownKey! : undefined;
    const ownerWhere = ownerUserKey ? { ownerUserKey } : {};
    // The RLS GUC attribution still names the ACTING person, regardless of scope.
    const ownerKey = ownKey ?? '';

    const now = new Date();
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );
    const startOfTomorrow = new Date(startOfToday);
    startOfTomorrow.setUTCDate(startOfTomorrow.getUTCDate() + 1);

    // ONE round: every count + the item window in one read-only transaction.
    // Every count uses the SAME ownerWhere scope: OWNER/ADMIN have no owner
    // filter (unowned rows with ownerUserKey null COUNT in workspace totals;
    // RLS already fences this workspace), MEMBER is filtered to their own key.
    const rows = await this.prisma.withWorkspaceReadOnly(workspaceId, ownerKey, async (tx) => {
      const [customers, prospects, openLeads, followUpsDue, quotesOut, followUps] =
        await Promise.all([
          // Customers: a not-lost CUSTOMER-stage relationship.
          tx.customer.count({
            where: { ...ownerWhere, stage: RelationshipStage.CUSTOMER, isLost: false },
          }),
          // Prospects: a not-lost PROSPECT-stage relationship.
          tx.customer.count({
            where: { ...ownerWhere, stage: RelationshipStage.PROSPECT, isLost: false },
          }),
          // Open leads: a still-LEAD relationship.
          tx.customer.count({
            where: { ...ownerWhere, stage: RelationshipStage.LEAD, isLost: false },
          }),
          // Follow-ups due: a next action due today or overdue, on a live row.
          tx.customer.count({
            where: {
              ...ownerWhere,
              isLost: false,
              nextActionAt: { lt: startOfTomorrow },
            },
          }),
          // Quotes out: sent (not accepted/declined) on a not-lost customer.
          tx.quote.count({
            where: {
              status: 'sent',
              customer: { ...ownerWhere, isLost: false },
            },
          }),
          // The next 5 follow-ups by due date (soonest first).
          tx.customer.findMany({
            where: {
              ...ownerWhere,
              isLost: false,
              nextActionAt: { not: null },
            },
            orderBy: [{ nextActionAt: 'asc' }, { id: 'asc' }],
            take: HOME_FOLLOW_UP_ITEMS,
            select: {
              id: true,
              contactId: true,
              notes: true,
              nextActionAt: true,
            },
          }),
        ]);
      return { customers, prospects, openLeads, followUpsDue, quotesOut, followUps };
    });

    const titles = await this.resolveCustomerNames(user, workspaceId, rows.followUps);

    const items: HomeItem[] = rows.followUps.map((row) => ({
      title: titles.get(row.id) ?? 'Customer',
      subtitle: firstLine(row.notes, HOME_FOLLOW_UP_SUBTITLE_MAX),
      href: `${customerHref}/${row.id}`,
      at: row.nextActionAt ? row.nextActionAt.toISOString() : null,
      kind: 'follow_up',
    }));

    // CONTRACT v1.1 (DESKO-136/137): fixed order, each only when > 0, then the
    // first HOME_METRIC_CAP. On a full workspace every count is positive and
    // "Quotes out" (last) is the one that drops off.
    const candidates: HomeMetric[] = [
      { label: HOME_METRIC_LABELS.customers, value: rows.customers, href: customerHref },
      { label: HOME_METRIC_LABELS.prospects, value: rows.prospects, href: pipelineHref },
      { label: HOME_METRIC_LABELS.openLeads, value: rows.openLeads, href: pipelineHref },
      {
        label: HOME_METRIC_LABELS.followUpsDue,
        value: rows.followUpsDue,
        href: customerHref,
      },
      { label: HOME_METRIC_LABELS.quotesOut, value: rows.quotesOut, href: quotesHref },
    ];
    const metrics: HomeMetric[] = candidates
      .filter((metric) => Number(metric.value) > 0)
      .slice(0, HOME_METRIC_CAP);

    return {
      state: metrics.length === 0 && items.length === 0 ? 'empty' : 'ok',
      updatedAt: new Date().toISOString(),
      metrics,
      items,
    };
  }

  /**
   * Federated display names for the follow-up customers. Contacts are NEVER
   * copied locally; this resolves them through the Contact-Ops port exactly as
   * the cockpit does. Any failure is degrade-clean: the row keeps a neutral
   * title rather than leaking a contact id or failing the whole summary.
   */
  private async resolveCustomerNames(
    user: User,
    workspaceId: string,
    rows: Array<{ id: string; contactId: string }>,
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (rows.length === 0) return names;
    try {
      const contacts = await this.contactOps.getContactSummaries(
        { workspaceId, ucUid: user.keycloakId ?? user.id },
        rows.map((row) => row.contactId),
      );
      for (const row of rows) {
        const contact = contacts.get(row.contactId);
        if (contact?.displayName) names.set(row.id, contact.displayName);
      }
    } catch (error) {
      this.logger.warn(
        `Home summary contact resolution failed for workspace ${workspaceId}: ${(error as Error).message}`,
      );
    }
    return names;
  }

  private notMember(): HomeSummary {
    return { state: 'not_member', updatedAt: new Date().toISOString(), metrics: [], items: [] };
  }

  /**
   * One INFO line per call: caller azp, workspace, sha256(email)[:12], state, ms.
   * Never the token, never the raw email.
   */
  private logCall(
    params: { azp: string; workspace: string },
    email: string,
    state: HomeSummary['state'],
    startedAt: number,
  ): void {
    const emailHash = email ? emailAuditHash(email) : '-';
    this.logger.log(
      `home-summary caller=${params.azp} workspace=${params.workspace} emailHash=${emailHash} ` +
        `state=${state} ms=${Date.now() - startedAt}`,
    );
  }
}

/** The first line of a note, trimmed and capped at `max` characters. */
export function firstLine(note: string | null | undefined, max: number): string | null {
  if (typeof note !== 'string') return null;
  const line = note.split(/\r?\n/, 1)[0].trim();
  if (!line) return null;
  return line.length > max ? line.slice(0, max) : line;
}

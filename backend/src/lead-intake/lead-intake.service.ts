/**
 * LeadIntakeService — the `ingest_lead` keystone (Phase 6).
 *
 * The durable, idempotent leadgen → Customer-Ops ingestion pipeline. A leadgen
 * app (Northwind, Magic Unicorn Outreach, LoopNet, multistate, …) or an agent
 * pushes a graduated, enriched lead; this service:
 *
 *   1. LANDS it in the `lead_intakes` buffer, idempotent on
 *      (workspace, source, sourceDedupKey) — a retry UPSERTS, never duplicates.
 *      Nothing is ever lost, even if identity can't be resolved yet.
 *   2. RESOLVES identity by precedence (the CONTACT-OPS-INGEST-CONTRACT rule —
 *      identity centralizes in Contact-Ops, the person SoR):
 *        a. an EXPLICIT contactId (end-state: the leadgen app already pushed to
 *           Contact-Ops and tells us the person_id) — no external call;
 *        b. a Contact-Ops UPSERT (works the moment P-00059's /ingest is live);
 *        c. a deterministic PROVISIONAL id ('prov:<hash>') so the dogfood stays a
 *           populated showpiece while Contact-Ops is dormant — swapped for the
 *           canonical id by reconciliation later.
 *   3. PROJECTS a Customer LEAD row keyed on the resolved contactId (the funnel
 *      projection Customer-Ops owns) + logs an INGESTED activity. Never a second
 *      contact store: the projection persists only the contactId + the rollup.
 *
 * When identity can't be resolved (Contact-Ops dormant AND no contactId AND
 * provisional disabled), the intake sits PENDING and `resolvePending` promotes
 * it the moment Contact-Ops is reachable — so wiring P-00059 needs ZERO change
 * here. All DB access runs through the WorkspaceContext RLS chokepoint; the
 * Contact-Ops upsert (an external call) runs OUTSIDE the DB transaction.
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import {
  CustomerActivityKind,
  LeadIntake,
  LeadIntakeStatus,
  Prisma,
  RelationshipStage,
  User,
} from '@prisma/client';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { WorkspaceTxClient } from '../prisma/prisma.service';
import { WithWorkspaceClaim, ucUidOf } from '../common/workspace/workspace.util';
import { ContactOpsPort, FederationContext } from '../contact-ops/contact-ops.port';
import { ContactIdentityInput } from '../contact-ops/contact-ops.types';
import {
  LeadLabel,
  LeadLabelResolver,
  PROVISIONAL_PREFIX,
  isProvisionalContactId,
} from './lead-label.port';
import {
  DiscardIntakeDto,
  IngestLeadDto,
  ListIntakesQueryDto,
  ResolvePendingDto,
} from './dto/lead-intake.dto';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

/**
 * Keep organization domains useful for business leads without maintaining a
 * provider allowlist. A domain is treated as free mail only when a known
 * free-mail provider is the REGISTRABLE (second-level) label — mail.yahoo.com,
 * yahoo.co.uk, me.com, proton.me, pm.me — never when the word merely appears
 * as a TLD or an unrelated label (acme.me, studio.live, mac.example.com stay).
 */
const FREE_MAIL_HOST_RE =
  /^(?:[^.\s]+\.)*(?:gmail|googlemail|yahoo|ymail|rocketmail|outlook|hotmail|live|msn|icloud|me|mac|aol|proton|protonmail|pm)\.(?:com|net|org|me|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/i;

function organizationDomainFromEmail(email: string | null): string | undefined {
  const match = email?.trim().match(/^[^@\s]+@([^@\s]+)$/);
  if (!match) return undefined;
  const domain = match[1].toLowerCase();
  return FREE_MAIL_HOST_RE.test(domain) ? undefined : domain;
}

/** The serialized intake shape returned on the wire (Decimal → string). */
export interface SerializedIntake {
  id: string;
  source: string;
  sourceDedupKey: string;
  status: LeadIntakeStatus;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  orgName: string | null;
  tags: string[];
  score: number | null;
  expectedValue: string | null;
  currency: string | null;
  priority: string;
  ownerUserKey: string | null;
  notes: string | null;
  resolvedContactId: string | null;
  provisional: boolean;
  customerId: string | null;
  statusDetail: string | null;
  createdByUcUid: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The outcome of one resolution attempt (used inline + by the reconciler). */
interface ResolveOutcome {
  resolved: boolean;
  contactId?: string;
  provisional?: boolean;
  customerId?: string;
  via?: 'explicit' | 'contact-ops' | 'provisional';
  detail: string;
}

@Injectable()
export class LeadIntakeService extends LeadLabelResolver {
  private readonly logger = new Logger(LeadIntakeService.name);

  constructor(
    private readonly workspaces: WorkspaceContextService,
    private readonly contactOps: ContactOpsPort,
    private readonly config: ConfigService,
  ) {
    super();
  }

  // ── configuration seam ──

  /** Whether to mint a provisional contactId when Contact-Ops can't resolve
   *  identity (default ON — keeps leads visible; once CO is live the upsert wins
   *  first and provisional is never reached). Set LEAD_INTAKE_PROVISIONAL_IDENTITY
   *  = 'false' to make unresolved leads sit PENDING instead. */
  private get provisionalEnabled(): boolean {
    const raw = this.config.get<string>('LEAD_INTAKE_PROVISIONAL_IDENTITY');
    if (raw === undefined || raw === null || raw.trim() === '') return true;
    return !/^(false|0|no|off)$/i.test(raw.trim());
  }

  // ========================================================================
  // INGEST — land the lead (idempotent) then resolve inline.
  // ========================================================================

  async ingestForUser(user: AuthedUser, dto: IngestLeadDto, requestedWorkspaceId?: string | null) {
    const explicitContactId = dto.contactId?.trim() || null;
    const hasIdentityKey = !!(dto.email?.trim() || dto.phone?.trim() || dto.displayName?.trim());
    if (!explicitContactId && !hasIdentityKey) {
      throw new BadRequestException(
        'A lead needs an identity to resolve: pass contactId, or at least one of ' +
          'email / phone / displayName. (Identity is centralized in Contact-Ops; ' +
          'Customer-Ops keys its projection on the resolved contactId.)',
      );
    }

    const ucUid = ucUidOf(user);

    // 1) Land/refresh the staged intake (idempotent on (ws, source, dedupKey)).
    const intake = await this.workspaces.runForUser(
      user,
      (tx) => this.upsertIntakeInTx(tx, dto, ucUid),
      requestedWorkspaceId,
    );

    // 2) Resolve inline when still open (PENDING/FAILED), or re-run the
    //    Contact-Ops upsert for a RESOLVED re-push. The intake tuple remains
    //    idempotent; projection upsert preserves an existing relationship's
    //    stage and customer id.
    let outcome: ResolveOutcome = {
      resolved: intake.status === LeadIntakeStatus.RESOLVED,
      contactId: intake.resolvedContactId ?? undefined,
      provisional: intake.provisional,
      customerId: intake.customerId ?? undefined,
      detail: intake.statusDetail ?? 'already resolved',
    };
    let current = intake;
    if (
      intake.status === LeadIntakeStatus.PENDING ||
      intake.status === LeadIntakeStatus.FAILED ||
      intake.status === LeadIntakeStatus.RESOLVED
    ) {
      const r = await this.resolveOne(user, intake, explicitContactId, requestedWorkspaceId);
      outcome = r.outcome;
      current = r.intake;
    }

    return {
      intake: this.serialize(current),
      resolved: outcome.resolved,
      via: outcome.via ?? null,
      provisional: outcome.provisional ?? false,
      contactId: outcome.contactId ?? null,
      customerId: outcome.customerId ?? null,
      detail: outcome.detail,
    };
  }

  /** Upsert the staged intake row. Create → PENDING; re-push → refresh the staged
   *  identity/rollup/seeds/rawPayload (resolution state is preserved). */
  private async upsertIntakeInTx(
    tx: WorkspaceTxClient,
    dto: IngestLeadDto,
    ucUid: string,
  ): Promise<LeadIntake> {
    const workspaceId = await this.boundWorkspaceId(tx);
    // Fold the structured name fields (CO-expose-fields) into the verbatim
    // envelope so they survive staging + replay WITHOUT new LeadIntake columns
    // (no migration for this task) and can be replayed into Contact-Ops.
    const envelope = {
      ...(dto.rawPayload ?? {}),
      ...(dto.givenName ? { given_name: dto.givenName } : {}),
      ...(dto.familyName ? { family_name: dto.familyName } : {}),
      ...(dto.nicknames ? { nicknames: dto.nicknames } : {}),
    };
    const staged = {
      displayName: dto.displayName?.trim() || null,
      email: dto.email?.trim() || null,
      phone: dto.phone?.trim() || null,
      orgName: dto.orgName?.trim() || null,
      tags: dto.tags ?? [],
      score: dto.score ?? null,
      expectedValue: dto.expectedValue ? new Prisma.Decimal(dto.expectedValue) : null,
      currency: dto.currency ?? 'USD',
      priority: dto.priority ?? undefined,
      ownerUserKey: dto.ownerUserKey?.trim() || null,
      notes: dto.notes?.trim() || null,
      rawPayload: (Object.keys(envelope).length ? envelope : undefined) as
        | Prisma.InputJsonValue
        | undefined,
    };
    return tx.leadIntake.upsert({
      where: {
        workspaceId_source_sourceDedupKey: {
          workspaceId,
          source: dto.source,
          sourceDedupKey: dto.sourceDedupKey,
        },
      },
      create: {
        workspaceId,
        source: dto.source,
        sourceDedupKey: dto.sourceDedupKey,
        status: LeadIntakeStatus.PENDING,
        createdByUcUid: ucUid || null,
        ...staged,
      },
      // Refresh staged data on re-push; never clobber the resolution outcome.
      update: staged,
    });
  }

  // ========================================================================
  // RESOLVE — identity precedence → Customer LEAD projection.
  // The Contact-Ops upsert (external) runs OUTSIDE the DB transaction.
  // ========================================================================

  private async resolveOne(
    user: AuthedUser,
    intake: LeadIntake,
    explicitContactId: string | null,
    requestedWorkspaceId?: string | null,
  ): Promise<{ intake: LeadIntake; outcome: ResolveOutcome }> {
    const ucUid = ucUidOf(user);
    let contactId: string | null = null;
    let provisional = false;
    let via: ResolveOutcome['via'] = undefined;
    const wasResolved =
      intake.status === LeadIntakeStatus.RESOLVED && Boolean(intake.resolvedContactId);

    // (a) explicit contactId — the end-state path, no external call.
    if (explicitContactId) {
      contactId = explicitContactId;
      via = 'explicit';
    } else {
      // (b) Contact-Ops upsert (degrade-clean: null when CO dormant / pre-P-00059).
      const fedCtx: FederationContext = {
        workspaceId: await this.workspaces.resolveAuthorized(user, requestedWorkspaceId),
        ucUid: ucUid || null,
      };
      const upserted = await this.contactOps.upsertContact(fedCtx, this.toIdentity(intake));
      if (upserted) {
        contactId = upserted.contactId;
        via = 'contact-ops';
      } else if (wasResolved) {
        // A re-push must not mint a second provisional id or relationship just
        // because Contact-Ops is temporarily unavailable. The staged payload is
        // already refreshed; retain the last successful resolution and let the
        // normal reconciliation path retry Contact-Ops later.
        const existingContactId = intake.resolvedContactId!;
        const existingVia: NonNullable<ResolveOutcome['via']> = intake.provisional
          ? 'provisional'
          : 'contact-ops';
        const detail =
          'Contact-Ops did not resolve the re-push; retained the existing contact ' +
          `${existingContactId} and relationship projection.`;
        return {
          intake,
          outcome: {
            resolved: true,
            contactId: existingContactId,
            provisional: intake.provisional,
            customerId: intake.customerId ?? undefined,
            via: existingVia,
            detail,
          },
        };
      } else if (this.provisionalEnabled) {
        // (c) provisional fallback — deterministic from the strongest identity key.
        contactId = this.mintProvisional(fedCtx.workspaceId, intake);
        provisional = true;
        via = 'provisional';
      }
    }

    // Unresolved → stays PENDING; the reconciler retries once CO is reachable.
    if (!contactId) {
      const detail =
        'Contact-Ops is not reachable and provisional identity is disabled — staged ' +
        'PENDING; resolve-pending will promote it once Contact-Ops is connected.';
      const updated = await this.workspaces.runForUser(
        user,
        (tx) =>
          tx.leadIntake.update({
            where: { id: intake.id },
            data: { status: LeadIntakeStatus.PENDING, statusDetail: detail },
          }),
        requestedWorkspaceId,
      );
      return { intake: updated, outcome: { resolved: false, detail } };
    }

    // Project the LEAD + mark the intake RESOLVED, in one RLS tx.
    const resolvedId = contactId;
    const isProv = provisional;
    const { intake: updated, customerId } = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const customer = await this.upsertProjectionInTx(
          tx,
          resolvedId,
          intake,
          ucUid,
          via!,
          intake.status === LeadIntakeStatus.RESOLVED ? intake.customerId : null,
        );
        const updatedIntake = await tx.leadIntake.update({
          where: { id: intake.id },
          data: {
            status: LeadIntakeStatus.RESOLVED,
            resolvedContactId: resolvedId,
            provisional: isProv,
            customerId: customer.id,
            resolvedAt: new Date(),
            statusDetail: `Resolved via ${via}${isProv ? ' (provisional)' : ''} → contact ${resolvedId}`,
          },
        });
        return { intake: updatedIntake, customerId: customer.id };
      },
      requestedWorkspaceId,
    );

    return {
      intake: updated,
      outcome: {
        resolved: true,
        contactId: resolvedId,
        provisional: isProv,
        customerId,
        via,
        detail: `Resolved via ${via}${isProv ? ' (provisional)' : ''}`,
      },
    };
  }

  /**
   * Create or update the Customer LEAD projection for a resolved contactId.
   * NO-DOWNGRADE: an existing relationship keeps its stage (a re-ingested
   * CUSTOMER never drops back to LEAD); only a brand-new contact starts at LEAD.
   * Logs ONE INGESTED activity either way (the graduation provenance).
   */
  private async upsertProjectionInTx(
    tx: WorkspaceTxClient,
    contactId: string,
    intake: LeadIntake,
    ucUid: string,
    via: NonNullable<ResolveOutcome['via']>,
    existingCustomerId?: string | null,
  ) {
    const workspaceId = await this.boundWorkspaceId(tx);
    const existing = await tx.customer.findFirst({ where: { contactId } });

    let customer = existing;
    let repointed = false;
    let mergeNeededFrom: string | null = null;
    if (existing && existingCustomerId && existing.id !== existingCustomerId) {
      // The refreshed canonical id is already projected locally AND the intake
      // already had a relationship of its own. Never delete the old row here:
      // quotes reference it with ON DELETE RESTRICT (the transaction would
      // throw) and invoice / outreach / email links cascade (silent loss).
      // Keep both rows, point the intake at the canonical one, and leave a
      // visible merge-needed note on each so an operator merges on purpose.
      mergeNeededFrom = existingCustomerId;
    }
    if (!customer && existingCustomerId) {
      // A resolved re-push may receive a refreshed canonical id. Re-point the
      // existing relationship in place when that id is not already claimed;
      // this preserves the relationship id and stage instead of creating a
      // second Customer row.
      customer = await tx.customer.update({
        where: { id: existingCustomerId },
        data: { contactId },
      });
      repointed = true;
    }
    if (!customer) {
      customer = await tx.customer.create({
        data: {
          workspaceId,
          contactId,
          stage: RelationshipStage.LEAD,
          source: intake.source,
          priority: intake.priority,
          ownerUserKey: intake.ownerUserKey,
          expectedValue: intake.expectedValue ?? undefined,
          currency: intake.currency ?? 'USD',
          notes: intake.notes,
          lastStageChangeAt: new Date(),
        },
      });
    } else {
      // Re-ingest of a known contact (or a re-pointed relationship): enrich
      // gently, never downgrade the stage. Fill an unset owner / value; don't
      // overwrite operator edits.
      const data: Prisma.CustomerUpdateInput = {};
      if (!customer.ownerUserKey && intake.ownerUserKey) data.ownerUserKey = intake.ownerUserKey;
      if (customer.expectedValue == null && intake.expectedValue != null) {
        data.expectedValue = intake.expectedValue;
      }
      if (Object.keys(data).length) {
        customer = await tx.customer.update({ where: { id: customer.id }, data });
      }
    }

    const known = Boolean(existing) || repointed;
    await tx.customerActivity.create({
      data: {
        workspaceId,
        customerId: customer!.id,
        kind: CustomerActivityKind.INGESTED,
        toStage: known ? undefined : RelationshipStage.LEAD,
        body:
          `Ingested from ${intake.source} (${intake.sourceDedupKey}) via ${via}` +
          `${isProvisionalContactId(contactId) ? ' [provisional identity]' : ''} → contact ${contactId}` +
          `${repointed ? ' — re-pointed existing relationship to the refreshed contact id' : known ? ' — enriched existing relationship' : ' — new lead'}` +
          (intake.tags.length ? ` · tags: ${intake.tags.join(', ')}` : ''),
        actorUcUid: ucUid || null,
      },
    });

    if (mergeNeededFrom) {
      const note =
        `MERGE NEEDED: re-push of ${intake.source} (${intake.sourceDedupKey}) resolved to contact ${contactId}, ` +
        `which already has relationship ${customer!.id}; relationship ${mergeNeededFrom} keeps its own history ` +
        `(quotes, invoices, outreach, email links) until an operator merges them.`;
      for (const id of [customer!.id, mergeNeededFrom]) {
        await tx.customerActivity.create({
          data: {
            workspaceId,
            customerId: id,
            kind: CustomerActivityKind.NOTE,
            body: note,
            actorUcUid: ucUid || null,
          },
        });
      }
    }

    return customer!;
  }

  // ========================================================================
  // RECONCILE — promote PENDING (and optionally upgrade provisional → canonical).
  // ========================================================================

  /**
   * Promote staged leads. Pass A resolves PENDING (and FAILED, when
   * scope='pending_and_failed') intakes. Pass B — only when Contact-Ops is now
   * reachable — re-runs the upsert for RESOLVED+provisional intakes and swaps the
   * provisional id for the canonical Contact-Ops person_id on both the intake and
   * its Customer projection. This is the "wire P-00059 later" payoff: it needs no
   * code change, just Contact-Ops becoming reachable.
   */
  async resolvePendingForUser(
    user: AuthedUser,
    dto: ResolvePendingDto,
    requestedWorkspaceId?: string | null,
  ) {
    const limit = dto.limit ?? 50;
    const includeFailed = dto.scope === 'pending_and_failed';
    const statuses = includeFailed
      ? [LeadIntakeStatus.PENDING, LeadIntakeStatus.FAILED]
      : [LeadIntakeStatus.PENDING];

    // Pass A — the open intakes, oldest-first.
    const pending = await this.workspaces.runForUser(
      user,
      (tx) =>
        tx.leadIntake.findMany({
          where: { status: { in: statuses } },
          orderBy: { createdAt: 'asc' },
          take: limit,
        }),
      requestedWorkspaceId,
    );

    let resolved = 0;
    let stillOpen = 0;
    for (const intake of pending) {
      const r = await this.resolveOne(user, intake, null, requestedWorkspaceId);
      if (r.outcome.resolved) resolved++;
      else stillOpen++;
    }

    // Pass B — upgrade provisional ids to canonical, but only if CO is reachable.
    let upgraded = 0;
    if (this.contactOps && this.coReachable()) {
      const provisionals = await this.workspaces.runForUser(
        user,
        (tx) =>
          tx.leadIntake.findMany({
            where: { status: LeadIntakeStatus.RESOLVED, provisional: true },
            orderBy: { resolvedAt: 'asc' },
            take: limit,
          }),
        requestedWorkspaceId,
      );
      for (const intake of provisionals) {
        if (await this.upgradeProvisional(user, intake, requestedWorkspaceId)) upgraded++;
      }
    }

    return {
      scanned: pending.length,
      resolved,
      stillOpen,
      provisionalUpgraded: upgraded,
      coReachable: this.coReachable(),
    };
  }

  // ========================================================================
  // SYSTEM RECONCILE — the same reconciler, run by the scheduler per workspace
  // with NO request user. Identical outcome to resolvePendingForUser Pass A, but
  // the workspace is bound EXPLICITLY (runInWorkspace pins the RLS GUC) and the
  // acting identity is the system (ucUid=null). No membership check applies —
  // there is no user; the workspace itself is the tenancy boundary (RLS), which
  // is exactly what runInWorkspace enforces. Federation runs OUTSIDE every tx.
  // ========================================================================

  /**
   * Promote PENDING intakes for ONE workspace as a system job. Mirrors
   * resolvePendingForUser Pass A + Pass B, but bound to `workspaceId` with the
   * system actor. Best-effort per intake — one bad intake never aborts the pass.
   */
  async reconcilePendingSystem(
    workspaceId: string,
    limit = 100,
  ): Promise<{
    scanned: number;
    resolved: number;
    stillOpen: number;
    provisionalUpgraded: number;
  }> {
    // Pass A — promote PENDING intakes, oldest-first.
    const pending = await this.workspaces.runInWorkspace(workspaceId, null, (tx) =>
      tx.leadIntake.findMany({
        where: { status: LeadIntakeStatus.PENDING },
        orderBy: { createdAt: 'asc' },
        take: limit,
      }),
    );

    let resolved = 0;
    let stillOpen = 0;
    for (const intake of pending) {
      try {
        if (await this.resolveOneSystem(workspaceId, intake)) resolved++;
        else stillOpen++;
      } catch (err) {
        stillOpen++;
        this.logger.warn(
          `System reconcile: intake ${intake.id} in ${workspaceId} failed: ${(err as Error).message}`,
        );
      }
    }

    // Pass B — upgrade provisional ids to canonical, only when Contact-Ops is now
    // reachable (otherwise the upsert would just re-mint the same provisional).
    let upgraded = 0;
    if (this.coReachable()) {
      const provisionals = await this.workspaces.runInWorkspace(workspaceId, null, (tx) =>
        tx.leadIntake.findMany({
          where: { status: LeadIntakeStatus.RESOLVED, provisional: true },
          orderBy: { resolvedAt: 'asc' },
          take: limit,
        }),
      );
      for (const intake of provisionals) {
        try {
          if (await this.upgradeProvisionalSystem(workspaceId, intake)) upgraded++;
        } catch (err) {
          this.logger.warn(
            `System reconcile: provisional upgrade for ${intake.id} in ${workspaceId} failed: ${(err as Error).message}`,
          );
        }
      }
    }

    return { scanned: pending.length, resolved, stillOpen, provisionalUpgraded: upgraded };
  }

  /** System-actor counterpart of resolveOne (no explicit contactId path). Returns
   *  true when the intake was resolved (RESOLVED), false when it stays PENDING. */
  private async resolveOneSystem(workspaceId: string, intake: LeadIntake): Promise<boolean> {
    const fedCtx: FederationContext = { workspaceId, ucUid: null };

    // (b) Contact-Ops upsert (degrade-clean: null when CO dormant / pre-P-00059).
    let contactId: string | null = null;
    let provisional = false;
    let via: ResolveOutcome['via'] = undefined;
    const upserted = await this.contactOps.upsertContact(fedCtx, this.toIdentity(intake));
    if (upserted) {
      contactId = upserted.contactId;
      via = 'contact-ops';
    } else if (this.provisionalEnabled) {
      // (c) provisional fallback — deterministic from the strongest identity key.
      contactId = this.mintProvisional(workspaceId, intake);
      provisional = true;
      via = 'provisional';
    }

    // Unresolved → stays PENDING; a later pass retries once CO is reachable.
    if (!contactId) {
      await this.workspaces.runInWorkspace(workspaceId, null, (tx) =>
        tx.leadIntake.update({
          where: { id: intake.id },
          data: {
            status: LeadIntakeStatus.PENDING,
            statusDetail:
              'Contact-Ops is not reachable and provisional identity is disabled — staged ' +
              'PENDING; the scheduler will promote it once Contact-Ops is connected.',
          },
        }),
      );
      return false;
    }

    // Project the LEAD + mark the intake RESOLVED, in one RLS tx (system actor).
    const resolvedId = contactId;
    const isProv = provisional;
    await this.workspaces.runInWorkspace(workspaceId, null, async (tx) => {
      const customer = await this.upsertProjectionInTx(tx, resolvedId, intake, '', via!);
      await tx.leadIntake.update({
        where: { id: intake.id },
        data: {
          status: LeadIntakeStatus.RESOLVED,
          resolvedContactId: resolvedId,
          provisional: isProv,
          customerId: customer.id,
          resolvedAt: new Date(),
          statusDetail: `Resolved via ${via}${isProv ? ' (provisional)' : ''} → contact ${resolvedId}`,
        },
      });
    });
    return true;
  }

  /** System-actor counterpart of upgradeProvisional. */
  private async upgradeProvisionalSystem(
    workspaceId: string,
    intake: LeadIntake,
  ): Promise<boolean> {
    const fedCtx: FederationContext = { workspaceId, ucUid: null };
    const upserted = await this.contactOps.upsertContact(fedCtx, this.toIdentity(intake));
    if (!upserted || !intake.resolvedContactId) return false;
    const oldId = intake.resolvedContactId;
    const newId = upserted.contactId;
    if (newId === oldId) return false; // already canonical-shaped; nothing to swap

    await this.workspaces.runInWorkspace(workspaceId, null, async (tx) => {
      const canonical = await tx.customer.findFirst({ where: { contactId: newId } });
      if (canonical && intake.customerId && canonical.id !== intake.customerId) {
        await tx.customerActivity.updateMany({
          where: { customerId: intake.customerId },
          data: { customerId: canonical.id },
        });
        await tx.customer.delete({ where: { id: intake.customerId } });
        await tx.leadIntake.update({
          where: { id: intake.id },
          data: {
            resolvedContactId: newId,
            provisional: false,
            customerId: canonical.id,
            statusDetail: `Provisional ${oldId} merged into canonical ${newId}`,
          },
        });
      } else if (intake.customerId) {
        await tx.customer.update({ where: { id: intake.customerId }, data: { contactId: newId } });
        await tx.leadIntake.update({
          where: { id: intake.id },
          data: {
            resolvedContactId: newId,
            provisional: false,
            statusDetail: `Provisional ${oldId} upgraded to canonical ${newId}`,
          },
        });
      }
    });
    return true;
  }

  /** Re-resolve a provisional intake through Contact-Ops; on success swap the
   *  provisional contactId for the canonical person_id on the intake + the
   *  Customer projection (merging into any existing canonical relationship). */
  private async upgradeProvisional(
    user: AuthedUser,
    intake: LeadIntake,
    requestedWorkspaceId?: string | null,
  ): Promise<boolean> {
    const fedCtx: FederationContext = {
      workspaceId: await this.workspaces.resolveAuthorized(user, requestedWorkspaceId),
      ucUid: ucUidOf(user) || null,
    };
    const upserted = await this.contactOps.upsertContact(fedCtx, this.toIdentity(intake));
    if (!upserted || !intake.resolvedContactId) return false;
    const oldId = intake.resolvedContactId;
    const newId = upserted.contactId;
    if (newId === oldId) return false; // already canonical-shaped; nothing to swap

    await this.workspaces.runForUser(
      user,
      async (tx) => {
        // Is there already a relationship on the canonical id? Merge into it.
        const canonical = await tx.customer.findFirst({ where: { contactId: newId } });
        if (canonical && intake.customerId && canonical.id !== intake.customerId) {
          // Move the activity trail to the canonical relationship, then drop the
          // provisional one (its unique (ws, contactId) would otherwise block the
          // id swap). The intake re-points at the canonical projection.
          await tx.customerActivity.updateMany({
            where: { customerId: intake.customerId },
            data: { customerId: canonical.id },
          });
          await tx.customer.delete({ where: { id: intake.customerId } });
          await tx.leadIntake.update({
            where: { id: intake.id },
            data: {
              resolvedContactId: newId,
              provisional: false,
              customerId: canonical.id,
              statusDetail: `Provisional ${oldId} merged into canonical ${newId}`,
            },
          });
        } else if (intake.customerId) {
          // No canonical relationship yet — just rename the provisional id.
          await tx.customer.update({
            where: { id: intake.customerId },
            data: { contactId: newId },
          });
          await tx.leadIntake.update({
            where: { id: intake.id },
            data: {
              resolvedContactId: newId,
              provisional: false,
              statusDetail: `Provisional ${oldId} upgraded to canonical ${newId}`,
            },
          });
        }
      },
      requestedWorkspaceId,
    );
    return true;
  }

  // ========================================================================
  // OBSERVABILITY — list / get / discard the intake buffer.
  // ========================================================================

  async listForUser(
    user: AuthedUser,
    query: ListIntakesQueryDto,
    requestedWorkspaceId?: string | null,
  ) {
    const rows = await this.workspaces.runForUser(
      user,
      (tx) => {
        const where: Prisma.LeadIntakeWhereInput = {};
        if (query.status) where.status = query.status;
        if (query.source) where.source = query.source;
        return tx.leadIntake.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: query.limit ?? 50,
          skip: query.offset ?? 0,
        });
      },
      requestedWorkspaceId,
    );
    const items = rows.map((r) => this.serialize(r));
    return { items, count: items.length };
  }

  /** Status counts by bucket — the ingestion dashboard's headline numbers. */
  async statsForUser(user: AuthedUser, requestedWorkspaceId?: string | null) {
    const grouped = await this.workspaces.runForUser(
      user,
      (tx) => tx.leadIntake.groupBy({ by: ['status'], _count: { _all: true } }),
      requestedWorkspaceId,
    );
    const byStatus: Record<string, number> = {
      PENDING: 0,
      RESOLVED: 0,
      FAILED: 0,
      DISCARDED: 0,
    };
    let total = 0;
    for (const g of grouped) {
      byStatus[g.status] = g._count._all;
      total += g._count._all;
    }
    return { total, byStatus, coReachable: this.coReachable() };
  }

  async getForUser(user: AuthedUser, id: string, requestedWorkspaceId?: string | null) {
    const row = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const r = await tx.leadIntake.findUnique({ where: { id } });
        if (!r) throw new NotFoundException(`Lead intake ${id} not found`);
        return r;
      },
      requestedWorkspaceId,
    );
    return this.serialize(row);
  }

  async discardForUser(
    user: AuthedUser,
    id: string,
    dto: DiscardIntakeDto,
    requestedWorkspaceId?: string | null,
  ) {
    const row = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const r = await tx.leadIntake.findUnique({ where: { id } });
        if (!r) throw new NotFoundException(`Lead intake ${id} not found`);
        if (r.status === LeadIntakeStatus.RESOLVED) {
          throw new BadRequestException(
            'Cannot discard a RESOLVED intake — its relationship already exists. ' +
              'Mark the relationship lost instead.',
          );
        }
        return tx.leadIntake.update({
          where: { id },
          data: {
            status: LeadIntakeStatus.DISCARDED,
            statusDetail: dto.reason?.trim() || 'Discarded',
          },
        });
      },
      requestedWorkspaceId,
    );
    return this.serialize(row);
  }

  // ========================================================================
  // LeadLabelResolver — provisional cockpit labels (the dormant-CO fallback).
  // ========================================================================

  async labels(
    user: { id: string } & Record<string, unknown>,
    requestedWorkspaceId: string | null,
    provisionalContactIds: string[],
  ): Promise<Map<string, LeadLabel>> {
    const out = new Map<string, LeadLabel>();
    const ids = [...new Set(provisionalContactIds.filter(isProvisionalContactId))];
    if (ids.length === 0) return out;
    try {
      const rows = await this.workspaces.runForUser(
        user as AuthedUser,
        (tx) =>
          tx.leadIntake.findMany({
            where: { resolvedContactId: { in: ids }, provisional: true },
            select: {
              resolvedContactId: true,
              displayName: true,
              email: true,
              orgName: true,
              tags: true,
            },
          }),
        requestedWorkspaceId,
      );
      for (const r of rows) {
        if (!r.resolvedContactId) continue;
        out.set(r.resolvedContactId, {
          displayName: r.displayName ?? '(unnamed lead)',
          primaryEmail: r.email ?? null,
          currentOrgName: r.orgName ?? null,
          tags: r.tags ?? [],
        });
      }
    } catch (err) {
      this.logger.warn(`provisional label resolve failed: ${(err as Error).message}`);
    }
    return out;
  }

  // ========================================================================
  // HELPERS
  // ========================================================================

  /** The intake's identity, shaped for the Contact-Ops upsert. */
  private toIdentity(intake: LeadIntake): ContactIdentityInput {
    const envelope = (intake.rawPayload ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
    const strArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    const organizationName = intake.orgName?.trim();
    const organizationDomain = organizationName
      ? organizationDomainFromEmail(intake.email)
      : undefined;
    return {
      source: intake.source,
      sourceDedupKey: intake.sourceDedupKey,
      displayName: intake.displayName,
      givenName: str(envelope['given_name']),
      familyName: str(envelope['family_name']),
      nicknames: strArr(envelope['nicknames']),
      email: intake.email,
      phone: intake.phone,
      orgName: intake.orgName,
      ...(organizationName
        ? {
            organization: {
              name: organizationName,
              ...(organizationDomain ? { domain: organizationDomain } : {}),
            },
          }
        : {}),
      tags: intake.tags,
    };
  }

  /** A deterministic provisional contactId from the strongest identity key, so a
   *  re-ingest of the same person yields the same id (→ the same projection). */
  private mintProvisional(workspaceId: string, intake: LeadIntake): string {
    const key =
      intake.email?.toLowerCase() ||
      intake.phone ||
      (intake.displayName && intake.orgName
        ? `${intake.displayName.toLowerCase()}|${intake.orgName.toLowerCase()}`
        : intake.displayName?.toLowerCase()) ||
      `${intake.source}:${intake.sourceDedupKey}`;
    const hash = createHash('sha256').update(`${workspaceId}:${key}`).digest('hex').slice(0, 32);
    return `${PROVISIONAL_PREFIX}${hash}`;
  }

  /** Whether Contact-Ops is configured for this deployment (drives the
   *  provisional-upgrade pass + the dashboard's "connect Contact-Ops" affordance). */
  private coReachable(): boolean {
    const raw = this.config.get<string>('CONTACT_OPS_BASE_URL');
    return !!(raw && raw.trim());
  }

  /** The workspace id the current RLS transaction is bound to (GUC read). */
  private async boundWorkspaceId(tx: WorkspaceTxClient): Promise<string> {
    const rows = await tx.$queryRaw<
      Array<{ ws: string | null }>
    >`SELECT current_workspace_id() AS ws`;
    const ws = rows?.[0]?.ws;
    if (!ws) throw new BadRequestException('No workspace bound to the request transaction');
    return ws;
  }

  /** Serialize a LeadIntake row to the wire shape (Decimal → string). */
  private serialize(row: LeadIntake): SerializedIntake {
    return {
      id: row.id,
      source: row.source,
      sourceDedupKey: row.sourceDedupKey,
      status: row.status,
      displayName: row.displayName,
      email: row.email,
      phone: row.phone,
      orgName: row.orgName,
      tags: row.tags ?? [],
      score: row.score,
      expectedValue: row.expectedValue != null ? row.expectedValue.toString() : null,
      currency: row.currency,
      priority: row.priority,
      ownerUserKey: row.ownerUserKey,
      notes: row.notes,
      resolvedContactId: row.resolvedContactId,
      provisional: row.provisional,
      customerId: row.customerId,
      statusDetail: row.statusDetail,
      createdByUcUid: row.createdByUcUid,
      resolvedAt: row.resolvedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

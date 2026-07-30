import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PersonalAccessToken, User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipService } from '../../common/workspace/membership.service';
import { WorkspaceEntitlementsResolver } from '../../common/workspace/workspace-entitlements.resolver';
import {
  entitlementsOf,
  intersectEntitlements,
  WithWorkspaceClaim,
} from '../../common/workspace/workspace.util';
import { PAT_AVAILABLE_SCOPES, PAT_PREFIX, PatScope } from './pat.constants';
import { generatePat, isPatToken, verifyPat } from './pat.util';

export interface CreatePatInput {
  name: string;
  scopes?: string[];
  expiresAt?: Date | null;
  /**
   * Workspace to bind the token to. When provided it MUST be one the caller is
   * an active member of (enforced via MembershipService); when omitted the
   * token binds to the caller's default-membership workspace.
   */
  workspaceId?: string | null;
}

export interface CreatePatResult {
  id: string;
  plaintext: string;
  prefix: string;
  name: string;
  scopes: string[];
  /** SKUs snapshotted at create time: the session claim ∩ the workspace's set. */
  entitlements: string[];
  workspaceId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

/** Metadata view of a PAT — safe to return. Never the plaintext or the hash. */
export interface PatMetadata {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  workspaceId: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface PatResolution {
  user: User;
  token: PersonalAccessToken;
  /** The workspace this PAT is bound to; the auth chokepoint fences on it. */
  workspaceId: string | null;
  /**
   * The SKUs this PAT carries RIGHT NOW — the mint snapshot re-intersected with
   * the bound workspace's current server-side set. This, NOT `token.entitlements`,
   * is what the auth chokepoint stamps as `__entitlements`. `[]` on any error.
   */
  entitlements: string[];
}

/**
 * Personal Access Token store + resolver.
 *
 * The PAT table is USER-scoped + app-enforced (NOT under RLS — see the
 * migration header), so every method uses the plain `this.prisma` client (no
 * `withWorkspace`): the resolver runs at auth time before any workspace GUC
 * exists. Ownership is enforced in code (`where: { userId }`).
 */
@Injectable()
export class PatService {
  private readonly logger = new Logger(PatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: MembershipService,
    /**
     * Server-side, per-workspace entitlement source. @Optional so the PAT store
     * can still be unit-constructed with just (prisma, membership); when it is
     * absent the mint snapshot is the only source (the pre-fix behaviour) — the
     * DI container always provides it in the running app.
     */
    @Optional()
    private readonly workspaceEntitlements?: WorkspaceEntitlementsResolver,
  ) {}

  /**
   * Create a PAT for a user. Returns the plaintext token exactly once; callers
   * MUST surface it and never persist it again. Bound to a single workspace
   * (explicit `workspaceId` validated as an active membership, else the
   * caller's default membership) — a no-op echo while tenancy is off, a hard
   * 403 on a non-member workspace when it is on.
   */
  async create(
    user: User & Partial<WithWorkspaceClaim>,
    input: CreatePatInput,
  ): Promise<CreatePatResult> {
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('Token name is required');
    if (name.length > 100) throw new BadRequestException('Token name must be 100 characters or less');

    const scopes = this.normalizeScopes(input.scopes);
    const expiresAt = this.normalizeExpiry(input.expiresAt);
    const resolvedWorkspaceId = await this.membership.resolveAndAuthorize(
      user,
      input.workspaceId ?? null,
    );
    // BLANK IS ABSENT, AND ABSENT IS UNMINTABLE.
    //
    // The auth chokepoint's sentinel (findByPlaintext) refuses any PAT whose
    // workspaceId is null OR blank, because such a token skips every workspace
    // fence. That is right — but it means persisting a blank here mints a
    // credential that is DEAD FOREVER while returning `201 Created` with a
    // plaintext token. `MembershipService.bootstrapWorkspaceId` now normalises a
    // blank `DEFAULT_WORKSPACE_ID` away, so this should be unreachable; keep it
    // anyway, because "unreachable" is exactly what the previous blank-vs-null
    // analysis assumed. Refusing loudly at the WRITE is recoverable; a bricked
    // token discovered as a 401 weeks later is not.
    const workspaceId = (resolvedWorkspaceId ?? '').trim();
    if (!workspaceId) {
      this.logger.error(
        `PAT mint REFUSED for user ${user.id}: workspace resolution produced a blank id ` +
          `(check DEFAULT_WORKSPACE_ID — an explicitly-empty value is a misconfiguration). ` +
          `Refusing to persist an unbindable token that every request would reject.`,
      );
      throw new ServiceUnavailableException(
        'Cannot issue a token right now: no workspace could be resolved for this account.',
      );
    }
    // Snapshot the minting session user's verified entitlement SKUs, SCOPED TO
    // THE TOKEN'S WORKSPACE. The mint route is JWT-only, so `user.__entitlements`
    // here is the session token's live claim — but that claim is the user's
    // union across every org they belong to, so snapshotting it raw would let a
    // PAT bound to workspace B carry a SKU only workspace A bought. Intersect it
    // with `workspaceId`'s server-side entitlements first (null source ⇒ the
    // claim unchanged, today's shared-SaaS default). The snapshot is a FLOOR, not
    // the authority: `findByPlaintext` re-intersects it with the workspace's
    // CURRENT server-side set on every request so revocation still lands.
    //
    // A resolver that cannot answer FAILS THE MINT (503) — see serverSideSkus.
    const entitlements = intersectEntitlements(
      entitlementsOf(user),
      await this.serverSideSkus(workspaceId),
    );

    const { plaintext, hash: hashPromise } = generatePat();
    const tokenHash = await hashPromise;

    const row = await this.prisma.personalAccessToken.create({
      data: {
        userId: user.id,
        workspaceId,
        name,
        prefix: PAT_PREFIX,
        tokenHash,
        scopes,
        entitlements,
        expiresAt,
      },
    });

    this.logger.log(
      `Minted PAT ${row.id} for user ${user.id} (workspace=${workspaceId}, scopes=[${scopes.join(',')}], entitlements=[${entitlements.join(',')}], expiresAt=${expiresAt?.toISOString() ?? 'never'})`,
    );

    return {
      id: row.id,
      plaintext,
      prefix: row.prefix,
      name: row.name,
      scopes: row.scopes,
      entitlements: row.entitlements,
      workspaceId: row.workspaceId,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }

  /**
   * Resolve a plaintext PAT to its owning user. Returns null on any failure (no
   * match / revoked / expired / owner inactive) so the caller emits one generic
   * 401. Bumps `lastUsedAt` (fire-and-forget). O(n) bcrypt scan over active
   * tokens — fine at low volume (add a SHA-256 fast-lookup index later if it
   * ever isn't).
   */
  async findByPlaintext(plaintext: string): Promise<PatResolution | null> {
    if (!isPatToken(plaintext)) return null;

    const now = new Date();
    const candidates = await this.prisma.personalAccessToken.findMany({
      where: { revokedAt: null, AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }] },
      include: { user: true },
    });

    for (const token of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const match = await verifyPat(plaintext, token.tokenHash);
      if (!match) continue;
      if (!token.user || !token.user.isActive) return null;

      // Fire-and-forget the lastUsedAt bump — losing a timestamp is not a 500.
      this.prisma.personalAccessToken
        .update({ where: { id: token.id }, data: { lastUsedAt: now } })
        .catch((err) =>
          this.logger.warn(`Failed to bump lastUsedAt for PAT ${token.id}: ${(err as Error).message}`),
        );

      const { user, ...bare } = token;
      const bareToken = bare as PersonalAccessToken;

      // SENTINEL — an UNFENCED token is not a token.
      //
      // `personal_access_tokens.workspaceId` is NULLABLE (it has been since the
      // table was created). Every code path that fences a PAT is written as
      // `if (workspaceId) { …fence… }`: the guard's explicit-workspace check
      // (jwt-auth.guard.ts), the MCP `workspace_id` arg check (mcp-access.ts),
      // and the entitlement bind below. A NULL therefore does not fail those
      // checks — it SKIPS them, yielding a PAT that can address any workspace it
      // likes. Refuse it here, at the one chokepoint every PAT request passes
      // through, rather than trusting three separate `if`s to stay correct forever.
      //
      // ⚠️ CORRECTION to this comment's earlier claim that "create() has never
      // produced one": true for NULL, NOT for a BLANK. With tenancy off and
      // `DEFAULT_WORKSPACE_ID` explicitly set to the empty string,
      // MembershipService.resolveAndAuthorize returned `''` (ConfigService's
      // default argument only fires on `undefined`) and `create()` persisted
      // `workspaceId: ''` — which this sentinel then 401'd forever, bricking a
      // token that worked before the sentinel existed. Fixed at the WRITE side
      // (bootstrapWorkspaceId normalises blank -> fallback, and `create()`
      // refuses a blank outright), so a legitimately-minted token can no longer
      // be bricked here. This stays the last line for hand-inserted rows,
      // restored backups, and migrations that widen the column's use.
      //
      // Returns null => the caller emits the same generic 401 as any other bad
      // token. Fail closed: an unbindable credential denies, it does not roam.
      if (!bareToken.workspaceId || !bareToken.workspaceId.trim()) {
        this.logger.error(
          `PAT ${bareToken.id} REJECTED: no bound workspace (workspaceId is null/blank). ` +
            `A PAT with no workspace binding would skip every workspace fence. ` +
            `This row cannot have been created by PatService.create — revoke it and re-mint.`,
        );
        return null;
      }

      return {
        user,
        token: bareToken,
        workspaceId: bareToken.workspaceId,
        entitlements: await this.effectiveEntitlementsFor(bareToken),
      };
    }

    return null;
  }

  /**
   * The entitlement SKUs a PAT actually carries THIS request — the live,
   * workspace-scoped answer the auth chokepoint stamps onto `__entitlements`.
   *
   * A PAT has no forwardable user JWT, so there is nothing to hand the suite
   * entitlements endpoint on the caller's behalf. Instead we resolve the token's
   * BOUND WORKSPACE server-side (WorkspaceEntitlementsResolver: operator pin ->
   * endpoint via a service credential -> durable mirror, bounded cache) and
   * INTERSECT it with the mint-time snapshot:
   *
   *   * server-side answer present -> snapshot ∩ workspace. Can only NARROW, so a
   *     SKU revoked at the authority stops working within the resolver's TTL
   *     (default 60s) and a snapshot can never grant a SKU the workspace lacks.
   *   * server-side answer null (NO source configured — today's shared-SaaS
   *     default) -> the snapshot, unchanged. This is the documented fallback; the
   *     revocation window on that configuration is bounded only by PAT
   *     revoke/expiry. See docs/runbooks/entitlement-enforce.md §1f.
   *   * a token bound to NO workspace -> `[]` (deny). There is nothing to bind
   *     to, so the claim is unbindable — see the sentinel in findByPlaintext,
   *     which already refuses such a row; this is the second line of that fence.
   *   * ANY error -> `[]`, i.e. FAIL CLOSED. Under UC_ENTITLEMENT_MODE=enforce an
   *     indeterminate entitlement set is a deny; we never fall back to a wider
   *     set on failure. (Returning [] rather than throwing keeps auth itself
   *     working — the request is still authenticated, it just holds no SKUs.)
   */
  private async effectiveEntitlementsFor(token: PersonalAccessToken): Promise<string[]> {
    const snapshot = token.entitlements ?? [];
    // No resolver injected at all (a unit-constructed PatService) => the mint
    // snapshot is the only source, the documented pre-resolver behaviour.
    if (!this.workspaceEntitlements) return snapshot;
    // Bound to no workspace => unbindable => deny. NOT the snapshot.
    if (!token.workspaceId || !token.workspaceId.trim()) {
      this.logger.error(
        `PAT ${token.id}: no bound workspace — entitlements are unbindable, denying (no SKUs).`,
      );
      return [];
    }
    try {
      const server = await this.workspaceEntitlements.skusFor(token.workspaceId);
      if (server === null) return snapshot; // no server-side source -> snapshot
      return intersectEntitlements(snapshot, server);
    } catch (err) {
      this.logger.error(
        `PAT ${token.id}: workspace entitlement resolve failed (${(err as Error)?.message ?? 'error'}) — failing closed (no entitlements)`,
      );
      return [];
    }
  }

  /**
   * A workspace's server-side SKUs at MINT time, or null when there is no
   * server-side source.
   *
   * FAILS THE MINT (503) rather than snapshotting a fail-closed `[]`.
   *
   * WHY — a mint is not a request, it is a WRITE that outlives the failure. The
   * snapshot column is only ever re-INTERSECTED at auth time (never re-widened),
   * so persisting `[]` because the resolver blipped for one second produces a
   * PERMANENTLY DEAD credential: it holds no SKUs, it can never regain any once
   * the source recovers, and the user was handed a `201 Created` with a
   * plaintext token and no indication anything went wrong. They discover it as a
   * 403 at some later, unrelated moment.
   *
   * An indeterminate answer (`stale`, or the resolver's own fail-closed 'error')
   * is treated the same as a thrown error: refuse to mint, say so, let the caller
   * retry. Fail-closed at auth time is a deny you can recover from; fail-closed at
   * mint time is a deny you cannot.
   */
  private async serverSideSkus(workspaceId: string | null): Promise<string[] | null> {
    if (!this.workspaceEntitlements || !workspaceId) return null;

    let resolution;
    try {
      resolution = await this.workspaceEntitlements.resolve(workspaceId);
    } catch (err) {
      this.logger.error(
        `PAT mint REFUSED: workspace ${workspaceId} entitlement resolve threw ` +
          `(${(err as Error)?.message ?? 'error'}). Refusing to persist an empty, ` +
          `permanently-dead entitlement snapshot.`,
      );
      throw new ServiceUnavailableException(
        'Cannot issue a token right now: the workspace entitlement source is unavailable. ' +
          'Please retry.',
      );
    }

    if (resolution.stale) {
      // A source EXISTS but could not give a current answer (expired mirror,
      // configured-but-unavailable endpoint, DB error). Same reasoning: do not
      // bake that moment into a credential.
      this.logger.error(
        `PAT mint REFUSED: workspace ${workspaceId} entitlements are INDETERMINATE ` +
          `(source=${resolution.source}). Refusing to persist an empty, permanently-dead ` +
          `entitlement snapshot.`,
      );
      throw new ServiceUnavailableException(
        'Cannot issue a token right now: the workspace entitlement source is unavailable. ' +
          'Please retry.',
      );
    }

    return resolution.skus;
  }

  /** List the user's PATs (metadata only). Newest first; includes revoked. */
  async list(userId: string): Promise<PatMetadata[]> {
    const rows = await this.prisma.personalAccessToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toMetadata(r));
  }

  /** Soft-revoke. Idempotent (re-revoke is a no-op). 404 if not owned. */
  async revoke(userId: string, id: string): Promise<PatMetadata> {
    const existing = await this.prisma.personalAccessToken.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) throw new NotFoundException('Token not found');
    if (existing.revokedAt) return this.toMetadata(existing);

    const updated = await this.prisma.personalAccessToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    this.logger.log(`Revoked PAT ${id} for user ${userId}`);
    return this.toMetadata(updated);
  }

  private toMetadata(r: PersonalAccessToken): PatMetadata {
    return {
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes,
      workspaceId: r.workspaceId,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      revokedAt: r.revokedAt,
    };
  }

  private normalizeScopes(scopes?: string[]): PatScope[] {
    if (!scopes || scopes.length === 0) {
      // A brand-new token defaults to read-only across the cockpit so it works
      // for observation immediately but not for mutation.
      return ['read:customers', 'read:activity', 'read:leads', 'read:overview'];
    }
    const allowed = new Set<string>(PAT_AVAILABLE_SCOPES);
    const cleaned = Array.from(new Set(scopes.map((s) => s.trim()).filter(Boolean)));
    const invalid = cleaned.filter((s) => !allowed.has(s));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Unknown scope(s): ${invalid.join(', ')}. Allowed: ${PAT_AVAILABLE_SCOPES.join(', ')}`,
      );
    }
    return cleaned as PatScope[];
  }

  private normalizeExpiry(expiresAt?: Date | string | null): Date | null {
    if (expiresAt === null || expiresAt === undefined || (expiresAt as unknown) === '') return null;
    const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('expiresAt must be a valid date');
    if (d.getTime() <= Date.now()) throw new BadRequestException('expiresAt must be in the future');
    return d;
  }
}

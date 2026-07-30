import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementsService } from '../../entitlements/entitlements.service';
import { parseWorkspaceEntitlements } from './workspace.util';

/**
 * Where a workspace's server-side entitlement set came from. Reported for
 * observability + so callers can tell "authoritative" from "no source".
 */
export type WorkspaceEntitlementSource =
  /** Workspace.entitlementCache — the operator pin (offline/dedicated). */
  | 'operator-cache'
  /** A fresh 200 from the entitlements endpoint (also written to the mirror). */
  | 'endpoint'
  /** An unexpired workspace_entitlements mirror row. */
  | 'mirror'
  /** A mirror row PAST its expiresAt — a source exists but could not refresh. */
  | 'stale-mirror'
  /**
   * The entitlements endpoint IS configured but could not answer (non-2xx,
   * network error, timeout, unparseable body) and there is no persisted mirror
   * to narrow to. A source exists; we simply do not know the answer.
   * INDETERMINATE ⇒ deny. Distinct from `'none'` on purpose — see the class doc.
   */
  | 'source-unavailable'
  /** A read/refresh error — indeterminate. */
  | 'error'
  /** Nothing anywhere: no server-side source for this workspace. */
  | 'none';

export interface WorkspaceEntitlementResolution {
  /**
   * The workspace's server-side SKUs, or `null` when there is NO server-side
   * source at all (the caller then trusts the token claim / PAT snapshot — see
   * `intersectEntitlements`). `[]` is a real, DENY-ALL answer.
   */
  skus: string[] | null;
  source: WorkspaceEntitlementSource;
  /**
   * true when a source EXISTS but we could not get a current answer. `skus` is
   * `[]` in that case — an indeterminate answer is a DENY under enforce, never a
   * stale grant and never a widening.
   */
  stale: boolean;
}

interface CacheEntry {
  at: number;
  value: WorkspaceEntitlementResolution;
}

export interface ResolveOptions {
  /**
   * Oldest cached answer this caller accepts, in ms. `0` = never serve the
   * in-process cache (always re-read the source). Omitted = the resolver's TTL.
   */
  maxAgeMs?: number;
}

const MAX_ENTRIES = 5_000;

/**
 * Resolves a WORKSPACE's entitlement SKUs server-side, with a bounded cache.
 *
 * WHY THIS EXISTS — the PAT lane had no live entitlement source. A `co_pat_`
 * bearer is not a JWT: `EntitlementsService.resolve()` rejects it (not RS256), so
 * the mint-time snapshot on the token row was authoritative FOREVER. A SKU
 * revoked at the suite authority stayed usable until the PAT was revoked or
 * expired — an unbounded under-enforcement window. Worse, the snapshot was
 * taken from the minting SESSION user (the union of everything that user holds),
 * not from the workspace the PAT is bound to.
 *
 * This resolver is the server-side half: it answers "what does workspace W hold
 * RIGHT NOW", without needing a forwardable user JWT. The PAT lane intersects its
 * frozen snapshot with this answer on every request, so the snapshot can only
 * ever NARROW — revocation lands within the cache TTL and a snapshot can never
 * grant a SKU the workspace does not hold.
 *
 * ⚠️ INERT IN EVERY SHIPPING CONFIG TODAY. Nothing in this repo writes
 * `Workspace.entitlementCache`, and there is no producer for
 * `workspace_entitlements` — so on a default deployment this resolver answers
 * `{ skus: null, source: 'none' }` for every workspace and the lane behaves
 * exactly as it did before. This class is the CONSUMER half of a bind whose
 * PRODUCER is a product decision outside this codebase (TODO(29817abc): a
 * uc-entitlements client, or a per-workspace Keycloak entitlements claim). Read
 * everything below as "what happens once a source exists", not as a claim that
 * anything is being enforced today.
 *
 * REVOCATION WINDOW (documented; see docs/runbooks/entitlement-enforce.md §1f):
 *   * endpoint or operator source present -> <= WORKSPACE_ENTITLEMENTS_TTL_MS
 *     (default 60s) after the authority reflects the change.
 *   * source configured but unreachable   -> IMMEDIATE deny (fail-closed): either
 *     the mirror row is past expiresAt ('stale-mirror') or there is no mirror at
 *     all ('source-unavailable'). Never a stale grant, never a passthrough.
 *   * NO server-side source configured    -> the PAT snapshot remains the only
 *     source and revocation is NOT bounded by this repo. That is the fallback the
 *     shipping default lands on; populate `workspace_entitlements` (or
 *     `Workspace.entitlementCache`) to get a bounded window.
 *
 * Fail posture is CLOSED throughout: any DB/parse/endpoint error on a workspace
 * that HAS a source yields `{ skus: [], stale: true }` (deny), never a widening.
 * A workspace with no source at all still resolves to `null` (trust the claim) —
 * that is the pre-existing behaviour and is preserved deliberately, because
 * denying there would deny every paying user on every gate.
 *
 * THE `'none'` vs `'source-unavailable'` DISTINCTION IS LOAD-BEARING. `'none'`
 * means "this deployment has no server-side opinion" and downstream reads as
 * TRUST THE CLAIM. It must therefore only ever be produced by an affirmative
 * "nothing is configured and nothing is persisted" — never by a failure. An
 * earlier revision of this file could not tell the two apart (the endpoint
 * client collapsed 401/403/404/5xx/timeout/parse-error into the same `null` it
 * used for "unconfigured"), so a configured-but-broken endpoint silently
 * degraded to full trust. That is why EntitlementsService.lookupWorkspace now
 * returns a three-state result.
 */
@Injectable()
export class WorkspaceEntitlementsResolver {
  private readonly logger = new Logger(WorkspaceEntitlementsResolver.name);
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly entitlements: EntitlementsService,
  ) {
    this.ttlMs = this.int(
      this.config.get<string>('WORKSPACE_ENTITLEMENTS_TTL_MS') ??
        this.config.get<string>('ENTITLEMENTS_CACHE_TTL_MS'),
      60_000,
    );
  }

  /** The bounded staleness window, in ms. Exposed for the runbook/tests. */
  get cacheTtlMs(): number {
    return this.ttlMs;
  }

  /** Drop the in-process cache (tests + an operator-triggered refresh). */
  invalidate(workspaceId?: string): void {
    if (workspaceId) this.cache.delete(workspaceId);
    else this.cache.clear();
  }

  /**
   * The workspace's server-side SKUs, or `null` when there is no server-side
   * source. Convenience wrapper over {@link resolve} for callers that only need
   * the value (WorkspaceContextService.workspaceEntitlements).
   */
  async skusFor(workspaceId: string, opts?: ResolveOptions): Promise<string[] | null> {
    return (await this.resolve(workspaceId, opts)).skus;
  }

  /**
   * @param opts.maxAgeMs  the OLDEST cached answer this caller will accept, in
   *   ms. Defaults to the resolver's TTL. Pass `0` to bypass the in-process
   *   cache entirely and re-read the source — which is what the JWT lane does,
   *   because before this resolver existed that lane re-read
   *   `Workspace.entitlementCache` from Postgres on EVERY request and an
   *   operator pin edit took effect immediately. Routing it through a 60s cache
   *   would have quietly opened a 60-second under-enforcement window on a lane
   *   that previously had none, so the JWT lane's default max-age is 0. A fresh
   *   answer is still WRITTEN to the cache for the lanes that do accept staleness.
   */
  async resolve(
    workspaceId: string,
    opts?: ResolveOptions,
  ): Promise<WorkspaceEntitlementResolution> {
    if (!workspaceId || !workspaceId.trim()) {
      // No workspace addressed => nothing to bind to. Not an error, and not a
      // source: the caller keeps its claim-sourced list.
      return { skus: null, source: 'none', stale: false };
    }
    const key = workspaceId.trim();

    const maxAgeMs =
      typeof opts?.maxAgeMs === 'number' && Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs >= 0
        ? opts.maxAgeMs
        : this.ttlMs;

    const now = Date.now();
    const hit = this.cache.get(key);
    if (maxAgeMs > 0 && hit && now - hit.at < maxAgeMs) return hit.value;

    let value: WorkspaceEntitlementResolution;
    try {
      value = await this.resolveUncached(key);
    } catch (err) {
      // A DB failure on the resolve path is INDETERMINATE, not "no source".
      // Fail closed (deny) — never fall through to an unbounded claim.
      this.logger.error(
        `workspace entitlements resolve failed for ${key}: ${(err as Error)?.message ?? 'error'} — failing closed`,
      );
      value = { skus: [], source: 'error', stale: true };
    }
    this.put(key, { at: now, value });
    return value;
  }

  // --- internals -------------------------------------------------------------

  private async resolveUncached(workspaceId: string): Promise<WorkspaceEntitlementResolution> {
    // 1. Operator pin wins. An offline/dedicated node sets this by hand and it
    //    must never be clobbered or second-guessed by a network source.
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { entitlementCache: true },
    });
    const operator = ws ? parseWorkspaceEntitlements(ws.entitlementCache) : null;
    if (operator !== null) {
      return { skus: operator, source: 'operator-cache', stale: false };
    }

    // 2. Live endpoint (dormant unless ENTITLEMENTS_ENDPOINT_URL *and* a service
    //    credential are configured). A 200 is authoritative and refreshes the
    //    mirror so the answer survives a restart or a later endpoint blip.
    //
    //    THREE states, not two. `unavailable` (a configured endpoint that 401'd /
    //    500'd / timed out / returned junk) must NOT be allowed to reach the
    //    `source: 'none'` return below, because 'none' means TRUST THE CLAIM.
    const lookup = await this.entitlements.lookupWorkspace(workspaceId);
    if (lookup.status === 'ok') {
      const skus = this.entitlements.toSkuList(lookup.data.featureKeys);
      await this.writeMirror(workspaceId, skus, 'endpoint');
      return { skus, source: 'endpoint', stale: false };
    }

    // 3/4. The persisted mirror. When the endpoint is `unavailable` this is the
    //      only legitimate narrowing left — and it carries its own `expiresAt`,
    //      so it can never become an unbounded grant.
    const row = await this.prisma.workspaceEntitlement.findUnique({
      where: { workspaceId },
      select: { skus: true, expiresAt: true },
    });
    if (row) {
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
        this.logger.warn(
          `workspace ${workspaceId} entitlement mirror expired at ${row.expiresAt.toISOString()} ` +
            `and could not be refreshed — failing closed (deny) rather than serving a stale grant`,
        );
        return { skus: [], source: 'stale-mirror', stale: true };
      }
      return { skus: [...row.skus], source: 'mirror', stale: false };
    }

    // 4b. A source IS configured but could not answer, and nothing is persisted
    //     to fall back to. INDETERMINATE — deny. Returning 'none' here (which is
    //     what a two-state `null` forced) would have handed a transient 500 or an
    //     expired service credential the power to silently widen every caller
    //     back to full trust: precisely the "never widens on failure" claim this
    //     lane makes about itself. Fail closed instead.
    if (lookup.status === 'unavailable') {
      this.logger.error(
        `workspace ${workspaceId}: entitlements source is CONFIGURED but unavailable ` +
          `(${lookup.reason}) and no mirror row exists — failing closed (deny). ` +
          `This is NOT "no source": the claim is deliberately not trusted here.`,
      );
      return { skus: [], source: 'source-unavailable', stale: true };
    }

    // 5. No source anywhere for this workspace (nothing configured, nothing
    //    pinned, nothing persisted) — preserve today's behaviour: the caller
    //    trusts its claim / PAT snapshot.
    return { skus: null, source: 'none', stale: false };
  }

  private async writeMirror(
    workspaceId: string,
    skus: string[],
    source: string,
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    try {
      await this.prisma.workspaceEntitlement.upsert({
        where: { workspaceId },
        create: { workspaceId, skus, source, refreshedAt: now, expiresAt },
        update: { skus, source, refreshedAt: now, expiresAt },
      });
    } catch (err) {
      // Losing the mirror write is not fatal — we already have a fresh, in-hand
      // answer. Log and carry on (the in-process cache still bounds the window).
      this.logger.warn(
        `failed to persist workspace entitlement mirror for ${workspaceId}: ${(err as Error)?.message ?? 'error'}`,
      );
    }
  }

  private put(key: string, entry: CacheEntry): void {
    if (this.cache.size >= MAX_ENTRIES && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, entry);
  }

  private int(v: string | undefined, dflt: number): number {
    const n = Number.parseInt((v ?? '').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
  EntitlementsService,
  WorkspaceEntitlementsLookup,
} from '../../entitlements/entitlements.service';
import { entitlementRequestScope } from './entitlement-request-scope';
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
  /**
   * How long THIS entry may be served, in ms. A definitive answer gets the
   * resolver's TTL; an INDETERMINATE one (`stale: true`) gets the much shorter
   * failure TTL, so a one-second upstream blip cannot deny for a full minute.
   * See {@link WorkspaceEntitlementsResolver.failureTtlMs}.
   */
  ttlMs: number;
}

/**
 * What the resolver does when a server-side source IS configured but cannot give
 * a current answer (endpoint unreachable/erroring, expired mirror, DB error) —
 * i.e. the availability/enforcement trade-off during an upstream outage.
 *
 *  - `deny` (DEFAULT): indeterminate ⇒ `skus: []` ⇒ every gate in that workspace
 *    denies. Correct fail-closed behaviour; also means an outage longer than the
 *    mirror TTL denies EVERY user in EVERY workspace on EVERY gate.
 *  - `trust-claim`: indeterminate ⇒ `skus: null` ⇒ downstream falls back to the
 *    caller's token claim / PAT mint snapshot (what this repo did before the
 *    server-side lane existed). This is FAIL-OPEN and must be chosen
 *    deliberately: a broken service credential then silently restores full trust.
 *
 * Unrecognised values fall back to `deny` — an unparseable posture is not a
 * licence to fail open. Mint-time behaviour is unaffected by this setting:
 * `PatService` still refuses to bake an indeterminate moment into a credential.
 */
export type EntitlementOutagePosture = 'deny' | 'trust-claim';

export interface ResolveOptions {
  /**
   * Oldest cached answer this caller accepts, in ms. `0` = never serve the
   * in-process cache (always re-read the source). Omitted = the resolver's TTL.
   */
  maxAgeMs?: number;
}

const MAX_ENTRIES = 5_000;

/**
 * Default lifetime of an INDETERMINATE (failed) answer in the process cache.
 * Deliberately tiny: long enough to collapse a burst of concurrent requests onto
 * one upstream attempt during an outage, short enough that recovery is visible
 * almost immediately. Caching a failure at the SUCCESS ttl (60s) is what turned a
 * 1-second endpoint blip into a 60-second denial. `0` disables it entirely.
 */
const DEFAULT_FAILURE_TTL_MS = 1_000;

/** Re-log the "serving denials" line at most this often while degraded. */
const DEGRADED_RELOG_MS = 60_000;

/** Grep key for the outage log line — quoted in the runbook. */
export const ENTITLEMENTS_DEGRADED_MARKER = 'ENTITLEMENTS-SOURCE-DEGRADED';

/** Grep key for the recovery log line. */
export const ENTITLEMENTS_RECOVERED_MARKER = 'ENTITLEMENTS-SOURCE-RECOVERED';

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
 * OUTAGE POSTURE (`WORKSPACE_ENTITLEMENTS_OUTAGE_POSTURE`, default `deny`) — the
 * availability side of that trade, made explicit rather than implied. With a
 * source configured and unreachable and no usable mirror, the DEFAULT denies:
 * correct fail-closed enforcement, and also an outage that outlives the mirror
 * TTL denies every user in every workspace on every gate. An operator who cannot
 * accept that can set `trust-claim` to fall back to the caller's claim during an
 * outage (fail-OPEN, deliberately opt-in). Either way the resolver logs
 * `ENTITLEMENTS-SOURCE-DEGRADED` the moment it starts serving degraded answers,
 * and `ENTITLEMENTS-SOURCE-RECOVERED` when it stops — an outage is meant to be
 * diagnosable from one grep, not inferred from a wave of 403s.
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
  private readonly failureTtl: number;
  private readonly posture: EntitlementOutagePosture;
  private readonly cache = new Map<string, CacheEntry>();
  /** When the source first stopped answering (null = healthy). Log throttling. */
  private degradedSince: number | null = null;
  private lastDegradedLogAt = 0;

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
    this.failureTtl = this.intAllowZero(
      this.config.get<string>('WORKSPACE_ENTITLEMENTS_FAILURE_TTL_MS'),
      DEFAULT_FAILURE_TTL_MS,
    );
    this.posture = this.readPosture();
  }

  /** The bounded staleness window for a DEFINITIVE answer, in ms. */
  get cacheTtlMs(): number {
    return this.ttlMs;
  }

  /**
   * How long an INDETERMINATE answer is cached, in ms (0 = not cached at all).
   * Separately configurable via `WORKSPACE_ENTITLEMENTS_FAILURE_TTL_MS` precisely
   * so a failure never inherits the 60s success TTL.
   */
  get failureTtlMs(): number {
    return this.failureTtl;
  }

  /** The configured outage posture. Default `deny` (fail closed). */
  get outagePosture(): EntitlementOutagePosture {
    return this.posture;
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

    // 1. REQUEST-SCOPED memo. One source read per workspace per REQUEST, shared
    //    by all ~12 `effectiveEntitlements` call sites, and gone when the request
    //    ends — so this collapses the amplification WITHOUT buying any
    //    cross-request staleness (the `maxAgeMs: 0` JWT lane still re-reads the
    //    source on the next request, which is what makes an operator pin edit
    //    land immediately). Memoising the PROMISE, not the value, also collapses
    //    concurrent call sites (Promise.all in the agents) onto one fetch.
    const scope = entitlementRequestScope();
    if (scope) {
      const inflight = scope.get(key) as Promise<WorkspaceEntitlementResolution> | undefined;
      if (inflight) return inflight;
    }

    // 2. Process cache, bounded by BOTH the caller's max-age and the entry's own
    //    lifetime (a failed answer carries the short failure TTL, not the 60s one).
    const now = Date.now();
    const hit = this.cache.get(key);
    if (maxAgeMs > 0 && hit && now - hit.at < Math.min(maxAgeMs, hit.ttlMs)) return hit.value;

    const pending = this.resolveFresh(key, now);
    // Only a FRESH source read is memoised: a process-cache hit above is not
    // written into the request scope, so a later `maxAgeMs: 0` caller in the same
    // request still gets its guaranteed-fresh read.
    if (scope) scope.set(key, pending);
    return pending;
  }

  // --- internals -------------------------------------------------------------

  /** Read the source, apply the outage posture, and cache with the right TTL. */
  private async resolveFresh(key: string, now: number): Promise<WorkspaceEntitlementResolution> {
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
    value = this.applyOutagePosture(key, value);
    // A FAILURE MUST NOT BE CACHED AT THE SUCCESS TTL. Doing so turned a
    // one-second endpoint blip into a full-TTL (60s) denial that outlived the
    // recovery, and let a `maxAgeMs: 0` JWT read poison the shared cache the PAT
    // lane reads from. Indeterminate answers get `failureTtl` (default 1s, `0` =
    // never served from cache) instead.
    this.put(key, {
      at: now,
      value,
      ttlMs: value.stale ? this.failureTtl : this.ttlMs,
    });
    return value;
  }

  /**
   * Apply the configured outage posture to an indeterminate answer, and make the
   * degradation LOUD — an operator should be able to tell in seconds, not hours,
   * that gates are denying because the entitlement source stopped answering.
   */
  private applyOutagePosture(
    workspaceId: string,
    value: WorkspaceEntitlementResolution,
  ): WorkspaceEntitlementResolution {
    if (!value.stale) {
      this.noteSourceHealthy();
      return value;
    }
    this.noteSourceDegraded(workspaceId, value.source);
    if (this.posture === 'trust-claim') {
      // OPT-IN FAIL-OPEN: `null` reads downstream as "no server-side opinion", so
      // the caller falls back to its token claim / PAT snapshot. `stale` stays
      // true so PAT MINTING still refuses (never bake an outage into a
      // credential) — the posture only governs request-time gating.
      return { skus: null, source: value.source, stale: true };
    }
    return value;
  }

  private noteSourceDegraded(workspaceId: string, source: WorkspaceEntitlementSource): void {
    const now = Date.now();
    const first = this.degradedSince === null;
    if (first) this.degradedSince = now;
    if (!first && now - this.lastDegradedLogAt < DEGRADED_RELOG_MS) return;
    this.lastDegradedLogAt = now;
    const forMs = now - (this.degradedSince ?? now);
    this.logger.error(
      `${ENTITLEMENTS_DEGRADED_MARKER}: the server-side entitlement source is NOT ANSWERING ` +
        `(workspace=${workspaceId}, source=${source}, ` +
        `endpointConfigured=${this.entitlements.isConfigured()}, ` +
        `workspaceLookupConfigured=${this.entitlements.isWorkspaceLookupConfigured()}, ` +
        `posture=${this.posture}, degradedForMs=${forMs}). ` +
        (this.posture === 'deny'
          ? 'The resolver is now serving DENIALS: every entitlement gate for this workspace ' +
            'fails closed until the source recovers. Set ' +
            'WORKSPACE_ENTITLEMENTS_OUTAGE_POSTURE=trust-claim to trade enforcement for ' +
            'availability during an outage (fail-OPEN — read the runbook first).'
          : 'WORKSPACE_ENTITLEMENTS_OUTAGE_POSTURE=trust-claim is set: the resolver is FALLING ' +
            'BACK TO THE CALLER CLAIM (fail-OPEN). Server-side entitlement enforcement is ' +
            'currently OFF for this workspace.'),
    );
  }

  private noteSourceHealthy(): void {
    if (this.degradedSince === null) return;
    const forMs = Date.now() - this.degradedSince;
    this.degradedSince = null;
    this.lastDegradedLogAt = 0;
    this.logger.log(
      `${ENTITLEMENTS_RECOVERED_MARKER}: the server-side entitlement source is answering again ` +
        `after ${forMs}ms; gates resume normal enforcement.`,
    );
  }

  private readPosture(): EntitlementOutagePosture {
    const raw = (this.config.get<string>('WORKSPACE_ENTITLEMENTS_OUTAGE_POSTURE') ?? '')
      .trim()
      .toLowerCase();
    if (!raw) return 'deny';
    if (raw === 'deny' || raw === 'trust-claim') return raw;
    this.logger.warn(
      `WORKSPACE_ENTITLEMENTS_OUTAGE_POSTURE='${raw}' is not recognised (expected 'deny' or ` +
        `'trust-claim') — falling back to 'deny' (fail closed).`,
    );
    return 'deny';
  }

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
    //
    //    THE SERVER-SIDE LANE NEEDS BOTH the endpoint URL *and* the service
    //    credential. `isConfigured()` (URL only) is NOT a proxy for that — a URL
    //    with no credential is a lane that enforces nothing, which is exactly the
    //    footgun `isWorkspaceLookupConfigured()` exists to name. Gate on it HERE,
    //    at the one place the server-side lane actually runs, so the resolver
    //    never even attempts a call it cannot authenticate.
    const lookup: WorkspaceEntitlementsLookup = this.entitlements.isWorkspaceLookupConfigured()
      ? await this.entitlements.lookupWorkspace(workspaceId)
      : { status: 'unconfigured' };
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

  private async writeMirror(workspaceId: string, skus: string[], source: string): Promise<void> {
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

  /** Like {@link int} but `0` is a MEANINGFUL value ("never cache"), not "unset". */
  private intAllowZero(v: string | undefined, dflt: number): number {
    const raw = (v ?? '').trim();
    if (!raw) return dflt;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  }
}

/**
 * UcRegistryClient — the workspace-id MINT seam for self-serve onboarding.
 *
 * uc-registry (uc-ops-center, commander) is the suite's sole minter +
 * system-of-record for workspace ids (SUITE-IDENTITY §4 / handoff-uc-registry):
 * Customer-Ops CONSUMES + mirrors workspace ids, it does NOT authoritatively own
 * them. When a brand-new SSO user provisions their own workspace (open signup
 * mode), the registry must agree on the canonical uuidv7 so every app in the
 * suite keys that tenant identically.
 *
 * THE REAL CONTRACT (verified against uc-ops-center/uc-registry source + the live
 * service on commander, 2026-06-06):
 *   - `POST {UC_REGISTRY_URL}/workspaces`  (NOTE: no `/api/v1` prefix — that
 *     prefix belongs to each app's OWN mirror-read surface, not the registry).
 *   - The suite-preferred flow (handoff-uc-registry §"uuidv7 minting") is
 *     MINT-APP-SIDE: the caller supplies its own canonical uuidv7 as
 *     `workspace_id` and the registry records it IDEMPOTENTLY (201 fresh / 200
 *     re-hit, returning the same id). The registry only mints one itself when
 *     `workspace_id` is omitted. Supplying it makes the id stable across a
 *     registry outage — the mirror row we write next carries the same id either
 *     way, which is exactly what degrade-clean needs.
 *   - Body (`WorkspaceCreate`): `{workspace_id, slug, display_name,
 *     isolation_mode, isolation_tier, status, members:[{user_key, role,
 *     is_default}]}`. Self-serve defaults per SUITE-IDENTITY §5:
 *     isolation_mode=standard, isolation_tier=shared; status=active (the CO
 *     mirror lands active). Owner attribution is a `members[]` row
 *     (role=owner) — the registry has NO scalar owner field.
 *   - Response (`WorkspaceFull`): the canonical `workspace_id` (echoes the
 *     supplied id on idempotent re-hit).
 *
 * DEGRADE-CLEAN (the hard rule): uc-registry is an OPTIONAL dependency. The
 * client generates the canonical uuidv7 FIRST, then tries to register it. When
 * UC_REGISTRY_URL is unset, or the registry is unreachable / errors / returns an
 * unusable id, the client returns THAT SAME locally-generated id (with a WARN)
 * and NEVER throws — so self-serve onboarding works in the dogfood (registry not
 * wired) and during a registry outage, and a later reconciliation can register
 * the id upstream. The `source` says which path confirmed it, so the call site
 * can log it honestly.
 *
 * AUTH: the registry's `POST /workspaces` is service-internal + UNAUTHENTICATED
 * by design (network-gated — bound to localhost / a trusted Tailscale iface; see
 * uc-ops-center .env.example). This client therefore sends no auth by default,
 * but forwards UC_REGISTRY_TOKEN as a bearer when set (forward-compat for a
 * future authenticating proxy). The token is referenced by env-var name only and
 * never logged.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUuidV7, uuidv7 } from './uuidv7';

/** How a minted workspace id was produced — surfaced so the call site can log it. */
export type WorkspaceIdSource = 'uc-registry' | 'local-fallback';

export interface MintedWorkspaceId {
  /** The canonical-shape uuidv7 workspace id. */
  workspaceId: string;
  /** Whether uc-registry minted it or we fell back locally (degrade-clean). */
  source: WorkspaceIdSource;
}

/** What the caller knows about the workspace being created (mint hints). */
export interface MintWorkspaceRequest {
  /**
   * An OPTIONAL caller-minted canonical uuidv7 to register (and to keep on the
   * degrade path). Supply this when the caller needs the id BEFORE the mint
   * round-trip — e.g. to derive a slug from it, or to write a mirror row whose id
   * matches regardless of registry reachability. When omitted, the client mints
   * one itself. A non-v7 value is ignored (the client mints a fresh one) so a bad
   * hint can never produce an invalid id.
   */
  workspaceId?: string | null;
  /** A human label for the new workspace (e.g. derived from the owner's email). */
  displayName: string;
  /**
   * The globally-unique, url-safe slug. The registry treats slug as IMMUTABLE +
   * UNIQUE (a conflicting re-hit is a 409), so this must be the final slug the
   * caller will also write to its mirror row — not a throwaway suggestion.
   */
  slug: string;
  /**
   * The acting user's uchub `sub`. When present, it is sent as the workspace
   * OWNER membership row (`members:[{user_key, role:'owner', is_default:true}]`)
   * — the registry has no scalar owner field; ownership is coarse membership.
   */
  ownerUcUid?: string | null;
}

@Injectable()
export class UcRegistryClient {
  private readonly logger = new Logger(UcRegistryClient.name);

  constructor(private readonly config: ConfigService) {
    if (!this.baseUrl) {
      this.logger.warn(
        'UC_REGISTRY_URL unset — workspace ids for self-serve signups will be ' +
          'minted LOCALLY (valid uuidv7, not yet registered upstream).',
      );
    } else {
      this.logger.log(`uc-registry mint target: ${this.baseUrl}`);
    }
  }

  // --- configuration seam --------------------------------------------------

  private get baseUrl(): string | null {
    const raw = this.config.get<string>('UC_REGISTRY_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('UC_REGISTRY_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 8000;
  }

  // --- the mint ------------------------------------------------------------

  /**
   * Mint a NEW canonical workspace id for `req`. Generates a local uuidv7 FIRST,
   * then registers THAT id with uc-registry (`POST /workspaces`, idempotent on the
   * supplied id). Returns the same id whether the registry confirms it
   * (source='uc-registry') or is unconfigured/unreachable/unusable
   * (source='local-fallback', with a WARN). NEVER throws — the id is stable
   * across a registry outage, so the mirror row written next is always consistent.
   */
  async mintWorkspaceId(req: MintWorkspaceRequest): Promise<MintedWorkspaceId> {
    // Mint app-side first (handoff-uc-registry: "Mint app-side is preferred …
    // POST /workspaces is idempotent on a supplied UUID"). This is the canonical
    // id regardless of whether the registry is reachable. Honour a caller-minted
    // v7 (so the caller can derive its slug / mirror row from the same id); a
    // missing/invalid hint => mint a fresh one here.
    const workspaceId = isUuidV7(req.workspaceId) ? (req.workspaceId as string) : uuidv7();

    const base = this.baseUrl;
    if (!base) {
      // Unconfigured: the constructor already warned once; fall back quietly so we
      // don't log per-signup noise. The id is still a valid canonical v7.
      return { workspaceId, source: 'local-fallback' };
    }

    const confirmed = await this.registerWorkspace(base, workspaceId, req);
    if (confirmed) {
      return { workspaceId: confirmed, source: 'uc-registry' };
    }

    // Reachable-but-unusable, or transport error: keep OUR id (degrade-clean).
    // registerWorkspace() already logged the specific reason.
    this.logger.warn(
      `uc-registry registration unavailable — using locally-minted workspace id ${workspaceId} ` +
        '(not yet confirmed upstream; a reconciliation can register it later).',
    );
    return { workspaceId, source: 'local-fallback' };
  }

  /**
   * Register `workspaceId` with uc-registry via `POST /workspaces` (idempotent on
   * the supplied id) and confirm the canonical id it echoes back. Returns null
   * (so the caller keeps the locally-minted id) on any transport error, non-2xx,
   * unparseable body, or an id that doesn't match what we supplied.
   */
  private async registerWorkspace(
    base: string,
    workspaceId: string,
    req: MintWorkspaceRequest,
  ): Promise<string | null> {
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${base}/workspaces`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(this.createBody(workspaceId, req)),
      });
    } catch (err) {
      this.logger.warn(`uc-registry register transport error: ${(err as Error).message}`);
      return null;
    }
    if (!res.ok) {
      // 409 == a slug/immutable-field conflict (a genuinely unexpected collision
      // for a fresh v7 + unique slug); any non-2xx degrades to our local id.
      this.logger.warn(`uc-registry register HTTP ${res.status}`);
      return null;
    }
    let raw: Record<string, unknown>;
    try {
      raw = (await res.json()) as Record<string, unknown>;
    } catch {
      this.logger.warn('uc-registry register returned an unparseable body');
      return null;
    }
    // WorkspaceFull echoes `workspace_id` (== the id we supplied on a re-hit).
    // Accept a bare `id` too for resilience. It MUST be a usable v7; we don't
    // require an exact string match (the registry is the authority on the id),
    // but for a supplied id it will be identical.
    const id = (raw['workspace_id'] ?? raw['id']) as unknown;
    if (typeof id !== 'string' || !isUuidV7(id)) {
      this.logger.warn('uc-registry register returned no usable uuidv7 workspace id');
      return null;
    }
    return id;
  }

  /**
   * The `WorkspaceCreate` body for `POST /workspaces`. Supplies our minted id,
   * the final (immutable+unique) slug, the self-serve isolation defaults
   * (SUITE-IDENTITY §5), an active status (the CO mirror lands active), and — when
   * we know the owner — an OWNER membership row (the registry's only ownership
   * surface; there is no scalar owner field).
   */
  private createBody(workspaceId: string, req: MintWorkspaceRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      workspace_id: workspaceId,
      slug: req.slug,
      display_name: req.displayName,
      isolation_mode: 'standard',
      isolation_tier: 'shared',
      status: 'active',
    };
    const owner = req.ownerUcUid?.trim();
    if (owner) {
      body['members'] = [{ user_key: owner, role: 'owner', is_default: true }];
    }
    return body;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.config.get<string>('UC_REGISTRY_TOKEN');
    if (token && token.trim()) headers['Authorization'] = `Bearer ${token.trim()}`;
    return headers;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

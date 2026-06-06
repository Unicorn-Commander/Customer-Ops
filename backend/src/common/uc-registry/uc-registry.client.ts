/**
 * UcRegistryClient — the workspace-id MINT seam for self-serve onboarding.
 *
 * uc-registry is the suite's authority for workspace ids (SUITE-IDENTITY §0.1 /
 * §4): Customer-Ops CONSUMES workspace ids, it does NOT authoritatively mint
 * them. When a brand-new SSO user provisions their own workspace (open signup
 * mode), the canonical id must come from uc-registry so every app in the suite
 * agrees on the same uuidv7 for that tenant.
 *
 * DEGRADE-CLEAN (the hard rule): uc-registry is an OPTIONAL dependency. When
 * UC_REGISTRY_URL is unset, or uc-registry is unreachable / errors / returns an
 * unusable id, this client falls back to a locally-generated uuidv7 and logs ONE
 * WARN — it NEVER throws. That keeps self-serve onboarding working in the dogfood
 * (where uc-registry isn't wired yet) and during a registry outage; the locally
 * minted id is still a valid canonical-shape v7, and a later reconciliation can
 * register it upstream if/when uc-registry comes online. The `source` on the
 * result says which path produced the id, so the call site can log it honestly.
 *
 * AUTH: the mint is a server-to-server call. When UC_REGISTRY_TOKEN is set it is
 * forwarded as a bearer; the endpoint is otherwise called unauthenticated (a
 * dev/registry that gates by network). The token is referenced by env-var name
 * only and never logged.
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
  /** A human label for the new workspace (e.g. derived from the owner's email). */
  displayName: string;
  /** A url-safe slug suggestion; uc-registry may canonicalize/ignore it. */
  slug: string;
  /** The acting user's uchub `sub` — the workspace owner, for registry attribution. */
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
   * Mint a NEW canonical workspace id for `req`. Prefers uc-registry; falls back
   * to a local uuidv7 (with a WARN) whenever the registry is unconfigured or the
   * round-trip can't yield a usable id. NEVER throws.
   */
  async mintWorkspaceId(req: MintWorkspaceRequest): Promise<MintedWorkspaceId> {
    const base = this.baseUrl;
    if (!base) {
      // Unconfigured: the constructor already warned once; just fall back quietly
      // so we don't log per-signup noise.
      return { workspaceId: uuidv7(), source: 'local-fallback' };
    }

    const registryId = await this.requestRegistryId(base, req);
    if (registryId) {
      return { workspaceId: registryId, source: 'uc-registry' };
    }

    // Reachable-but-unusable, or transport error: degrade to a local v7. The
    // requestRegistryId() path already logged the specific reason.
    const local = uuidv7();
    this.logger.warn(
      `uc-registry mint unavailable — using locally-generated workspace id ${local}`,
    );
    return { workspaceId: local, source: 'local-fallback' };
  }

  /**
   * POST the create-workspace request to uc-registry and pull the canonical id
   * out of the response. Returns null (so the caller falls back) on any
   * transport error, non-2xx, unparseable body, or a missing/non-v7 id.
   */
  private async requestRegistryId(base: string, req: MintWorkspaceRequest): Promise<string | null> {
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${base}/api/v1/workspaces`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          display_name: req.displayName,
          slug: req.slug,
          owner_uc_uid: req.ownerUcUid ?? null,
        }),
      });
    } catch (err) {
      this.logger.warn(`uc-registry mint transport error: ${(err as Error).message}`);
      return null;
    }
    if (!res.ok) {
      this.logger.warn(`uc-registry mint HTTP ${res.status}`);
      return null;
    }
    let raw: Record<string, unknown>;
    try {
      raw = (await res.json()) as Record<string, unknown>;
    } catch {
      this.logger.warn('uc-registry mint returned an unparseable body');
      return null;
    }
    // Accept either the snake_case suite wire field or a bare `id`.
    const id = (raw['workspace_id'] ?? raw['id']) as unknown;
    if (typeof id !== 'string' || !isUuidV7(id)) {
      this.logger.warn('uc-registry mint returned no usable uuidv7 workspace id');
      return null;
    }
    return id;
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

/**
 * The concrete Contact-Ops federation client.
 *
 * Speaks the two surfaces Contact-Ops exposes (verified in the CO tree +
 * handoff-contact-ops.md):
 *
 *   1. MCP — JSON-RPC 2.0 over `POST {CONTACT_OPS_BASE_URL}/mcp`
 *      (contact_ops/mcp/server.py). Tenant comes from the bearer's
 *      `workspace_id` claim, NEVER a header. Contact-read tools used:
 *        - get_person(person_id, include[])            -> GetPersonOutput
 *        - list_people / search_people(filters)        -> {items: PersonSummary[]}
 *      Tool-call envelope: result.structuredContent (preferred) | result.content[0].text.
 *      Application errors come back HTTP 200 with result.isError=true OR a
 *      JSON-RPC `error` object — both handled.
 *
 *   2. The signed thin workspace projection — `GET {CONTACT_OPS_BASE_URL}/api/v1/workspaces/{id}`
 *      (handoff-contact-ops §2.2). Server-to-server auth; returns the 9
 *      suite-shared fields, never infra columns.
 *
 * AUTH: Customer-Ops calls Contact-Ops as a service. The bearer is a federation
 * token carrying the `workspace_id` claim for the addressed workspace +
 * `aud=contact-ops`. Minting that token is Brigade's job; until the Brigade
 * RFC-8693 exchange is wired (Phase 3 seam), this client reads a configured
 * service token (CONTACT_OPS_SERVICE_TOKEN) and sets the workspace via the
 * documented precedence. The token-mint seam is isolated in `authHeader()` so
 * swapping to Brigade is a one-method change.
 *
 * DEGRADE-CLEAN: when CONTACT_OPS_BASE_URL is unset (no CO reachable — e.g.
 * Phase-1/2 dogfood before CO federation is live, or verification), every read
 * returns empty/null instead of throwing. The cockpit then renders the
 * relationship rows with "contact unavailable" placeholders. This keeps
 * Customer-Ops fully functional without a hard CO dependency, per the brief
 * ("leave the seams"; federation MOCKED in tests).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';
import { FederationWorkspaceMapService } from '../common/federation/federation-workspace-map.service';
import { ContactOpsPort, FederationContext } from './contact-ops.port';
import {
  ContactIdentityInput,
  ContactUpsertResult,
  FederatedContact,
  FederatedContactPage,
  FederatedContactSummary,
  FederatedWorkspaceProjection,
  ListContactsFilter,
} from './contact-ops.types';
import { SeamHealth } from '../health/seam-health';
import { shortBody } from '../health/probe-util';
import { mapWithConcurrency } from '../common/concurrency';

/**
 * Max simultaneous get_person calls when resolving a batch of contact summaries.
 * Caps the fan-out from a large list/overview page (up to ~500 ids) to a steady
 * wave instead of one burst, until Contact-Ops exposes a bulk-read tool.
 */
const CONTACT_SUMMARY_CONCURRENCY = 8;

interface JsonRpcResult {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: JsonRpcResult;
  error?: { code: number; message: string };
}

@Injectable()
export class ContactOpsClient extends ContactOpsPort {
  private readonly logger = new Logger(ContactOpsClient.name);
  private rpcId = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly brigade: BrigadeTokenSource,
    private readonly federationMap: FederationWorkspaceMapService,
  ) {
    super();
    if (!this.baseUrl) {
      this.logger.warn(
        'CONTACT_OPS_BASE_URL unset — Contact-Ops federation is DORMANT; ' +
          'contact details resolve to placeholders until configured.',
      );
    } else {
      this.logger.log(`Contact-Ops federation target: ${this.baseUrl}`);
    }
  }

  // --- configuration seam -------------------------------------------------

  private get baseUrl(): string | null {
    const raw = this.config.get<string>('CONTACT_OPS_BASE_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('CONTACT_OPS_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 8000;
  }

  /**
   * Build the auth headers for a federation call to Contact-Ops. This is the
   * Brigade token-mint seam: today it forwards a configured service token; the
   * Phase-3 change swaps in a Brigade RFC-8693 exchange that mints a per-request
   * token with `aud=contact-ops` + the addressed `workspace_id` claim. The
   * `X-Workspace-Id` header rides along for CO's per-request addressing
   * (WORKSPACE_PER_REQUEST_ENABLED); CO still re-gates membership server-side,
   * so the header is a hint, never the authz boundary.
   */
  private async authHeaders(ctx: FederationContext): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // CO's MCP endpoint (Streamable HTTP) requires this Accept.
      Accept: 'application/json, text/event-stream',
    };
    // Workspace addressing. CONTACT_OPS_WORKSPACE_OVERRIDE maps this app's local
    // workspace onto Contact-Ops' uc-registry tenant id for the single-workspace
    // dogfood (until the suite shares one uc-registry id — SUITE-IDENTITY §0.1).
    const ws = this.federationMap.resolveSync(ctx.workspaceId, 'contact-ops') ?? ctx.workspaceId;
    const bearer = await this.bearerFor(ws);
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    headers['X-Workspace-Id'] = ws;
    if (ctx.ucUid) headers['X-Uc-Uid'] = ctx.ucUid;
    return headers;
  }

  private get workspaceOverride(): string | null {
    const w = this.config.get<string>('CONTACT_OPS_WORKSPACE_OVERRIDE');
    return w && w.trim() ? w.trim() : null;
  }

  /** The workspace id to address Contact-Ops with: the override when set, else the
   *  resolved context id. Used for BOTH the bearer claim / X-Workspace-Id header
   *  AND the workspace-projection URL path, so the token tenant and the addressed
   *  tenant never disagree. */
  private effectiveWorkspaceId(ctx: FederationContext): string {
    return this.federationMap.resolveSync(ctx.workspaceId, 'contact-ops') ?? ctx.workspaceId;
  }

  /** The auth mode: `static` forwards CONTACT_OPS_SERVICE_TOKEN (legacy / dev);
   *  `brigade-sts` mints a customer-ops client-credentials token and exchanges it
   *  at Brigade (RFC-8693) for a contact-ops-audience, workspace-bound token. */
  private get authMode(): 'static' | 'brigade-sts' {
    return this.config.get<string>('CONTACT_OPS_AUTH_MODE')?.trim() === 'brigade-sts'
      ? 'brigade-sts'
      : 'static';
  }

  /** Resolve the bearer for a federation call (per the auth mode). `static`
   *  forwards CONTACT_OPS_SERVICE_TOKEN; `brigade-sts` delegates to the shared
   *  BrigadeTokenSource (mint customer-ops CC → exchange for aud=contact-ops). */
  private async bearerFor(workspaceId: string): Promise<string | null> {
    if (this.authMode === 'static') {
      const t = this.config.get<string>('CONTACT_OPS_SERVICE_TOKEN');
      return t && t.trim() ? t.trim() : null;
    }
    return this.brigade.exchangedToken({
      audience: this.config.get<string>('CONTACT_OPS_AUDIENCE')?.trim() || 'contact-ops',
      scope: 'contacts:read contacts:write',
      workspaceId,
    });
  }

  // --- MCP JSON-RPC transport --------------------------------------------

  /**
   * Invoke one Contact-Ops MCP tool via JSON-RPC `tools/call`. Returns the
   * tool's structuredContent, or null on any transport/application failure
   * (logged). Never throws — federation is best-effort by design.
   */
  private async callTool(
    ctx: FederationContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const base = this.baseUrl;
    if (!base) return null;

    const body = {
      jsonrpc: '2.0',
      id: ++this.rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    };

    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${base}/mcp`, {
        method: 'POST',
        headers: await this.authHeaders(ctx),
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.warn(`Contact-Ops MCP ${name} transport error: ${(err as Error).message}`);
      return null;
    }

    if (!res.ok) {
      this.logger.warn(`Contact-Ops MCP ${name} HTTP ${res.status}`);
      return null;
    }

    let payload: JsonRpcResponse;
    try {
      payload = (await res.json()) as JsonRpcResponse;
    } catch (err) {
      this.logger.warn(`Contact-Ops MCP ${name} non-JSON response: ${(err as Error).message}`);
      return null;
    }

    if (payload.error) {
      this.logger.warn(`Contact-Ops MCP ${name} JSON-RPC error: ${payload.error.message}`);
      return null;
    }

    const result = payload.result;
    if (!result || result.isError) {
      const text = result?.content?.[0]?.text;
      this.logger.warn(`Contact-Ops MCP ${name} tool error: ${text ?? 'unknown'}`);
      return null;
    }

    // Prefer the typed structuredContent; fall back to parsing content[0].text.
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.find((c) => c.type === 'text')?.text;
    if (text) {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
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

  // --- health probe ------------------------------------------------------

  /**
   * Probe the Contact-Ops seam with a side-effect-free MCP `tools/list` over the
   * SAME transport/auth a real read uses (so a silent 401/403 surfaces as an
   * `auth-error` rather than placeholder contact rows). Never throws.
   */
  async ping(): Promise<SeamHealth> {
    const seam = 'contact-ops';
    if (!this.baseUrl) {
      return {
        seam,
        configured: false,
        ok: false,
        status: null,
        detail: 'not-configured',
        latencyMs: null,
      };
    }
    const base = this.baseUrl;
    const ws =
      this.federationMap.resolveSync(
        this.config.get<string>('HEALTH_PROBE_WORKSPACE_ID') ?? '',
        'contact-ops',
      ) ??
      this.config.get<string>('HEALTH_PROBE_WORKSPACE_ID') ??
      '';
    // Contact-Ops' FederationContext is the read-only (no-entitlements) shape.
    const ctx: FederationContext = { workspaceId: ws, ucUid: null };
    const body = { jsonrpc: '2.0', id: ++this.rpcId, method: 'tools/list', params: {} };

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${base}/mcp`, {
        method: 'POST',
        headers: await this.authHeaders(ctx),
        body: JSON.stringify(body),
      });
    } catch (err) {
      return {
        seam,
        configured: true,
        ok: false,
        status: null,
        detail: `unreachable: ${(err as Error).message}`,
        latencyMs: Date.now() - startedAt,
      };
    }
    const latencyMs = Date.now() - startedAt;
    if (res.status === 200) {
      return { seam, configured: true, ok: true, status: 200, detail: 'ok', latencyMs };
    }
    const detail =
      res.status === 401 || res.status === 403
        ? `auth-error: ${await shortBody(res)}`
        : `unreachable: HTTP ${res.status} ${await shortBody(res)}`.trim();
    return { seam, configured: true, ok: false, status: res.status, detail, latencyMs };
  }

  // --- mapping: CO wire shapes -> Customer-Ops federation projections -----

  private toSummary(raw: Record<string, unknown>): FederatedContactSummary | null {
    const personId = raw['person_id'];
    if (typeof personId !== 'string' || !personId) return null;
    return {
      contactId: personId,
      displayName: (raw['display_name'] as string) ?? '(unnamed contact)',
      primaryEmail: (raw['primary_email'] as string | null) ?? null,
      currentOrgId: (raw['current_org_id'] as string | null) ?? null,
      currentOrgName: (raw['current_org_name'] as string | null) ?? null,
      lastInteractionAt: (raw['last_interaction_at'] as string | null) ?? null,
      communicationStrength:
        typeof raw['communication_strength'] === 'number'
          ? (raw['communication_strength'] as number)
          : null,
      tags: Array.isArray(raw['tags']) ? (raw['tags'] as string[]) : [],
      etag: (raw['etag'] as string | null) ?? null,
    };
  }

  // --- ContactOpsPort implementation -------------------------------------

  async getContact(ctx: FederationContext, contactId: string): Promise<FederatedContact | null> {
    // `prov:` ids are local provisional placeholders (name-only imports that
    // have no Contact-Ops record yet). get_person expects a UUID and rejects
    // them with a validation error, so skip the round-trip and degrade clean.
    if (!contactId || contactId.startsWith('prov:')) return null;
    const raw = await this.callTool(ctx, 'get_person', {
      person_id: contactId,
      include: ['emails', 'phones'],
    });
    if (!raw) return null;
    const personId = raw['person_id'];
    if (typeof personId !== 'string' || !personId) return null;

    return {
      contactId: personId,
      displayName: (raw['display_name'] as string) ?? '(unnamed contact)',
      primaryEmail:
        (raw['primary_email'] as string | null) ?? firstPrimaryEmail(raw['emails']) ?? null,
      currentOrgId: (raw['current_org_id'] as string | null) ?? null,
      currentOrgName: (raw['current_org_name'] as string | null) ?? null,
      lastInteractionAt: (raw['last_interaction_at'] as string | null) ?? null,
      communicationStrength:
        typeof raw['communication_strength'] === 'number'
          ? (raw['communication_strength'] as number)
          : null,
      tags: Array.isArray(raw['tags']) ? (raw['tags'] as string[]) : [],
      etag: (raw['etag'] as string | null) ?? null,
      vcardUid: (raw['vcard_uid'] as string | null) ?? null,
      kind: (raw['kind'] as string) ?? 'individual',
      status: (raw['status'] as string) ?? 'active',
      emails: Array.isArray(raw['emails']) ? (raw['emails'] as FederatedContact['emails']) : [],
      phones: Array.isArray(raw['phones']) ? (raw['phones'] as FederatedContact['phones']) : [],
      recentEvents: Array.isArray(raw['recent_events'])
        ? (raw['recent_events'] as Array<Record<string, unknown>>)
        : [],
    };
  }

  async getContactSummaries(
    ctx: FederationContext,
    contactIds: string[],
  ): Promise<Map<string, FederatedContactSummary>> {
    const out = new Map<string, FederatedContactSummary>();
    if (contactIds.length === 0 || !this.baseUrl) return out;

    // Contact-Ops has no batch "get_people by ids" tool; get_person is the
    // typed by-id read. Resolve with BOUNDED concurrency — a list/overview page
    // can pass up to ~500 ids, and an unbounded Promise.all would fire that many
    // simultaneous MCP calls (socket/pool exhaustion here, thundering herd at
    // Contact-Ops). A future CO bulk-read tool drops straight in here.
    const unique = [...new Set(contactIds)];
    const results = await mapWithConcurrency(unique, CONTACT_SUMMARY_CONCURRENCY, async (id) => {
      const full = await this.getContact(ctx, id);
      return full
        ? ({
            contactId: full.contactId,
            displayName: full.displayName,
            primaryEmail: full.primaryEmail,
            currentOrgId: full.currentOrgId,
            currentOrgName: full.currentOrgName,
            lastInteractionAt: full.lastInteractionAt,
            communicationStrength: full.communicationStrength,
            tags: full.tags,
            etag: full.etag,
          } as FederatedContactSummary)
        : null;
    });
    for (const s of results) if (s) out.set(s.contactId, s);
    return out;
  }

  async listContacts(
    ctx: FederationContext,
    filter: ListContactsFilter,
  ): Promise<FederatedContactPage> {
    const empty: FederatedContactPage = { items: [], count: 0, nextCursor: null };
    if (!this.baseUrl) return empty;

    // search_people when a free-text query is present (CO does lexical/hybrid),
    // else list_people for structured filtering.
    const useSearch = !!filter.query && filter.query.trim().length > 0;
    const args: Record<string, unknown> = {
      limit: filter.limit ?? 25,
    };
    if (filter.cursor) args['cursor'] = filter.cursor;
    if (filter.tagsAny && filter.tagsAny.length) args['tags_any'] = filter.tagsAny;
    if (typeof filter.hasEmail === 'boolean') args['has_email'] = filter.hasEmail;
    if (useSearch) args['query'] = filter.query!.trim();

    const raw = await this.callTool(ctx, useSearch ? 'search_people' : 'list_people', args);
    if (!raw) return empty;

    const items: FederatedContactSummary[] = [];
    const rawItems = Array.isArray(raw['items']) ? (raw['items'] as Record<string, unknown>[]) : [];
    for (const it of rawItems) {
      const s = this.toSummary(it);
      if (s) items.push(s);
    }
    return {
      items,
      count: typeof raw['count'] === 'number' ? (raw['count'] as number) : items.length,
      nextCursor: (raw['next_cursor'] as string | null) ?? null,
    };
  }

  async getWorkspaceProjection(
    ctx: FederationContext,
  ): Promise<FederatedWorkspaceProjection | null> {
    const base = this.baseUrl;
    if (!base) return null;

    let res: Response;
    try {
      res = await this.fetchWithTimeout(
        `${base}/api/v1/workspaces/${encodeURIComponent(this.effectiveWorkspaceId(ctx))}`,
        { method: 'GET', headers: await this.authHeaders(ctx) },
      );
    } catch (err) {
      this.logger.warn(
        `Contact-Ops workspace projection transport error: ${(err as Error).message}`,
      );
      return null;
    }
    if (!res.ok) {
      // 404 == CO doesn't mirror this workspace; 401/403 == auth. Either way
      // there is no projection to surface.
      this.logger.debug?.(`Contact-Ops workspace projection HTTP ${res.status}`);
      return null;
    }
    let raw: Record<string, unknown>;
    try {
      raw = (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
    const wid = (raw['workspace_id'] as string) ?? this.effectiveWorkspaceId(ctx);
    return {
      workspaceId: wid,
      slug: (raw['slug'] as string) ?? '',
      displayName: (raw['display_name'] as string) ?? '',
      isolationMode: (raw['isolation_mode'] as string) ?? 'standard',
      isolationTier: (raw['isolation_tier'] as string) ?? 'shared',
      hipaaMode: !!raw['hipaa_mode'],
      gdprMode: !!raw['gdpr_mode'],
      dataResidency: (raw['data_residency'] as string | null) ?? null,
      status: (raw['status'] as string) ?? 'active',
    };
  }

  /**
   * Centralize a graduated lead's identity in Contact-Ops (the `ingest_lead`
   * keystone's identity step). Degrade-clean: `callTool` returns null when
   * CONTACT_OPS_BASE_URL is unset OR the ingest tool isn't live yet (P-00059) —
   * the caller then stages the lead PENDING and a reconciler retries. Never throws.
   *
   * THE P-00059 SEAM: the Contact-Ops ingest tool name + its argument shape are
   * the ONLY thing that changes when CONTACT-OPS-INGEST-CONTRACT.md's `/ingest`
   * RBAC-MCP front door finalizes. Both are isolated here:
   *   - tool name  → CONTACT_OPS_INGEST_TOOL env (default 'ingest_person').
   *   - arg shape  → `toIngestArgs` below (snake_case, emails[]/phones[] arrays —
   *                  Contact-Ops' canonical person shape per common.py).
   * When the contract lands, confirm those two and nothing else moves.
   */
  async upsertContact(
    ctx: FederationContext,
    identity: ContactIdentityInput,
  ): Promise<ContactUpsertResult | null> {
    if (!this.baseUrl) return null;
    // CO's upsert_person dedups on a natural identifier (email/phone). Without
    // one we cannot upsert — caller keeps the lead provisional.
    if (!identity.email && !identity.phone) {
      this.logger.debug?.('upsertContact: no email/phone to match on — skipping CO upsert');
      return null;
    }
    const toolName = this.config.get<string>('CONTACT_OPS_INGEST_TOOL')?.trim() || 'upsert_person';

    const raw = await this.callTool(ctx, toolName, this.toIngestArgs(identity));
    if (!raw) return null;

    // Contact-Ops returns the canonical person — accept person_id|contact_id|id.
    const personId =
      (raw['person_id'] as string) ?? (raw['contact_id'] as string) ?? (raw['id'] as string);
    if (typeof personId !== 'string' || !personId) {
      this.logger.warn(`Contact-Ops ${toolName} returned no person id; treating as unresolved`);
      return null;
    }
    return {
      contactId: personId,
      // CO may signal newness as `created`/`is_new`; default false (matched).
      created: raw['created'] === true || raw['is_new'] === true,
      etag: (raw['etag'] as string | null) ?? null,
    };
  }

  /** Map a Customer-Ops identity push to Contact-Ops' canonical person shape.
   *  Isolated so the P-00059 contract is a one-method change (see upsertContact). */
  private toIngestArgs(identity: ContactIdentityInput): Record<string, unknown> {
    // CO `upsert_person`: `match_by` (the dedup identifiers it idempotently keys
    // on) + a flat person shape (display_name, emails[], phones[], initial_tags).
    const matchBy: Array<{ namespace: string; value: string }> = [];
    if (identity.email) matchBy.push({ namespace: 'email', value: identity.email });
    if (identity.phone) matchBy.push({ namespace: 'phone', value: identity.phone });

    const args: Record<string, unknown> = { match_by: matchBy };
    if (identity.displayName) args['display_name'] = identity.displayName;
    if (identity.givenName) args['given_name'] = identity.givenName;
    if (identity.familyName) args['family_name'] = identity.familyName;
    if (identity.nicknames && identity.nicknames.length) args['nicknames'] = identity.nicknames;
    if (identity.email) args['emails'] = [{ address: identity.email, is_primary: true }];
    if (identity.phone) args['phones'] = [{ e164: identity.phone, is_primary: true }];
    if (identity.tags && identity.tags.length) args['initial_tags'] = identity.tags;
    return args;
  }
}

/** Pull the primary (or first) email address out of CO's get_person emails[]. */
function firstPrimaryEmail(emails: unknown): string | null {
  if (!Array.isArray(emails) || emails.length === 0) return null;
  const list = emails as Array<Record<string, unknown>>;
  const primary = list.find((e) => e['is_primary'] === true) ?? list[0];
  const addr = primary?.['address'];
  return typeof addr === 'string' ? addr : null;
}

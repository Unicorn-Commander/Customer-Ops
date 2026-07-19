/**
 * The concrete Meeting-Ops federation client.
 *
 * Speaks the read surface the Meeting-Ops APP exposes over MCP — the
 * conversation-intelligence app that owns meetings/transcripts/summaries/action
 * items (SUITE-ARCHITECTURE-MAP §2) and runs its own action-item → Project-Ops
 * task bridge. This client is written against a clean, sensible `/mcp`-style read
 * contract (informed by that data model) so the Meeting-Ops app can implement it
 * verbatim, exactly as the Contact-Ops / Accounting-Ops / Outreach / Email-Ops
 * clients were written against those apps' contracts:
 *
 *   MCP — JSON-RPC 2.0 over `POST {MEETING_OPS_BASE_URL}/mcp`. Meeting-Ops
 *   resolves the tenant from the bearer's `workspace_id` claim (re-gated
 *   server-side), never a trusted header. Read tools the contract defines:
 *     - list_meetings_for_contact(workspace_id, contact_id, limit?, cursor?)
 *         -> { meetings: Meeting[], count, next_cursor }
 *     - list_summaries_for_contact(workspace_id, contact_id, limit?)
 *         -> { summaries: Summary[] }
 *     - list_action_items_for_contact(workspace_id, contact_id, limit?)
 *         -> { action_items: ActionItem[] }   (each may carry project_ops_task_id)
 *   `getMeetingSignal` is DERIVED client-side from these reads (no extra tool
 *   needed) so the agents get a compact digest without the app implementing a
 *   bespoke endpoint; a future native `get_meeting_signal` tool drops straight in.
 *   Tool-call envelope: result.structuredContent (preferred) | content[0].text.
 *   Application errors come back HTTP 200 with result.isError=true OR a JSON-RPC
 *   `error` — both handled.
 *
 * AUTH: Customer-Ops calls Meeting-Ops as a service. The bearer is a federation
 * token carrying the addressed `workspace_id` claim + `aud=meeting-ops`. Minting
 * that token is Brigade's job (RFC-8693 exchange); until that seam is wired this
 * client forwards a configured service token (MEETING_OPS_SERVICE_TOKEN) and
 * addresses the workspace via the documented precedence (X-Workspace-Id header,
 * which Meeting-Ops re-gates against membership). The mint seam is isolated in
 * `authHeaders()` so swapping to Brigade is a one-method change — exactly like the
 * other federation clients.
 *
 * ENTITLEMENT: none on this client — Meeting-Ops reads are viewer-level
 * conversation signal (like Contact-Ops contact reads), not a dual-SKU trigger.
 *
 * DEGRADE-CLEAN (binding): when MEETING_OPS_BASE_URL is unset, `isConfigured()` is
 * false and every method returns empty/null without any fetch. The cockpit then
 * renders the meeting slot as "connect Meeting-Ops" and makes no call. This keeps
 * Customer-Ops fully functional without a hard Meeting-Ops dependency (the
 * customer-360 had this slot inert until now), and is what the tests assert.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';
import { FederationWorkspaceMapService } from '../common/federation/federation-workspace-map.service';
import { MeetingOpsPort, FederationContext } from './meeting-ops.port';
import {
  FederatedActionItem,
  FederatedMeeting,
  FederatedMeetingPage,
  FederatedMeetingSummary,
  ListMeetingsFilter,
  MeetingParticipant,
  MeetingSignal,
} from './meeting-ops.types';
import { SeamHealth } from '../health/seam-health';
import { shortBody } from '../health/probe-util';

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
export class MeetingOpsClient extends MeetingOpsPort {
  private readonly logger = new Logger(MeetingOpsClient.name);
  private rpcId = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly brigade: BrigadeTokenSource,
    private readonly federationMap: FederationWorkspaceMapService,
  ) {
    super();
    if (!this.baseUrl) {
      this.logger.warn(
        'MEETING_OPS_BASE_URL unset — Meeting-Ops federation is DORMANT; the ' +
          'customer-360 meeting slot shows "connect Meeting-Ops" and no ' +
          'meeting/summary/action-item call is made until configured. The ' +
          'relationship agents still run (they just see no meeting signal).',
      );
    } else {
      this.logger.log(`Meeting-Ops federation target: ${this.baseUrl}`);
    }
  }

  // --- configuration seam -------------------------------------------------

  private get baseUrl(): string | null {
    const raw = this.config.get<string>('MEETING_OPS_BASE_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  /** The MCP JSON-RPC path under the base. Meeting-Ops exposes its federation MCP
   *  at `/api/federation/mcp` (a dedicated Brigade-verified router, separate from
   *  the per-user `/mcp`), so this is configurable; default `/mcp` for siblings
   *  that mount it at the root. Always leads with a slash. */
  private get mcpPath(): string {
    const raw = this.config.get<string>('MEETING_OPS_MCP_PATH')?.trim();
    if (!raw) return '/mcp';
    return raw.startsWith('/') ? raw : `/${raw}`;
  }

  /** Workspace override: map this app's local workspace onto Meeting-Ops'
   *  uc-registry tenant for the single-workspace dogfood (until the suite shares
   *  one uc-registry id — SUITE-IDENTITY §0.1). */
  private get workspaceOverride(): string | null {
    const w = this.config.get<string>('MEETING_OPS_WORKSPACE_OVERRIDE');
    return w && w.trim() ? w.trim() : null;
  }

  /** The workspace id to address Meeting-Ops with: the override when set, else the
   *  resolved context id. Used for BOTH the bearer claim / X-Workspace-Id header
   *  AND the JSON-RPC body `workspace_id`, so the auth tenant and the addressed
   *  tenant never disagree. */
  private effectiveWorkspaceId(ctx: FederationContext): string {
    return this.federationMap.resolveSync(ctx.workspaceId, 'meeting-ops') ?? ctx.workspaceId;
  }

  /** Auth mode: `static` forwards MEETING_OPS_SERVICE_TOKEN; `brigade-sts`
   *  delegates to the shared BrigadeTokenSource (aud=meeting-ops, meetings:read). */
  private get authMode(): 'static' | 'brigade-sts' {
    return this.config.get<string>('MEETING_OPS_AUTH_MODE')?.trim() === 'brigade-sts'
      ? 'brigade-sts'
      : 'static';
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('MEETING_OPS_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 8000;
  }

  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  /**
   * Build the auth headers for a federation call to Meeting-Ops. This is the
   * Brigade token-mint seam: today it forwards a configured service token; the
   * Brigade change swaps in an RFC-8693 exchange minting a per-request token with
   * `aud=meeting-ops` + the addressed `workspace_id` claim. X-Workspace-Id rides
   * along for Meeting-Ops's per-request addressing; Meeting-Ops re-gates
   * membership server-side, so the header is a hint, never the authz boundary.
   */
  private async authHeaders(ctx: FederationContext): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Meeting-Ops' federation MCP is Streamable-HTTP; it requires this Accept.
      Accept: 'application/json, text/event-stream',
    };
    const ws = this.effectiveWorkspaceId(ctx);
    const bearer = await this.bearerFor(ws);
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    headers['X-Workspace-Id'] = ws;
    if (ctx.ucUid) headers['X-Uc-Uid'] = ctx.ucUid;
    return headers;
  }

  /** Resolve the bearer per the auth mode. `static` forwards the service token;
   *  `brigade-sts` mints customer-ops CC → exchanges for an aud=meeting-ops,
   *  workspace-bound token via the shared source (meetings:read). */
  private async bearerFor(workspaceId: string): Promise<string | null> {
    if (this.authMode === 'static') {
      const t = this.config.get<string>('MEETING_OPS_SERVICE_TOKEN');
      return t && t.trim() ? t.trim() : null;
    }
    return this.brigade.exchangedToken({
      audience: this.config.get<string>('MEETING_OPS_AUDIENCE')?.trim() || 'meeting-ops',
      scope: 'meetings:read',
      workspaceId,
    });
  }

  // --- MCP JSON-RPC transport --------------------------------------------

  /**
   * Invoke one Meeting-Ops MCP tool via JSON-RPC `tools/call`. Returns the tool's
   * structuredContent, or null on any transport/application failure (logged).
   * Never throws — federation is best-effort by design; the service surfaces a
   * clean "couldn't reach Meeting-Ops" rather than a 500.
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
      res = await this.fetchWithTimeout(`${base}${this.mcpPath}`, {
        method: 'POST',
        headers: await this.authHeaders(ctx),
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.warn(`Meeting-Ops MCP ${name} transport error: ${(err as Error).message}`);
      return null;
    }

    if (!res.ok) {
      this.logger.warn(`Meeting-Ops MCP ${name} HTTP ${res.status}`);
      return null;
    }

    let payload: JsonRpcResponse;
    try {
      payload = (await res.json()) as JsonRpcResponse;
    } catch (err) {
      this.logger.warn(`Meeting-Ops MCP ${name} non-JSON response: ${(err as Error).message}`);
      return null;
    }

    if (payload.error) {
      this.logger.warn(`Meeting-Ops MCP ${name} JSON-RPC error: ${payload.error.message}`);
      return null;
    }

    const result = payload.result;
    if (!result || result.isError) {
      const text = result?.content?.[0]?.text;
      this.logger.warn(`Meeting-Ops MCP ${name} tool error: ${text ?? 'unknown'}`);
      return null;
    }

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
   * Probe the Meeting-Ops seam with a side-effect-free MCP `tools/list` over the
   * SAME transport/auth + path a real read uses (so a silent 401/403 surfaces as
   * an `auth-error` rather than an empty meeting slot). Never throws.
   */
  async ping(): Promise<SeamHealth> {
    const seam = 'meeting-ops';
    if (!this.baseUrl) {
      return { seam, configured: false, ok: false, status: null, detail: 'not-configured', latencyMs: null };
    }
    const base = this.baseUrl;
    const ws = this.federationMap.resolveSync(this.config.get<string>('HEALTH_PROBE_WORKSPACE_ID') ?? '', 'meeting-ops') ?? this.config.get<string>('HEALTH_PROBE_WORKSPACE_ID') ?? '';
    // Meeting-Ops' FederationContext is the read-only (no-entitlements) shape.
    const ctx: FederationContext = { workspaceId: ws, ucUid: null };
    const body = { jsonrpc: '2.0', id: ++this.rpcId, method: 'tools/list', params: {} };

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${base}${this.mcpPath}`, {
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

  // --- mapping: Meeting-Ops wire shape -> Customer-Ops federation projection -

  private str(raw: Record<string, unknown>, k: string): string | null {
    const v = raw[k];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }

  private num(raw: Record<string, unknown>, k: string): number | null {
    const v = raw[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  private toParticipant(raw: unknown): MeetingParticipant | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const name = r['display_name'];
    return {
      contactId: typeof r['contact_id'] === 'string' ? (r['contact_id'] as string) : null,
      displayName: typeof name === 'string' && name ? name : '(unknown participant)',
      email: typeof r['email'] === 'string' ? (r['email'] as string) : null,
    };
  }

  private toParticipants(raw: unknown): MeetingParticipant[] {
    if (!Array.isArray(raw)) return [];
    const out: MeetingParticipant[] = [];
    for (const p of raw) {
      const parsed = this.toParticipant(p);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  private toMeeting(raw: Record<string, unknown>): FederatedMeeting | null {
    const id = raw['id'];
    if (typeof id !== 'string' || !id) return null;
    return {
      id,
      title: this.str(raw, 'title'),
      startedAt: this.str(raw, 'started_at'),
      endedAt: this.str(raw, 'ended_at'),
      durationSeconds: this.num(raw, 'duration_seconds'),
      status: (raw['status'] as string) ?? 'unknown',
      hasSummary: raw['has_summary'] === true,
      actionItemCount: this.num(raw, 'action_item_count') ?? 0,
      participants: this.toParticipants(raw['participants']),
    };
  }

  private toSummary(raw: Record<string, unknown>): FederatedMeetingSummary | null {
    const id = raw['id'];
    if (typeof id !== 'string' || !id) return null;
    return {
      id,
      meetingId: this.str(raw, 'meeting_id') ?? '',
      headline: this.str(raw, 'headline'),
      body: this.str(raw, 'body'),
      keyPoints: Array.isArray(raw['key_points'])
        ? (raw['key_points'] as unknown[]).filter((k): k is string => typeof k === 'string')
        : [],
      createdAt: this.str(raw, 'created_at'),
    };
  }

  private toActionItem(raw: Record<string, unknown>): FederatedActionItem | null {
    const id = raw['id'];
    if (typeof id !== 'string' || !id) return null;
    const text = raw['text'];
    return {
      id,
      meetingId: this.str(raw, 'meeting_id') ?? '',
      text: typeof text === 'string' ? text : '',
      status: (raw['status'] as string) ?? 'open',
      assigneeContactId:
        typeof raw['assignee_contact_id'] === 'string'
          ? (raw['assignee_contact_id'] as string)
          : null,
      assigneeLabel:
        typeof raw['assignee_label'] === 'string' ? (raw['assignee_label'] as string) : null,
      dueAt: this.str(raw, 'due_at'),
      // The Project-Ops task id IF Meeting-Ops' bridge already created one. We
      // only SURFACE it (a "→ task" indicator); we never write it.
      projectOpsTaskId:
        typeof raw['project_ops_task_id'] === 'string'
          ? (raw['project_ops_task_id'] as string)
          : null,
      createdAt: this.str(raw, 'created_at'),
    };
  }

  // --- MeetingOpsPort implementation -------------------------------------

  async listMeetingsForContact(
    ctx: FederationContext,
    contactId: string,
    filter?: ListMeetingsFilter,
  ): Promise<FederatedMeetingPage> {
    const empty: FederatedMeetingPage = { items: [], count: 0, nextCursor: null };
    if (!this.baseUrl) return empty;
    const args: Record<string, unknown> = {
      workspace_id: this.effectiveWorkspaceId(ctx),
      contact_id: contactId,
      limit: filter?.limit ?? 25,
    };
    if (filter?.cursor) args['cursor'] = filter.cursor;

    const raw = await this.callTool(ctx, 'list_meetings_for_contact', args);
    if (!raw) return empty;
    const rawItems = Array.isArray(raw['meetings'])
      ? (raw['meetings'] as Record<string, unknown>[])
      : [];
    const items: FederatedMeeting[] = [];
    for (const it of rawItems) {
      const m = this.toMeeting(it);
      if (m) items.push(m);
    }
    return {
      items,
      count: typeof raw['count'] === 'number' ? (raw['count'] as number) : items.length,
      nextCursor: (raw['next_cursor'] as string | null) ?? null,
    };
  }

  async listSummariesForContact(
    ctx: FederationContext,
    contactId: string,
    filter?: ListMeetingsFilter,
  ): Promise<FederatedMeetingSummary[]> {
    if (!this.baseUrl) return [];
    const raw = await this.callTool(ctx, 'list_summaries_for_contact', {
      workspace_id: this.effectiveWorkspaceId(ctx),
      contact_id: contactId,
      limit: filter?.limit ?? 25,
    });
    if (!raw) return [];
    const rawItems = Array.isArray(raw['summaries'])
      ? (raw['summaries'] as Record<string, unknown>[])
      : [];
    const out: FederatedMeetingSummary[] = [];
    for (const it of rawItems) {
      const s = this.toSummary(it);
      if (s) out.push(s);
    }
    return out;
  }

  async listActionItemsForContact(
    ctx: FederationContext,
    contactId: string,
    filter?: ListMeetingsFilter,
  ): Promise<FederatedActionItem[]> {
    if (!this.baseUrl) return [];
    const raw = await this.callTool(ctx, 'list_action_items_for_contact', {
      workspace_id: this.effectiveWorkspaceId(ctx),
      contact_id: contactId,
      limit: filter?.limit ?? 50,
    });
    if (!raw) return [];
    const rawItems = Array.isArray(raw['action_items'])
      ? (raw['action_items'] as Record<string, unknown>[])
      : [];
    const out: FederatedActionItem[] = [];
    for (const it of rawItems) {
      const a = this.toActionItem(it);
      if (a) out.push(a);
    }
    return out;
  }

  /**
   * Derive the compact conversation signal from the meeting + summary + action-
   * item reads. One concurrent fan-out; best-effort — a partial failure still
   * yields a usable (possibly emptier) signal, never a throw. When Meeting-Ops is
   * dormant this returns the all-empty signal so an agent can still run.
   */
  async getMeetingSignal(ctx: FederationContext, contactId: string): Promise<MeetingSignal> {
    const empty: MeetingSignal = {
      meetingCount: 0,
      lastMeetingAt: null,
      lastMeetingTitle: null,
      openActionItemCount: 0,
      latestSummaryHeadline: null,
    };
    if (!this.baseUrl) return empty;

    const [meetingPage, summaries, actionItems] = await Promise.all([
      this.listMeetingsForContact(ctx, contactId, { limit: 25 }),
      this.listSummariesForContact(ctx, contactId, { limit: 5 }),
      this.listActionItemsForContact(ctx, contactId, { limit: 100 }),
    ]);

    // Most-recent meeting by startedAt (the app SHOULD return newest-first, but
    // pick defensively so order is not load-bearing).
    let last: FederatedMeeting | null = null;
    for (const m of meetingPage.items) {
      if (!last) {
        last = m;
        continue;
      }
      const a = m.startedAt ? Date.parse(m.startedAt) : 0;
      const b = last.startedAt ? Date.parse(last.startedAt) : 0;
      if (a > b) last = m;
    }

    const openActionItemCount = actionItems.filter(
      (a) => a.status === 'open' || a.status === 'in_progress',
    ).length;

    // Freshest summary headline (newest by createdAt).
    let latestSummary: FederatedMeetingSummary | null = null;
    for (const s of summaries) {
      if (!latestSummary) {
        latestSummary = s;
        continue;
      }
      const a = s.createdAt ? Date.parse(s.createdAt) : 0;
      const b = latestSummary.createdAt ? Date.parse(latestSummary.createdAt) : 0;
      if (a > b) latestSummary = s;
    }

    return {
      meetingCount: meetingPage.count || meetingPage.items.length,
      lastMeetingAt: last?.startedAt ?? null,
      lastMeetingTitle: last?.title ?? null,
      openActionItemCount,
      latestSummaryHeadline: latestSummary?.headline ?? null,
    };
  }
}

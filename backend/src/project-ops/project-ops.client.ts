/**
 * The concrete Project-Ops federation client.
 *
 * Speaks the project read surface Project-Ops exposes over MCP (JSON-RPC 2.0 over
 * `POST {PROJECT_OPS_BASE_URL}/mcp`). Project-Ops resolves the tenant from the
 * bearer's `workspace_id` claim (re-gated server-side), never a trusted header.
 * Tool used:
 *   - search_projects(query, limit) -> { projects: [...], count }
 *       Free-text across project title, description, project number, client name
 *       and organization name. We hand it the customer's org (or contact) name.
 *
 * AUTH: Customer-Ops calls Project-Ops as a service. The auth MODE is selectable
 * (mirrors the Contact-Ops / Meeting-Ops / Accounting-Ops clients):
 *   - `static` (default): forward a configured service token (PROJECT_OPS_SERVICE_TOKEN);
 *   - `brigade-sts`: mint a customer-ops client-credentials token and exchange it
 *     at Brigade (RFC-8693) for an `aud=project-ops`, workspace-bound token.
 * Project-Ops additionally gates the actor (PROJECT_OPS_FEDERATION_ACTORS must
 * include `customer-ops`). The workspace is addressed via X-Workspace-Id, which
 * Project-Ops re-gates — a hint, never the authz boundary. The mint seam is
 * isolated in `authHeaders()` / `bearerFor()` so the mode is a one-knob change.
 *
 * READ-ONLY: Customer-Ops never creates or mutates a project. There is no
 * entitlement gate (project reads are viewer-level) and no local link table.
 *
 * DEGRADE-CLEAN (binding): when PROJECT_OPS_BASE_URL is unset, `isConfigured()` is
 * false and every method returns [] without any fetch. The cockpit then renders
 * the projects slot as "connect Project-Ops" and makes no call.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';
import { FederationContext, ProjectLookup, ProjectOpsPort } from './project-ops.port';
import { FederatedProject } from './project-ops.types';

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
export class ProjectOpsClient extends ProjectOpsPort {
  private readonly logger = new Logger(ProjectOpsClient.name);
  private rpcId = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly brigade: BrigadeTokenSource,
  ) {
    super();
    if (!this.baseUrl) {
      this.logger.warn(
        'PROJECT_OPS_BASE_URL unset — Project-Ops federation is DORMANT; the ' +
          'customer-360 projects slot shows "connect Project-Ops" and no read is ' +
          'made until configured.',
      );
    } else {
      this.logger.log(
        `Project-Ops federation target: ${this.baseUrl} (auth=${this.authMode})`,
      );
    }
  }

  // --- configuration seam -------------------------------------------------

  private get baseUrl(): string | null {
    const raw = this.config.get<string>('PROJECT_OPS_BASE_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('PROJECT_OPS_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 8000;
  }

  /** How many projects to pull per customer (Project-Ops caps search at 50). */
  private get searchLimit(): number {
    const raw = this.config.get<string>('PROJECT_OPS_SEARCH_LIMIT');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 && n <= 50 ? Math.floor(n) : 25;
  }

  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  // --- auth (Brigade token-mint seam) ------------------------------------

  /** The auth mode: `static` forwards PROJECT_OPS_SERVICE_TOKEN (legacy / dev);
   *  `brigade-sts` mints a customer-ops client-credentials token and exchanges it
   *  at Brigade (RFC-8693) for a project-ops-audience, workspace-bound token.
   *  DEFAULT `static` so behavior is unchanged when PROJECT_OPS_AUTH_MODE is unset. */
  private get authMode(): 'static' | 'brigade-sts' {
    return this.config.get<string>('PROJECT_OPS_AUTH_MODE')?.trim() === 'brigade-sts'
      ? 'brigade-sts'
      : 'static';
  }

  private async authHeaders(ctx: FederationContext): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    // Workspace addressing. PROJECT_OPS_WORKSPACE_OVERRIDE maps this app's local
    // workspace id to the shared canonical id Project-Ops recognizes (the same
    // pattern as Contact-Ops / Meeting-Ops). Both the brigade exchange claim and
    // the X-Workspace-Id hint use it; Project-Ops re-gates membership server-side.
    const ws = this.workspaceOverride ?? ctx.workspaceId;
    const bearer = await this.bearerFor(ws);
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    headers['X-Workspace-Id'] = ws;
    if (ctx.ucUid) headers['X-Uc-Uid'] = ctx.ucUid;
    return headers;
  }

  /** Optional override mapping CO's local workspace id to the canonical id
   *  Project-Ops recognizes (PROJECT_OPS_WORKSPACE_OVERRIDE). Null = pass through
   *  the resolved workspace id unchanged. */
  private get workspaceOverride(): string | null {
    const w = this.config.get<string>('PROJECT_OPS_WORKSPACE_OVERRIDE');
    return w && w.trim() ? w.trim() : null;
  }

  /** Resolve the bearer per the auth mode. `static` forwards PROJECT_OPS_SERVICE_TOKEN;
   *  `brigade-sts` delegates to the shared BrigadeTokenSource (mint customer-ops CC →
   *  exchange for aud=project-ops). Degrade-clean: a failed exchange returns null
   *  and the caller sends no bearer (the read then 401s and degrades to []). */
  private async bearerFor(workspaceId: string): Promise<string | null> {
    if (this.authMode === 'static') {
      const t = this.config.get<string>('PROJECT_OPS_SERVICE_TOKEN');
      return t && t.trim() ? t.trim() : null;
    }
    return this.brigade.exchangedToken({
      audience: this.config.get<string>('PROJECT_OPS_AUDIENCE')?.trim() || 'project-ops',
      scope: this.config.get<string>('PROJECT_OPS_SCOPE')?.trim() || 'projects:read',
      workspaceId,
    });
  }

  // --- MCP JSON-RPC transport --------------------------------------------

  /**
   * Invoke one Project-Ops MCP tool via JSON-RPC `tools/call`. Returns the tool's
   * structuredContent (or parsed text content), or null on any transport/
   * application failure (logged). Never throws — federation is best-effort.
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
      this.logger.warn(`Project-Ops MCP ${name} transport error: ${(err as Error).message}`);
      return null;
    }

    if (!res.ok) {
      this.logger.warn(`Project-Ops MCP ${name} HTTP ${res.status}`);
      return null;
    }

    const raw = await res.text();
    const payload = this.parseRpc(raw);
    if (!payload) {
      this.logger.warn(`Project-Ops MCP ${name} unparseable response`);
      return null;
    }

    if (payload.error) {
      this.logger.warn(`Project-Ops MCP ${name} JSON-RPC error: ${payload.error.message}`);
      return null;
    }

    const result = payload.result;
    if (!result || result.isError) {
      const text = result?.content?.[0]?.text;
      this.logger.warn(`Project-Ops MCP ${name} tool error: ${text ?? 'unknown'}`);
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

  /** Parse a JSON-RPC response that may arrive as plain JSON OR as an SSE frame
   *  (`event: message\ndata: {...}`), which streamable-HTTP MCP servers emit. */
  private parseRpc(raw: string): JsonRpcResponse | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      // SSE framing: pull the last `data:` line and parse it.
      const dataLines = trimmed
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      const last = dataLines[dataLines.length - 1];
      if (!last) return null;
      try {
        return JSON.parse(last) as JsonRpcResponse;
      } catch {
        return null;
      }
    }
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

  // --- ProjectOpsPort implementation -------------------------------------

  async listProjectsForContact(
    ctx: FederationContext,
    lookup: ProjectLookup,
  ): Promise<FederatedProject[]> {
    if (!this.baseUrl) return [];
    // Prefer the organization name (an account maps to its org's projects);
    // fall back to the contact's display name. No usable key → no call.
    const query = (lookup.orgName || lookup.contactName || '').trim();
    if (!query) return [];

    const raw = await this.callTool(ctx, 'search_projects', {
      query,
      limit: this.searchLimit,
    });
    if (!raw) return [];

    const projects = Array.isArray(raw['projects']) ? (raw['projects'] as unknown[]) : [];
    return projects
      .map((p) => this.mapProject(p as Record<string, unknown>))
      .filter((p): p is FederatedProject => p !== null);
  }

  // --- mapping: Project-Ops wire shape -> Customer-Ops projection ---------

  private mapProject(p: Record<string, unknown>): FederatedProject | null {
    const id = typeof p['id'] === 'string' ? (p['id'] as string) : null;
    if (!id) return null;

    const org = (p['organization'] as Record<string, unknown> | null) ?? null;
    const assignee = (p['assignedTo'] as Record<string, unknown> | null) ?? null;

    return {
      id,
      projectNumber: (p['projectNumber'] as string) ?? '',
      title: (p['title'] as string) ?? '(untitled project)',
      status: (p['status'] as string) ?? 'NEW',
      priority: (p['priority'] as string) ?? 'MEDIUM',
      dueDate: (p['dueDate'] as string | null) ?? null,
      clientName: (p['clientName'] as string | null) ?? null,
      organizationName: org && typeof org['name'] === 'string' ? (org['name'] as string) : null,
      assignedTo: assignee ? this.mapAssignee(assignee) : null,
    };
  }

  private mapAssignee(a: Record<string, unknown>): FederatedProject['assignedTo'] {
    const first = (a['firstName'] as string) ?? '';
    const last = (a['lastName'] as string) ?? '';
    const display = `${first} ${last}`.trim() || (a['email'] as string) || '(unassigned)';
    return { displayName: display, email: (a['email'] as string | null) ?? null };
  }
}

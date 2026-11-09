/**
 * The concrete Agent-Inference client.
 *
 * With CUSTOMER_OPS_USE_ORG_ROUTE unset/false, this preserves the existing
 * OpenAI-shaped instance path and its lane aliases. With the flag enabled, the
 * client calls ORG_GATEWAY_BASE_URL with an opaque org key from Ops-Center and
 * sends the bare named route `concierge` or `batch` as the model. The gateway
 * owns the route target and metering policy.
 *
 * ENTITLEMENT (binding): `customer-ops` is required to run any agent (bundled
 * lanes 1-2); a 'metered' request also requires `ai-metered` (lanes 3-4).
 * `checkEntitlement` is the pure gate; `complete` re-checks (defense-in-depth)
 * and DOWNGRADES a metered request to bundled when the bearer lacks `ai-metered`.
 *
 * FAILURE: the old instance path remains best-effort when the flag is off. The
 * org path fails visibly with OrgRouteInferenceError when its key or gateway
 * fails, unless CUSTOMER_OPS_ORG_ROUTE_FALLBACK=instance explicitly enables the
 * named migration fallback.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentInferencePort, InferenceContext } from './agent-inference.port';
import {
  AgentInferenceRequest,
  AgentInferenceResult,
  InferenceEntitlementDecision,
  InferenceRoute,
  InferenceTier,
} from './agent-inference.types';
import {
  ORG_GATEWAY_KEY_PROVIDER,
  OpsCenterOrgGatewayKeyProvider,
  OrgGatewayKeyProvider,
} from './org-gateway-key.provider';

interface ChatChoice {
  message?: { content?: string };
}
interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
  usage?: ChatUsage;
  // Ops-Center routing/meter echo. Both body fields are tolerated.
  x_uc_lane?: number;
  x_uc_metered?: boolean;
}

/** Canonical suite SKU strings (must match Lago/Keycloak). */
export const SKU_CUSTOMER_OPS = 'customer-ops';
export const SKU_AI_METERED = 'ai-metered';

/** SKU spelling/alias tolerance. Normalized on read only. */
const SKU_ALIASES: Record<string, string> = {
  'customer-ops': SKU_CUSTOMER_OPS,
  customer_ops: SKU_CUSTOMER_OPS,
  customerops: SKU_CUSTOMER_OPS,
  co: SKU_CUSTOMER_OPS,
  'ai-metered': SKU_AI_METERED,
  ai_metered: SKU_AI_METERED,
  aimetered: SKU_AI_METERED,
  'metered-ai': SKU_AI_METERED,
  metered_ai: SKU_AI_METERED,
  ai: SKU_AI_METERED,
};

function normalizeSku(code: string): string {
  const key = (code || '').trim().toLowerCase();
  return SKU_ALIASES[key] ?? key;
}

function truthy(value: unknown): boolean {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/** A failed org-route call must be visible to the endpoint caller. */
export class OrgRouteInferenceError extends Error {
  constructor(feature: string, route: InferenceRoute, reason: string) {
    const retry = route === 'concierge' ? ' Please retry the interactive request.' : '';
    super(`Org gateway failure for feature=${feature} on route=${route}: ${reason}.${retry}`);
    this.name = 'OrgRouteInferenceError';
  }
}

@Injectable()
export class AgentInferenceClient extends AgentInferencePort {
  private readonly logger = new Logger(AgentInferenceClient.name);
  private readonly orgGatewayKeyProvider: OrgGatewayKeyProvider;
  private orgRouteFallbackCount = 0;

  constructor(
    private readonly config: ConfigService,
    @Optional()
    @Inject(ORG_GATEWAY_KEY_PROVIDER)
    orgGatewayKeyProvider?: OrgGatewayKeyProvider,
  ) {
    super();
    this.orgGatewayKeyProvider =
      orgGatewayKeyProvider ?? new OpsCenterOrgGatewayKeyProvider(this.config);
    if (this.useOrgRoute()) {
      this.logger.log(
        `Agent inference org route enabled (gatewayConfigured=${Boolean(this.orgGatewayBaseUrl)})`,
      );
    } else if (!this.instanceBaseUrl) {
      this.logger.warn(
        'AGENT_INFERENCE_BASE_URL unset — the relationship agents inference lane is ' +
          'DORMANT; lead-triage / follow-up / collections-nudge return a "connect ' +
          'inference" result and make no model call until configured. (Routing + ' +
          'metering live in ops-center uchub-litellm per the 4-lane model.)',
      );
    } else {
      this.logger.log(`Agent inference gateway: ${this.instanceBaseUrl} (mode=${this.mode()})`);
    }
  }

  // --- configuration seam -------------------------------------------------

  private useOrgRoute(): boolean {
    return truthy(this.config.get<string>('CUSTOMER_OPS_USE_ORG_ROUTE'));
  }

  private get instanceBaseUrl(): string | null {
    const raw = this.config.get<string>('AGENT_INFERENCE_BASE_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  private get orgGatewayBaseUrl(): string | null {
    const raw = this.config.get<string>('ORG_GATEWAY_BASE_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/+$/, '') : null;
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('AGENT_INFERENCE_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 30000;
  }

  /** The legacy lane-alias model name used only by the instance path. */
  private modelAlias(tier: InferenceTier): string {
    if (tier === 'metered') {
      return this.config.get<string>('AGENT_INFERENCE_METERED_MODEL')?.trim() || 'uc-metered';
    }
    return this.config.get<string>('AGENT_INFERENCE_BUNDLED_MODEL')?.trim() || 'uc-bundled';
  }

  /**
   * Entitlement mode. Suite var `UC_ENTITLEMENT_MODE` wins, falling back to an
   * inference-specific `AGENT_INFERENCE_ENTITLEMENT_MODE`. "open" means allow
   * with a warning; anything else, including the default, is strict.
   */
  private mode(): 'enforce' | 'open' {
    const raw =
      this.config.get<string>('UC_ENTITLEMENT_MODE') ??
      this.config.get<string>('AGENT_INFERENCE_ENTITLEMENT_MODE') ??
      'enforce';
    return raw.trim().toLowerCase() === 'open' ? 'open' : 'enforce';
  }

  isConfigured(): boolean {
    // Once the org route is explicitly enabled, report it as active so missing
    // gateway/key configuration fails visibly from complete() instead of being
    // mistaken for the old cleanly dormant instance path.
    return this.useOrgRoute() ? true : this.instanceBaseUrl !== null;
  }

  private authHeaders(ctx: InferenceContext): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.config.get<string>('AGENT_INFERENCE_SERVICE_TOKEN');
    if (token && token.trim()) headers['Authorization'] = `Bearer ${token.trim()}`;
    headers['X-Workspace-Id'] = ctx.workspaceId;
    if (ctx.ucUid) headers['X-Uc-Uid'] = ctx.ucUid;
    return headers;
  }

  private orgAuthHeaders(
    ctx: InferenceContext,
    orgId: string,
    request: AgentInferenceRequest,
    key: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'X-UC-Org-Id': orgId,
      'X-UC-App': 'customer-ops',
      'X-UC-Feature': request.task,
      // Keep the existing workspace hint for gateway deployments that use it for
      // request routing. It is never used as the bearer or org identity.
      'X-Workspace-Id': ctx.workspaceId,
    };
    if (ctx.ucUid) headers['X-UC-User-Id'] = ctx.ucUid;
    return headers;
  }

  // --- entitlement gate (pure) -------------------------------------------

  checkEntitlement(ctx: InferenceContext, requested: InferenceTier): InferenceEntitlementDecision {
    const have = new Set((ctx.entitlements ?? []).map(normalizeSku));
    const hasBase = have.has(SKU_CUSTOMER_OPS);
    const hasMetered = have.has(SKU_AI_METERED);
    const mode = this.mode();

    // Open bootstrap: allow at the requested tier with a loud WARN.
    if (mode === 'open') {
      this.logger.warn(
        `Agent inference entitlement gate is OPEN (UC_ENTITLEMENT_MODE=open) — allowing a ` +
          `'${requested}' inference call for workspace=${ctx.workspaceId} WITHOUT the SKU ` +
          `check. Set the mode to 'enforce' once Lago emits entitlements.`,
      );
      return {
        allowed: true,
        tierAllowed: requested,
        mode,
        reason: 'open bootstrap: SKU check bypassed (UC_ENTITLEMENT_MODE=open)',
      };
    }

    // Strict: the base SKU is required to run any agent at all.
    if (!hasBase) {
      return {
        allowed: false,
        tierAllowed: 'bundled',
        mode,
        reason:
          'not entitled: the relationship agents require the customer-ops subscription; ' +
          'the bearer does not carry it.',
      };
    }

    // Base SKU present. A metered request needs ai-metered too; otherwise the
    // caller is still allowed at the BUNDLED tier (the agent downgrades).
    if (requested === 'metered' && !hasMetered) {
      return {
        allowed: true,
        tierAllowed: 'bundled',
        mode,
        reason:
          'metered AI not entitled: the bearer carries customer-ops but not ai-metered; ' +
          'the request is allowed at the BUNDLED tier (lanes 1-2) only.',
      };
    }

    return {
      allowed: true,
      tierAllowed: requested,
      mode,
      reason:
        requested === 'metered'
          ? 'entitled: bearer carries customer-ops + ai-metered (metered lanes 3-4 allowed)'
          : 'entitled: bearer carries customer-ops (bundled lanes 1-2)',
    };
  }

  // --- inference transport -----------------------------------------------

  async complete(
    ctx: InferenceContext,
    request: AgentInferenceRequest,
  ): Promise<AgentInferenceResult | null> {
    if (this.useOrgRoute()) return this.completeViaOrgRoute(ctx, request);

    const base = this.instanceBaseUrl;
    if (!base) return null;

    // Defense-in-depth: the agents pre-check, but never call without the gate
    // passing. DOWNGRADE a metered request to bundled when ai-metered is absent
    // (so the agent still produces a bundled-lane draft) rather than failing.
    const gate = this.checkEntitlement(ctx, request.tier);
    if (!gate.allowed) {
      this.logger.warn(`Agent inference DENIED for workspace=${ctx.workspaceId}: ${gate.reason}`);
      return null;
    }
    const effectiveTier = gate.tierAllowed;

    return this.postCompletion(
      base,
      this.requestBody(ctx, request, this.modelAlias(effectiveTier), effectiveTier, true),
      this.authHeaders(ctx),
      effectiveTier,
    );
  }

  /**
   * Resolve the org key and call the named route. The existing five agents are
   * interactive and therefore use concierge; a future bulk caller sets bulk=true
   * and uses batch. The workspace id is the org id here because AuthService's
   * entitled path provisions Workspace.id directly from AuthService's
   * resolveOrgEntitlement().orgId via WorkspaceProvisioningService.
   */
  private async completeViaOrgRoute(
    ctx: InferenceContext,
    request: AgentInferenceRequest,
  ): Promise<AgentInferenceResult | null> {
    const gate = this.checkEntitlement(ctx, request.tier);
    if (!gate.allowed) {
      this.logger.warn(`Agent inference DENIED for workspace=${ctx.workspaceId}: ${gate.reason}`);
      return null;
    }
    const effectiveTier = gate.tierAllowed;
    const route = this.routeFor(request);
    const orgId = ctx.workspaceId.trim();
    if (!orgId) {
      throw new OrgRouteInferenceError(request.task, route, 'the resolved workspace has no org id');
    }

    const base = this.orgGatewayBaseUrl;
    if (!base) {
      return this.orgRouteFailure(
        ctx,
        request,
        effectiveTier,
        orgId,
        route,
        'gateway URL is not configured',
      );
    }

    let gatewayKey: string;
    try {
      const supplied = await this.orgGatewayKeyProvider.getKey(orgId);
      gatewayKey = supplied?.key?.trim() ?? '';
      if (!gatewayKey) throw new Error('empty gateway key');
    } catch {
      return this.orgRouteFailure(
        ctx,
        request,
        effectiveTier,
        orgId,
        route,
        'org key fetch failed',
      );
    }

    const result = await this.postCompletion(
      base,
      this.requestBody(ctx, request, route, effectiveTier, false),
      this.orgAuthHeaders(ctx, orgId, request, gatewayKey),
      effectiveTier,
    );
    if (result) return result;
    return this.orgRouteFailure(
      ctx,
      request,
      effectiveTier,
      orgId,
      route,
      'gateway request failed',
    );
  }

  private routeFor(request: AgentInferenceRequest): InferenceRoute {
    return request.bulk === true ? 'batch' : 'concierge';
  }

  private requestBody(
    ctx: InferenceContext,
    request: AgentInferenceRequest,
    model: string,
    effectiveTier: InferenceTier,
    includeLegacyMetadata: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: request.maxOutputTokens ?? 1024,
      temperature: request.temperature ?? 0.3,
    };
    if (includeLegacyMetadata) {
      // Preserve the old instance-path request shape while the flag is off.
      body['metadata'] = {
        workspace_id: ctx.workspaceId,
        uc_uid: ctx.ucUid ?? null,
        task: request.task,
        tier: effectiveTier,
      };
    }
    if (request.responseFormat === 'json') {
      body['response_format'] = { type: 'json_object' };
    }
    return body;
  }

  private async orgRouteFailure(
    ctx: InferenceContext,
    request: AgentInferenceRequest,
    effectiveTier: InferenceTier,
    orgId: string,
    route: InferenceRoute,
    reason: string,
  ): Promise<AgentInferenceResult> {
    const fallbackBase = this.instanceBaseUrl;
    if (this.orgRouteFallback() === 'instance' && fallbackBase) {
      this.orgRouteFallbackCount += 1;
      this.logger.warn(
        JSON.stringify({
          event: 'customer_ops_org_route_fallback',
          app: 'customer-ops',
          orgId,
          feature: request.task,
          fallback: 'instance',
          count: this.orgRouteFallbackCount,
        }),
      );
      const result = await this.postCompletion(
        fallbackBase,
        this.requestBody(ctx, request, this.modelAlias(effectiveTier), effectiveTier, true),
        this.authHeaders(ctx),
        effectiveTier,
      );
      if (result) return result;
    }
    throw new OrgRouteInferenceError(request.task, route, reason);
  }

  private orgRouteFallback(): 'instance' | null {
    return this.config.get<string>('CUSTOMER_OPS_ORG_ROUTE_FALLBACK')?.trim().toLowerCase() ===
      'instance'
      ? 'instance'
      : null;
  }

  /** Number of calls that used the explicitly configured migration fallback. */
  getOrgRouteFallbackCount(): number {
    return this.orgRouteFallbackCount;
  }

  private async postCompletion(
    base: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    effectiveTier: InferenceTier,
  ): Promise<AgentInferenceResult | null> {
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.warn(`Agent inference transport error: ${(err as Error).message}`);
      return null;
    }
    if (!res.ok) {
      this.logger.warn(`Agent inference HTTP ${res.status}`);
      return null;
    }
    let payload: ChatResponse;
    try {
      payload = (await res.json()) as ChatResponse;
    } catch (err) {
      this.logger.warn(`Agent inference non-JSON response: ${(err as Error).message}`);
      return null;
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      this.logger.warn('Agent inference response had no message content');
      return null;
    }
    return {
      text: content,
      lane: typeof payload.x_uc_lane === 'number' ? payload.x_uc_lane : null,
      model: typeof payload.model === 'string' ? payload.model : null,
      metered: payload.x_uc_metered === true || effectiveTier === 'metered',
      promptTokens:
        typeof payload.usage?.prompt_tokens === 'number' ? payload.usage.prompt_tokens : null,
      completionTokens:
        typeof payload.usage?.completion_tokens === 'number'
          ? payload.usage.completion_tokens
          : null,
    };
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

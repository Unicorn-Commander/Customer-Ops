/**
 * The concrete Agent-Inference client.
 *
 * Speaks the control-plane inference gateway — ops-center `uchub-litellm` (LLM
 * routing + metering to local GPUs / external providers), reached as a service
 * (Brigade brokers the agent token in production). litellm is OpenAI-compatible,
 * so this client posts an OpenAI-shaped chat-completions request and lets the
 * gateway pick the lane (1-4) + meter it (SUITE-ARCHITECTURE-MAP §1 + §8):
 *
 *   POST {AGENT_INFERENCE_BASE_URL}/v1/chat/completions
 *     { model, messages, response_format?, max_tokens?, temperature?,
 *       metadata: { workspace_id, uc_uid, task, tier } }   // metering dimensions
 *   -> { choices: [{ message: { content } }], model, usage: {...},
 *        x_uc_lane?, x_uc_metered? }                        // routing/meter echo
 *
 * The `model` we send is a LANE ALIAS, not a concrete model — the gateway maps the
 * alias ('uc-bundled' / 'uc-metered') to whatever model the policy chooses for
 * that workspace/tier. Customer-Ops never names a model (that is the gateway's
 * job); the alias just states the tier. The aliases are overridable via env so an
 * operator can point them at their litellm model groups.
 *
 * AUTH: the bearer is a federation/agent token carrying the addressed
 * `workspace_id` claim + the metered-AI scope. Minting it is Brigade's job
 * (RFC-8693); until that seam is wired this client forwards a configured service
 * token (AGENT_INFERENCE_SERVICE_TOKEN). The mint seam is isolated in
 * `authHeaders()` so swapping to Brigade is a one-method change.
 *
 * ENTITLEMENT (binding): `customer-ops` is required to run any agent (bundled
 * lanes 1-2); a 'metered' request also requires `ai-metered` (lanes 3-4).
 * `checkEntitlement` is the pure gate; `complete` re-checks (defense-in-depth) and
 * DOWNGRADES a metered request to bundled when the bearer lacks `ai-metered`
 * rather than failing — so an agent still produces a (bundled-lane) draft. The
 * suite verb "enforce" == strict; "open" == the pre-Lago bootstrap (allow+WARN).
 *
 * DEGRADE-CLEAN (binding): when AGENT_INFERENCE_BASE_URL is unset, `isConfigured()`
 * is false and `complete` returns null without any fetch. The agents then return a
 * clean "connect inference" result (no draft, no side effect). Best-effort: any
 * transport/HTTP/parse failure returns null (the agent surfaces it), never throws.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentInferencePort, InferenceContext } from './agent-inference.port';
import {
  AgentInferenceRequest,
  AgentInferenceResult,
  InferenceEntitlementDecision,
  InferenceTier,
} from './agent-inference.types';

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
  // ops-center routing/meter echo (litellm custom headers surfaced into the body
  // by the gateway, or top-level fields — both tolerated).
  x_uc_lane?: number;
  x_uc_metered?: boolean;
}

/** Canonical suite SKU strings (must match Lago/Keycloak). */
export const SKU_CUSTOMER_OPS = 'customer-ops';
export const SKU_AI_METERED = 'ai-metered';

/** SKU spelling/alias tolerance — accept whatever shape the upstream claim lands.
 *  Normalized on read only (mirrors the AO/Email clients). */
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

@Injectable()
export class AgentInferenceClient extends AgentInferencePort {
  private readonly logger = new Logger(AgentInferenceClient.name);

  constructor(private readonly config: ConfigService) {
    super();
    if (!this.baseUrl) {
      this.logger.warn(
        'AGENT_INFERENCE_BASE_URL unset — the relationship agents inference lane is ' +
          'DORMANT; lead-triage / follow-up / collections-nudge return a "connect ' +
          'inference" result and make no model call until configured. (Routing + ' +
          'metering live in ops-center uchub-litellm per the 4-lane model.)',
      );
    } else {
      this.logger.log(`Agent inference gateway: ${this.baseUrl} (mode=${this.mode()})`);
    }
  }

  // --- configuration seam -------------------------------------------------

  private get baseUrl(): string | null {
    const raw = this.config.get<string>('AGENT_INFERENCE_BASE_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('AGENT_INFERENCE_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 30000;
  }

  /** The lane-alias model name the gateway maps to a concrete model for the tier.
   *  Overridable per node so an operator can point at their litellm model groups. */
  private modelAlias(tier: InferenceTier): string {
    if (tier === 'metered') {
      return this.config.get<string>('AGENT_INFERENCE_METERED_MODEL')?.trim() || 'uc-metered';
    }
    return this.config.get<string>('AGENT_INFERENCE_BUNDLED_MODEL')?.trim() || 'uc-bundled';
  }

  /**
   * Entitlement mode. Suite var `UC_ENTITLEMENT_MODE` wins, falling back to an
   * inference-specific `AGENT_INFERENCE_ENTITLEMENT_MODE`. "open" => bootstrap
   * (allow+WARN); anything else (incl. "enforce", the default) => strict.
   */
  private mode(): 'enforce' | 'open' {
    const raw =
      this.config.get<string>('UC_ENTITLEMENT_MODE') ??
      this.config.get<string>('AGENT_INFERENCE_ENTITLEMENT_MODE') ??
      'enforce';
    return raw.trim().toLowerCase() === 'open' ? 'open' : 'enforce';
  }

  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  private authHeaders(ctx: InferenceContext): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.config.get<string>('AGENT_INFERENCE_SERVICE_TOKEN');
    if (token && token.trim()) headers['Authorization'] = `Bearer ${token.trim()}`;
    headers['X-Workspace-Id'] = ctx.workspaceId;
    if (ctx.ucUid) headers['X-Uc-Uid'] = ctx.ucUid;
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
    const base = this.baseUrl;
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

    const body: Record<string, unknown> = {
      model: this.modelAlias(effectiveTier),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: request.maxOutputTokens ?? 1024,
      temperature: request.temperature ?? 0.3,
      // Metering dimensions ops-center keys the meter on.
      metadata: {
        workspace_id: ctx.workspaceId,
        uc_uid: ctx.ucUid ?? null,
        task: request.task,
        tier: effectiveTier,
      },
    };
    if (request.responseFormat === 'json') {
      body['response_format'] = { type: 'json_object' };
    }

    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: this.authHeaders(ctx),
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

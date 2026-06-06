# Runbook — Activate the agent inference lane (uchub-litellm)

**Status: OPERATIONAL.** Authored 2026-06-06 (workstream w5-inference). This is the
runbook for lighting up the Customer-Ops relationship agents (lead-triage /
follow-up-drafter / collections-nudge) by pointing the `AgentInferencePort` at the
ops-center inference gateway. Until `AGENT_INFERENCE_BASE_URL` is set the agents are
DORMANT by design — they return a "connect inference" result, assemble their
context, and make **no** model call (degrade-clean).

Customer-Ops owns relationship + stage only. It **never runs a model, never routes,
never meters.** The gateway owns the lane→model mapping and the meter. This runbook
only wires the *seam*; nothing here changes that boundary.

---

## 0. What the gateway actually is (discovered 2026-06-06)

The "ops-center uchub-litellm" gateway is the `uchub-litellm` container on
**commander** (`UC-1-Hub/docker-compose.yml`):

| Fact | Value |
|---|---|
| Container | `uchub-litellm` (`ghcr.io/berriai/litellm:main-stable`) on commander |
| Listen | `100.79.41.137:4000` (bound to the **tailnet** IP, not localhost) |
| In-cluster name | `http://uchub-litellm:4000` (only on commander's `web`/`uchub-network` — **NOT** routable from bigboy) |
| Tailnet name | `http://commander.unicorncommander.net:4000` (this is what bigboy uses) |
| Public | `https://llm.unicorncommander.ai` (Traefik, `Host(llm.${DOMAIN})`) |
| Config | `/home/muut/UC-1-Hub/config/litellm-config.yaml` |
| Auth | native LiteLLM: `Authorization: Bearer <master-key | virtual-key>` |
| Meter | Lago `success_callback` (`event_name=ai_api_call`, `CHARGE_BY=user_id`) |
| Routing | model-name prefix → provider. `local/*`→bigboy GPU (free); `claude-*`/`openrouter/*`→OpenRouter (metered) |

**Auth is a static LiteLLM virtual key — NOT Brigade / RFC-8693.** The gateway's own
config header states *"Ops-Center enforces access control, LiteLLM is a dumb
proxy."* Access keys are LiteLLM **virtual keys** minted by the ops-center
`entitlements-api` via litellm `POST /key/generate` (using `LITELLM_MASTER_KEY`).
Every other consumer authenticates the same way — e.g. `unicorn-brigade-api` carries
`OPS_CENTER_LLM_ENDPOINT=http://uchub-litellm:4000` + a static `sk-…` `LITELLM_KEY`.
Brigade is a *client* of litellm, it does not broker access to it. There is no
token-exchange path into the gateway, so Customer-Ops uses the same static-key model
via its existing `AGENT_INFERENCE_SERVICE_TOKEN` bearer (the
`AgentInferenceClient.authHeaders()` seam). **This is why there is no
`AGENT_INFERENCE_AUTH_MODE` — a brigade-sts mode would have nothing to exchange
against.**

There is **no `uc-bundled` / `uc-metered` model_group** defined in the gateway. The
lane aliases must therefore be overridden to real `model_name`s from the litellm
config (the client supports this exact override — that is its design):

| Lane | Alias env | Mapped model (real litellm `model_name`) | Provider / cost |
|---|---|---|---|
| bundled (1-2) | `AGENT_INFERENCE_BUNDLED_MODEL` | `local/qwen3.6-35b-a3b` | bigboy llama.cpp GPU via Tailscale — **free**, not metered |
| metered (3-4) | `AGENT_INFERENCE_METERED_MODEL` | `claude-3.5-sonnet` | OpenRouter — **metered** in Lago |

The metered lane is only reachable when the bearer carries `ai-metered`; without it
the client downgrades to the bundled alias (no metered spend). Pick any other
`model_name` from `litellm-config.yaml` if you want a different bundled/metered model
(e.g. `local/qwen3-30b`, or `claude-3.5-haiku` for a cheaper metered lane).

---

## 1. Activate on the dogfood deploy (bigboy)

Edit `deploy/.env` on bigboy (see the commented block in
`deploy/.env.dogfood.example`) and set the four inference lines:

```ini
AGENT_INFERENCE_BASE_URL=http://commander.unicorncommander.net:4000
AGENT_INFERENCE_SERVICE_TOKEN=<litellm virtual key, sk-... , from Vaultwarden>
AGENT_INFERENCE_BUNDLED_MODEL=local/qwen3.6-35b-a3b
AGENT_INFERENCE_METERED_MODEL=claude-3.5-sonnet
# UC_ENTITLEMENT_MODE=open stays as-is for dogfood (agents run without a Lago SKU
# check, loud WARN). Leave AGENT_INFERENCE_ENTITLEMENT_MODE unset.
```

The client trims a trailing slash and appends `/v1/chat/completions`, so do **not**
include a path. If `commander.unicorncommander.net` does not resolve from the
backend container, use the raw tailnet IP `http://100.79.41.137:4000` (same host).

Recycle the backend so the new env is loaded (recreate, **not** restart):

```bash
cd ~/customer-ops
docker compose -f deploy/docker-compose.dogfood.yml up -d backend
```

On startup the client logs one of:
- dormant: `AGENT_INFERENCE_BASE_URL unset — … DORMANT …`
- active:  `Agent inference gateway: http://commander.unicorncommander.net:4000 (mode=open)`

Confirm the active line:

```bash
docker compose -f deploy/docker-compose.dogfood.yml logs backend | grep -i "inference"
```

---

## 2. Verify — curl smoke straight at the gateway

Run these **from bigboy** (the dogfood host) so you exercise the exact network path
the backend uses. Replace `$KEY` with the same virtual key you put in
`AGENT_INFERENCE_SERVICE_TOKEN` (export it in the shell; never paste it into a file
or a commit).

```bash
GW=http://commander.unicorncommander.net:4000
export KEY=<litellm virtual key>

# (a) reachability + auth is enforced — no key MUST be 401:
curl -s -o /dev/null -w "no-auth -> %{http_code}\n" "$GW/v1/models"     # expect 401

# (b) the key is accepted — /v1/models with the bearer MUST be 200:
curl -s -o /dev/null -w "with-key -> %{http_code}\n" \
  -H "Authorization: Bearer $KEY" "$GW/v1/models"                       # expect 200

# (c) BUNDLED lane (local GPU, free) — the shape the client posts:
curl -s "$GW/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "local/qwen3.6-35b-a3b",
    "max_tokens": 32, "temperature": 0.3,
    "messages": [{"role":"user","content":"Reply with the single word: ok"}],
    "metadata": {"workspace_id":"smoke","uc_uid":"smoke","task":"lead-triage","tier":"bundled"}
  }' | python3 -m json.tool

# (d) METERED lane (external, Lago-metered) — only if you intend to spend:
curl -s "$GW/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3.5-sonnet",
    "max_tokens": 32, "temperature": 0.3,
    "messages": [{"role":"user","content":"Reply with the single word: ok"}],
    "metadata": {"workspace_id":"smoke","uc_uid":"smoke","task":"follow-up-draft","tier":"metered"}
  }' | python3 -m json.tool
```

### Reading the lane / meter "echo" (important — what is real vs aspirational)

The `AgentInferenceClient` reads `x_uc_lane` / `x_uc_metered` top-level fields **if
present**, but this LiteLLM build does **not** emit them. So the *real* echo is:

- **Lane / model** = the response `model` field. It tells you which model actually
  served, which is the lane signal:
  - `"model": "local/qwen3.6-35b-a3b"` (or the resolved upstream id) → **bundled**
    lane, local GPU, free.
  - `"model": "claude-3.5-sonnet"` (or `anthropic/claude-3.5-sonnet`) → **metered**
    lane, external.
- **Meter** = there is no per-response header. The client reports `metered:true`
  whenever the effective tier was `metered` (derived, not echoed). To confirm the
  meter actually *fired*, check **Lago** — the metered call (d) emits an
  `ai_api_call` usage event (`event_properties: model, cost, user`). The free
  bundled call (c) routes to the local GPU and is **not** billed.
- **Usage** = the response `usage.{prompt_tokens,completion_tokens}` is real and is
  what the client surfaces as `promptTokens` / `completionTokens`.

A 200 with a non-empty `choices[0].message.content` on (c) means the lane is live;
the agents will now produce drafts instead of "connect inference".

### Verify end-to-end through Customer-Ops

After (c) passes, exercise an agent through the app (any one of lead-triage /
follow-up-drafter / collections-nudge — e.g. trigger a lead triage from the cockpit
or its MCP tool) and confirm the result is a real draft with a populated `model` /
token usage, not the `inferenceConfigured:false` "connect inference" payload. The
backend logs `Agent inference gateway: …` at boot and warns (never throws) on any
gateway hiccup — a transient gateway failure degrades the agent to a clean
draft-only result, it does not 500 the request.

---

## 3. Dogfood vs prod

| | **Dogfood** (bigboy, `customer-ops.magicunicorn.dev`) | **Prod / customer** |
|---|---|---|
| `AGENT_INFERENCE_BASE_URL` | `http://commander.unicorncommander.net:4000` (tailnet hop) | `https://llm.unicorncommander.ai` (or the customer's own gateway) |
| `AGENT_INFERENCE_SERVICE_TOKEN` | a dogfood-scoped litellm virtual key | a per-tenant / per-deploy virtual key (least privilege, separately metered) |
| `UC_ENTITLEMENT_MODE` | `open` — agents run for any signed-in user, **no** SKU check, loud WARN | `enforce` — `customer-ops` required for bundled, `ai-metered` for the metered lane |
| Metered lane | available but discouraged (use the free local lane for dogfood) | gated by `ai-metered`; Lago bills the metered model |
| Bundled model | `local/qwen3.6-35b-a3b` (bigboy GPU, free) | same, or a customer-local model if self-hosting the gateway |

**The prod flip (`UC_ENTITLEMENT_MODE=enforce`) is a deliberate, separately-reviewed
change** — see `deploy/DEPLOY.md` → "go-live toggles". Once Lago emits the
entitlement claim, set `enforce` and `up -d backend`. Before that flip, a bearer
without `ai-metered` is silently downgraded to the bundled (free) lane, so flipping
to `enforce` is what actually starts denying the metered lane / charging for it.

---

## 4. If the gateway is unreachable / not yet keyed

Everything above degrades clean. With `AGENT_INFERENCE_BASE_URL` blank (or the
gateway down, or the key wrong → 401/403), the agents return
`inferenceConfigured:false` (or a best-effort `null` from the client) and surface a
"connect inference" affordance. The cockpit stays fully functional; nothing 500s.
Re-run §2(b) to confirm the key before blaming the app.

What Aaron must supply to activate:
1. A **LiteLLM virtual key** scoped for customer-ops (mint via the ops-center
   entitlements-api `/key/generate`, or the litellm admin UI, using
   `LITELLM_MASTER_KEY`) → store in Vaultwarden → paste into
   `AGENT_INFERENCE_SERVICE_TOKEN`.
2. Confirm bigboy → commander:4000 reachability (verified working 2026-06-06:
   `http://100.79.41.137:4000/` and `http://commander.unicorncommander.net:4000/`
   both return 200 from bigboy over Tailscale).

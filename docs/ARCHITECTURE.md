# Customer‑Ops — Architecture

For developers and operators. The user‑facing tour is [`USER-GUIDE.md`](USER-GUIDE.md); the product overview is the [README](../README.md).

---

## Principle: a surface, not an engine

Customer‑Ops owns exactly one thing — **the relationship**: its lifecycle stage, its pipeline position, its provenance, and the thin links it keeps to records in other apps. Everything else (contacts, invoices, mail, meetings, projects, campaigns) is **federated at read time** from the app that owns it. There is no second phonebook and no second ledger here.

Three invariants hold everywhere:

- **Federate, don't fork.** A federated panel is resolved live and held only for the request. The only local state is a thin link row (e.g. `customer_invoice_link` = the `(external_source, external_ref)` memory + a cached status).
- **Degrade‑clean.** Every external dependency — each seam, the graph, the AI — is optional. Unconfigured or unreachable, it no‑ops and renders "connect"; it never throws and never blocks the cockpit.
- **Tenancy is DB‑enforced.** Isolation is Postgres RLS, not application code.

---

## Stack & layout

NestJS 10 + Prisma 5 + Postgres 17 (backend, `:3211`, also an MCP server), Next.js 15 (frontend, `:3000`), FalkorDB (graph), Keycloak (SSO) + Brigade (federation broker), LiteLLM (inference).

```
backend/src/
├── customers/        relationship logic · funnel · customer-360 · write paths
├── graph/            FalkorDB knowledge graph (falkordb · service · ingest · controller)
├── agents/           Relations Officer sub-agents + the selectable inference lane
├── lead-intake/      the ingest_lead front door + provisional-label resolver
├── {contact,accounting,email,meeting,project,outreach}-ops/   one federation seam each
├── health/           liveness · readiness · /health/integrations
├── common/
│   ├── workspace/    the RLS GUC chokepoint + membership guard
│   └── federation/   the Brigade token source (RFC-8693 mint/exchange)
└── prisma/
```

---

## Multi‑tenancy (RLS)

Every tenant‑scoped table carries `workspaceId` and runs under Postgres **Row‑Level Security** (`ENABLE` + `FORCE`). All DB access flows through one chokepoint — `WorkspaceContextService` — which opens a transaction, sets `current_workspace_id()` (a GUC) to the membership‑resolved workspace, and runs queries as a `NOBYPASSRLS` application role. The requested workspace must be one the caller actually belongs to (`memberships`), or the request is refused. `CUSTOMER_OPS_TENANCY_ENABLED` gates the whole mechanism; flip it on only after `scripts/verify-tenancy.sh`.

The graph mirrors this: every node and edge is namespaced by a per‑workspace key (`cust_ops:ws:<workspaceId>`), derived once via `graphKeyFor()` — never a raw client value.

---

## Federation

Each sibling app is reached through a small, uniform module:

```
*.port.ts     abstract class (DI token + interface) — consumers depend on THIS, never the client
*.client.ts   concrete: JSON-RPC over MCP (POST {BASE_URL}/mcp), brigade-sts or static bearer
*.module.ts   binds port → client; tests swap a fake port (no sibling app required)
```

The relationship layer depends only on the port, so federation is mockable and the transport is swappable. Each client is **degrade‑clean** (no `BASE_URL` → `isConfigured()` is false → returns empty, no call) and best‑effort (a failure logs + degrades, never throws).

### Auth: Brigade‑brokered, workspace‑scoped tokens

Customer‑Ops calls a sibling **as a service**, not as a user. In `brigade-sts` mode the `BrigadeTokenSource`:

1. mints a **client‑credentials** token from Keycloak for the `customer-ops` client (with an app‑specific scope), then
2. **exchanges** it at the Brigade broker (RFC‑8693) for a short‑lived token addressed to the target (`aud=<app>`) and bound to the workspace (`workspace_id` claim).

The bearer is never a shared static secret; the actor (`customer-ops`) rides in the `act` chain, so every cross‑app call is auditable.

### Onboarding a new seam — the four layers

Wiring Customer‑Ops to consume a sibling app touches **four** independent layers. Missing any one fails the call; the symptom tells you which:

| # | Layer | Where | Symptom if missing |
|---|---|---|---|
| 1 | **Keycloak client scope** | `customer-ops` client in the `uchub` realm has the seam's scope (`<app>:read`) as an optional client scope | CC mint → `400 invalid_scope` (no bearer) |
| 2 | **Broker audience allow‑list** | `BRIGADE_EXCHANGE_ALLOWED_AUDIENCES` includes `<app>` (prod broker) | token exchange refused |
| 3 | **Resource app's actor allow‑list** | the sibling permits `customer-ops` as a federation actor | sibling `403` (actor) |
| 4 | **Resource app's principal membership** | the sibling has a membership for the synthetic principal **`federation:customer-ops`** in its own workspace | sibling `403` "no workspace access" |

Two things bite here, both learned the hard way:

- **The principal is the actor, not the sub.** A federation token's resolved principal is built from the *actor* (`buildFederationPrincipal('customer-ops')` → a synthetic user `id = 'federation:customer-ops'`, `keycloakId = null`). The sibling's membership must be keyed `federation:customer-ops` — **not** the human service‑account UUID.
- **Each app has its own canonical workspace id.** `CONTACT/MEETING/PROJECT_OPS_WORKSPACE_OVERRIDE` differ per app; the client maps Customer‑Ops's local workspace to the id the sibling recognizes, on both the exchange claim and the `X-Workspace-Id` hint (the sibling re‑gates server‑side regardless).

For the sibling to even *accept* the token it must trust the broker's signing key (`BRIGADE_TRUSTED_ISSUERS`) and expect `aud=<itself>`. A sibling with no federation‑actor handling at all will run the token through its human SSO path and reject it — that app needs to adopt the pattern (see `auth.service.ts buildFederationPrincipal` + `federation-actor.guard.ts` as the reference).

### Observability: `/health/integrations`

`GET /api/v1/health/integrations` probes every seam with a side‑effect‑free `tools/list` and reports `{ seam, configured, ok, status, detail, latencyMs }`. This is the antidote to silent federation failure — a `401`/`403` behind a degrade‑clean empty panel is otherwise invisible. It's unauthenticated (status only, no data) and belongs in every consuming app.

---

## The knowledge graph

`GraphService` holds the injection‑safe write primitives (label/edge‑type are typed constants; all values are Cypher params) and the read surface. `GraphIngestService` projects the relationship world onto the graph:

- **Vocabulary:** nodes `Person · Org · Deal · Meeting · Invoice · Email · Campaign · LeadSource · Hub`; typed, time‑weighted edges (`IS_CONTACT · OWNS_DEAL · WORKS_AT · ATTENDED · BILLED_FOR · EMAILED · ENROLLED_IN · SOURCED_FROM · REFERRED_BY`).
- **Local skeleton first, federation enriches.** The relationship skeleton (Person/Org/Deal + edges) is always written from local DB truth; each federated source then enriches it inside its own try/catch — a source being down never leaves a half‑written graph.
- **Idempotent (all `MERGE`).** A full `POST /graph/reindex` and a single‑customer upsert converge to the same graph; no dupes.
- **Stays current.** Every relationship write (`create / update / transition / markLost / reopen`) fires a **post‑commit, fire‑and‑forget `upsertCustomer`** hook, so the graph tracks the live state without a nightly rebuild. Deals read as `"<contact> · <STAGE>"`; name‑only (`prov:`) imports are labeled from the lead‑intake buffer.

---

## The relationship agents

The agents (`lead-triage`, `next-best-action`, `meeting-prep`, `follow-up-drafter`, `collections-nudge`) live in `agents/` and reuse the exact relationship logic an HTTP caller hits. Two design points:

- **Selectable lane.** Each call resolves a tier — `request ?tier=` / body > per‑agent `AGENT_<NAME>_TIER` env > `bundled`. `bundled` → local `qwen3.6-35b-a3b` (thinking off); `metered` → frontier `claude-sonnet-4.6`. A live A/B found no‑think Qwen matches Claude for these tasks after light prompt calibration, so the default lane is local, private, and free.
- **Propose, don't act.** Agents return drafts/recommendations; anything side‑effectful requires a person in the loop. Inference is metered (Lago) and runs through the LiteLLM gateway.

---

## Conventions worth knowing

- **The MCP server** exposes the same `CustomersService` the REST API uses — one implementation, several surfaces.
- **CPU‑capped builds** on inference hosts: build with the legacy builder (`DOCKER_BUILDKIT=0 docker build --cpu-quota=600000 --cpu-period=100000 …`) so a rebuild never steals GPU‑inference CPU.
- **`prov:` contact ids** are local provisional placeholders for name‑only imports (no Contact‑Ops record yet); clients skip resolving them and the graph/cockpit label them from the lead‑intake buffer.
- **Money** is always a decimal string end‑to‑end — never coerced to a float.

---

*See the [runbooks](runbooks/) for deploy, backup/restore, tenancy activation, inference, and entitlement enforcement.*

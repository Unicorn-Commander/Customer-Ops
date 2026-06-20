# Customer‑Ops — Backend

NestJS 10 + Prisma 5 + Postgres 17 API **and** MCP server for the Customer‑Ops
relationship cockpit. The same relationship logic serves an HTTP caller and an
MCP agent. Tenancy follows the Project‑Ops pattern (the suite reference impl).

For the product overview, federation model, graph, and quickstart see the root
[`README.md`](../README.md) and [`docs/`](../docs/). This file is the
backend‑specific orientation + the dev/test/migrate commands.

## What the backend ships

- **The relationship cockpit** — the funnel (Lead → Prospect → Customer),
  the pipeline board, and the **customer‑360** that assembles the local
  relationship plus the live federated panels (`src/customers/`, `src/overview/`).
- **Six federation seams** — Contact‑Ops, Accounting‑Ops, Outreach, Email‑Ops,
  Meeting‑Ops, Project‑Ops. Each is a mockable port, Brigade‑authenticated, and
  **degrade‑clean** (unconfigured/unreachable → renders "connect", makes no call):
  `src/{contact,accounting,outreach,email,meeting,project}-ops/`.
- **Five relationship agents** — `lead-triage`, `follow-up-drafter`,
  `collections-nudge`, `next-best-action`, `meeting-prep`. DRAFT‑ONLY +
  human‑in‑the‑loop (they assess or draft; they never auto‑send, post an invoice,
  or move a stage), on a selectable local/frontier inference lane
  (`src/agents/`, `src/relations-officer/`).
- **Lead intake** — the durable, idempotent `ingest_lead` front door + the
  intake observability surface (`src/lead-intake/`).
- **The knowledge graph** — a per‑workspace FalkorDB property graph kept current
  by a post‑commit incremental refresh (`src/graph/`).
- **An append‑only audit trail** — every relationship write and agent run is
  recorded to `audit_logs` across both REST and MCP (`src/audit/`).
- **Personal Access Tokens** (`co_pat_`) — minted/listed/revoked from a
  session‑only route, with **enforced** scopes and a single‑workspace binding
  (`src/auth/pat/`).
- **The MCP server** — ~23 tools (the same relationship/lead/agent operations an
  HTTP caller hits), each gated for a PAT caller (`src/mcp/`).
- **Health** — liveness/readiness plus `GET /health/integrations`, a per‑seam
  probe (`ok` / `auth-error` / `unreachable` / `not-configured`) (`src/health/`).

## Architecture (the load‑bearing pieces)

| Concern | File |
|---|---|
| Tenancy models + thin `Customer` relationship projection | `prisma/schema.prisma` |
| Schema + RLS + FORCE + role split + GUC + bootstrap (Prisma Migrate, not `db push`) | `prisma/migrations/*` |
| GUC chokepoint `withWorkspace()` / `runInWorkspace()` | `src/prisma/prisma.service.ts`, `src/common/workspace/` |
| Membership gate (403 without membership; JIT seed) | `src/common/workspace/membership.service.ts` |
| Keycloak SSO + local HS256 session (aud=customer-ops; algorithm allow‑list) | `src/auth/strategies/jwt.strategy.ts` |
| SSO access list + signup‑mode JIT gate | `src/auth/access-list.ts`, `src/common/workspace/feature-flags.ts` |
| Personal Access Tokens (`co_pat_`) + scope constants/map | `src/auth/pat/`, `src/auth/pat/pat.constants.ts` |
| REST scope enforcement (deny‑by‑default) | `src/auth/decorators/require-scopes.decorator.ts`, `src/auth/guards/jwt-auth.guard.ts` |
| MCP per‑tool scope + workspace gate | `src/mcp/mcp-access.ts` |
| Shared Brigade token source (RFC‑8693 exchange + cache) | `src/common/federation/` |
| Federation seams (mockable ports; degrade‑clean) | `src/{contact,accounting,outreach,email,meeting,project}-ops/` |
| Relationship agents + inference lane | `src/agents/`, `src/relations-officer/` |
| Lead intake (`ingest_lead`) | `src/lead-intake/` |
| Knowledge graph (ingest · read · health) | `src/graph/` |
| Append‑only audit trail | `src/audit/` |
| MCP server | `src/mcp/` |
| Health · readiness · `/health/integrations` | `src/health/` |

## Security & tenancy (live)

Multi‑tenancy is **enforced at the database**. RLS is `ENABLE`d + `FORCE`d on
every scoped table behind a `current_workspace_id()` GUC chokepoint, and the
runtime connects as the `customer_ops_app` role, which is **`NOBYPASSRLS`** — a
query with no workspace GUC fails closed. Migrations run as the owner role
(`ADMIN_DATABASE_URL`); the app runtime never uses it.

Cross‑app federation carries a short‑lived, workspace‑scoped, audience‑bound
token minted via Brigade (RFC‑8693), never a shared static secret.

Personal Access Tokens are least‑privilege: REST is deny‑by‑default (a PAT can
only reach a route that declares its scope via `@RequireScopes(...)` and holds
it), and each MCP tool is gated against `MCP_TOOL_SCOPE_MAP` with a workspace
fence on the JSON‑RPC `workspace_id` arg (`write:*` implies the matching
`read:*`). A PAT cannot mint or revoke a PAT.

## Develop

```bash
npm install
cp ../deploy/.env.example .env   # then trim to backend vars; set DATABASE_URL, JWT_SECRET, KEYCLOAK_*
npm run prisma:generate
npm run prisma:deploy            # apply schema + RLS migrations (prisma migrate deploy)
npm run start:dev                # http://localhost:3211/api/v1
```

In dev, `npm run prisma:migrate` (`prisma migrate dev`) creates/applies a new
migration from a schema change.

## Test & verify

```bash
npm run build                    # nest build
npx tsc --noEmit                 # typecheck
npm run prisma:deploy            # all migrations on a clean PG17
npm test                         # jest (membership gate, RLS, PAT, MCP gate, federation ports, …)
```

The RLS integration tests connect AS the `customer_ops_app` (NOBYPASSRLS) and
owner roles; point them with `CUSTOMER_OPS_RLS_TEST_DATABASE_URL` (app role) and
`CUSTOMER_OPS_RLS_OWNER_DATABASE_URL` (owner role).

RLS acceptance (run AS the NOBYPASSRLS `customer_ops_app` role):

```sql
-- no-GUC query returns 0 rows (fail-closed under FORCE RLS)
SELECT count(*) FROM customers;                                       -- => 0
-- the runtime role cannot bypass RLS
SELECT rolbypassrls FROM pg_roles WHERE rolname='customer_ops_app';   -- => f
-- RLS enabled + forced on a scoped table
SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='customers'; -- => t, t
```

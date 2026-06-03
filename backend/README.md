# Customer-Ops — Backend

NestJS 10 + Prisma 5 + Postgres 17 API for the Customer-Ops relationship / funnel
cockpit. Mirrors the Project-Ops tenancy pattern (the suite reference impl).

**Phase 1 scope:** the tenancy FOUNDATION — the `Workspace`+`Membership` boundary
(SUITE-IDENTITY §2 verbatim), a thin `Customer` relationship projection
(`contactId` + `stage` lead/prospect/customer + `workspaceId`), Keycloak SSO,
RLS + the 4-role split, the GUC chokepoint, and a minimal MCP server
(`health` + `list_my_workspaces`). The CRM cockpit + Contact-Ops/AO/Outreach
federation seams are Phase 2+.

## Architecture (the load-bearing pieces)

| Concern | File |
|---|---|
| Tenancy models (verbatim §2) + thin `Customer` projection | `prisma/schema.prisma` |
| Schema migration (Prisma Migrate, not `db push`) | `prisma/migrations/*_suite_tenancy_foundation` |
| RLS + FORCE + 4-role split + GUC + HIPAA ratchet + bootstrap | `prisma/migrations/*_suite_tenancy_rls_roles` |
| GUC chokepoint `withWorkspace()` | `src/prisma/prisma.service.ts` |
| Membership gate (403 without membership; JIT seed) | `src/common/workspace/membership.service.ts` |
| App-layer workspace resolver | `src/common/workspace/workspace-context.service.ts` |
| Tenancy flag (default current behavior) | `src/common/workspace/feature-flags.ts` (`CUSTOMER_OPS_TENANCY_ENABLED`) |
| Keycloak JWT (resolve by sub/keycloakId; aud=customer-ops) | `src/auth/strategies/jwt.strategy.ts` |
| SSO access list (JIT gate, §D5) | `src/auth/access-list.ts` |
| MCP server skeleton | `src/mcp/*` |
| Federation seams (mockable ports; degrade-clean) — contacts / AR / outreach / mail | `src/contact-ops/`, `src/accounting-ops/`, `src/outreach-ops/`, `src/email-ops/` |
| **Phase 5** Meeting-Ops signal seam (federated meetings/summaries/action-items; read-only, no local table) | `src/meeting-ops/` |
| **Phase 5** 4-lane agent-inference port (ops-center routing/metering; entitlement-gated; mockable; degrade-clean) | `src/agents/inference/` |
| **Phase 5** relationship agents (lead-triage / follow-up drafter / collections nudge) — DRAFT-ONLY, compose the federation ports + inference, log `AGENT_RUN` | `src/agents/` |

**Phase 5 scope (this layer):** the Meeting-Ops signal seam (federated, never
copied — fills the customer-360 meeting slot) + the three relationship agents on
the 4-lane inference. The agents are DRAFT-ONLY + human-in-the-loop: they return an
assessment or a draft for approval and NEVER auto-send, post an invoice, or move a
stage. Exposed as MCP tools (`triage_customer`, `draft_followup`,
`draft_collections_nudge`, `list_customer_meetings`) + cockpit actions. Phase 5
adds NO new scoped table — the only DB change is the additive `AGENT_RUN`
`CustomerActivityKind` (agent runs log into the already-RLS-fenced
`customer_activities`).

## Rollout posture

Every flag defaults to **current behavior** (SUITE-IDENTITY quality bar). RLS is
created + FORCED by the migration but **inert** for the running app, because the
runtime connects as the object owner (BYPASSRLS). The fence goes live in a later
phase by (a) pointing `DATABASE_URL` at the NOBYPASSRLS `customer_ops_app` role
and (b) setting `CUSTOMER_OPS_TENANCY_ENABLED=true`. The migrations are additive.

## Develop

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL, JWT_SECRET, KEYCLOAK_*
npx prisma generate
npx prisma migrate deploy     # apply schema + RLS migrations
npm run start:dev             # http://localhost:3211/api/v1
```

## Verify (what Phase 1 was signed off against)

```bash
export DATABASE_URL=postgresql://localhost:5432/customer_ops
npm run build                 # nest build
npx tsc --noEmit              # typecheck
npx prisma migrate deploy     # both migrations
npx jest                      # foundation tests (membership gate, withWorkspace, ...)
```

RLS acceptance (run AS the NOBYPASSRLS `customer_ops_app` role; password
`verify_app` on the verify DB):

```sql
-- no-GUC query returns 0 rows (fail-closed under FORCE RLS)
SELECT count(*) FROM customers;                                   -- => 0
-- the runtime role cannot bypass RLS
SELECT rolbypassrls FROM pg_roles WHERE rolname='customer_ops_app';  -- => f
-- RLS enabled + forced on the scoped table
SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='customers'; -- => t, t
```

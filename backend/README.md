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

# Customer-Ops — Phase 1 Foundation

Implementation record for the tenancy foundation. Built against the binding
contract in [`SUITE-IDENTITY.md`](./SUITE-IDENTITY.md), copying the proven
Project-Ops `feat/suite-tenancy-foundation` pattern.

## What Phase 1 ships

**Backend (NestJS 10 / Prisma 5 / Postgres 17)**

- **Tenancy models** — `Workspace` + `Membership` + `WorkspaceRole` +
  `MembershipStatus` **verbatim** from SUITE-IDENTITY §2 (no `@default` on
  `Workspace.id`; Customer-Ops never mints `workspace_id`).
- **Thin relationship projection** — `Customer` (`workspaceId` + federated
  `contactId` + `stage` LEAD/PROSPECT/CUSTOMER + `source`/`notes`), tenant-scoped,
  `@@unique([workspaceId, contactId])`. It holds the relationship/lifecycle ONLY;
  it never copies the Contact-Ops contact record (README golden rule).
- **Identity** — `User` (SSO-linked, `keycloakId` == uchub sub), NOT
  workspace-scoped (§2). JIT-provisioned on a valid token, gated by the access
  list; zero workspace access until a Membership exists (§D5).
- **Prisma Migrate** (not `db push`) — two versioned migrations: the schema
  foundation + the RLS/role/GUC/bootstrap migration.
- **RLS** — `ENABLE` + `FORCE` row-level security on the scoped table
  (`customers`) with `USING/WITH CHECK (workspaceId = current_workspace_id())`;
  the `current_workspace_id()` GUC reads `app.current_workspace`.
- **4-role split** — `customer_ops_owner` (BYPASSRLS, DDL) / `customer_ops_app`
  (runtime, **NOBYPASSRLS**) / `customer_ops_audit` (INSERT-only sink, reserved) /
  `customer_ops_ro` (read-only).
- **GUC chokepoint** — `PrismaService.withWorkspace(workspaceId, ucUid, fn)`
  opens a `$transaction`, `SET LOCAL`s both GUCs, runs the handler on `tx`.
- **HIPAA ratchet** — `hipaa_mode=true ⇒ isolation_mode=strict`, one-way at the
  DB (CHECK constraints + BEFORE UPDATE trigger), per §5.
- **Keycloak JWT auth** — multi-issuer strategy (local HS256 session, Keycloak
  realm RS256, Brigade federation RS256) with **`aud=customer-ops`** binding;
  resolves by `keycloakId`/`sub` first, membership-gated, 403 without membership.
- **Tenancy flag** — `CUSTOMER_OPS_TENANCY_ENABLED`, **default OFF == current
  behavior** (membership gate is a no-op, rows resolve to `DEFAULT_WORKSPACE_ID`,
  RLS inert because runtime is the owner).
- **MCP server skeleton** — Streamable HTTP at `/api/v1/mcp`, JWT-auth'd, with
  `health` + `list_my_workspaces` (identical shape to `GET /auth/me/workspaces`).

**Frontend (Next.js 15 App Router)**

- SSO sign-in (`/auth/login` → backend Keycloak entry → `/auth/sso-callback`).
- Empty authenticated dashboard shell (`/dashboard`) that lists the caller's
  membership-derived workspaces — proving the tenancy wiring end-to-end.

## Deliberately deferred to Phase 2+

- The relationship cockpit: contact 360, the pipeline/stage board, lead sourcing.
- **Federation seams** to Contact-Ops (resolve contacts), Accounting-Ops
  (`create_invoice_from_draft` / `get_invoice` poll), Outreach (Listmonk/Postiz),
  Email-Ops (Stalwart threads), Meeting-Ops (signal). The structure is left ready
  (the `Customer.contactId` reference is the seam) but NO cross-app data-plane
  calls are wired (per the brief: keep them inert until the Brigade RFC 8693
  spike proves out).
- The relationship agents (lead-triage, follow-up drafter, collections nudge).
- Personal Access Tokens (`co_pat_` prefix reserved in §D9) — a Phase-2 surface.
- An `audit_logs` table + the `customer_ops_audit` sink wiring (the role exists;
  the table lands with the cockpit).
- Flipping the runtime to `customer_ops_app` + `CUSTOMER_OPS_TENANCY_ENABLED=true`
  (the later rollout phase that makes the fence live), and the workspace-scoped
  REST surface under `/api/v1/workspaces/{workspace_id}/…`.

## Deviations from the Project-Ops reference (and why)

- **Greenfield, so no nullable→backfill dance.** PO retrofitted RLS onto 13
  existing models with live data, so it made `workspaceId` nullable then
  backfilled. Customer-Ops' single scoped table (`customers`) is born with a
  **NOT NULL** `workspaceId` — there is no legacy data, so the backfill step and
  the "inert-because-nullable" handling are unnecessary. The RLS is still created
  inert via the owner-connection posture (identical security ramp).
- **Canonical roles in the access list directly.** PO maps a legacy app
  `UserRole` (ADMIN/STAFF/…) to the suite `WorkspaceRole`. Customer-Ops is new,
  so its access list emits canonical suite roles
  (OWNER/ADMIN/MANAGER/MEMBER/VIEWER) directly; `suiteRoleForAccess` is an
  explicit pass-through seam (kept so the call site reads like the rest of the
  suite). Env var: `CUSTOMER_OPS_ACCESS_LIST`.
- **Leaner auth surface.** No local password / email / client-signup / PAT code
  (PO carries those for its client portal). Customer-Ops Phase 1 is SSO-only; the
  auth service is the Keycloak/Brigade JIT + session-mint core, nothing more.
- **Bootstrap workspace id tail `…c007`** (vs PO's `…b007`) so the two dogfood
  bootstrap workspaces never collide if they ever share a registry namespace.
- **MCP is a true skeleton** — only `health` + `list_my_workspaces`, not PO's
  full project/task/billing tool set (those map to the Phase-2 cockpit).

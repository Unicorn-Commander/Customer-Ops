# Changelog

All notable changes to Customer-Ops. Versions track the app milestone; the MCP
tool surface version (`mcp.service.ts`) tracks alongside.

## [0.11.1] — 2026-06-21 — "First-login seed fix"

### Fixed
- **Membership seeded at login.** On a fresh DB with tenancy ON, an allow‑listed
  user's bootstrap‑workspace membership was only created inside
  `resolveAndAuthorize` (workspace‑scoped routes); but the dashboard's first call
  after sign‑in is `GET /auth/me/workspaces` (a plain list, no seed), so the user
  landed on "no workspace membership yet" and never reached a seeding route.
  `validateKeycloakUser` now calls `ensureSeededMembership` at the end of login
  (idempotent, tenancy‑gated, a no‑op for self‑serve users who already hold a
  membership). Surfaced while standing up production at `unicorncommander.ai`.

## [0.11.0] — 2026-06-20 — "All federation rides Brigade"

Closes the last static‑token federation seam: Outreach now exchanges through
Unicorn Brigade (RFC‑8693) like every sibling, so cross‑app federation has a
single trust path.

### Added / Changed
- **Outreach → Brigade.** The Outreach client gains a selectable auth mode
  (`OUTREACH_AUTH_MODE: static | brigade-sts`, default `static`) mirroring the
  Contact/Accounting/Email/Meeting/Project‑Ops clients: in `brigade-sts` it mints
  a `customer-ops` client‑credentials token and exchanges it at Brigade for an
  `aud=outreach`, workspace‑bound bearer. Adds `OUTREACH_WORKSPACE_OVERRIDE`
  (maps the local workspace id to the canonical one) applied to BOTH the exchange
  claim and the body `workspace_id` arg so the token claim and the addressed
  tenant always match, plus an optional `OUTREACH_SCOPE`
  (default `outreach:read outreach:send`). Outreach was the last client without a
  Brigade path; **all six cross‑app seams now support `brigade-sts`.**
- Dormant until the Outreach app exists (`OUTREACH_BASE_URL` unset =
  degrade‑clean) — no live behavior change; the seam is now Brigade‑ready.

### Verified (dogfood, live)
- The five active seams (Contact/Accounting/Email/Meeting/Project‑Ops) run
  `brigade-sts`; the CC‑mint → RFC‑8693 exchange chain returns `200` end‑to‑end
  (`customer-ops` is an allowed Brigade actor for `aud=contact-ops`).
- Agent inference routes through the Ops‑Center gateway (`unicorn-litellm:4000`,
  no‑think Qwen3.6‑35B) and returns token usage for metering.
- Tests: +5 `brigade-sts` specs; full backend suite **467 green**, `tsc` clean.

## [0.10.0] — 2026-06-20 — "Workspace & Profile settings"

Turns the last two "Coming" settings cards into real surfaces.

### Added
- **Profile** (`Settings → Profile`): a view of your suite‑SSO identity — name,
  email, username, account status, member‑since, last sign‑in — plus the
  workspaces you belong to (role + default) and sign‑out. No edit form: identity
  is managed in suite SSO.
- **Workspace** (`Settings → Workspace`): the workspace identity (status, posture
  badges, member count) and the **member roster** (role, status, last sign‑in,
  with You/Service markers). An OWNER can change a member's role or remove them
  (focus‑trapped confirm); the backend enforces owner‑only + a **last‑owner
  lockout guard**, and every membership change is audited. Member mutations are
  session‑only (a PAT can't manage members); the roster read is `read:overview`.
  Inviting new members is an honest note (members join via suite SSO), not a fake
  form.
- New API: `GET /workspaces/:id`, `GET /workspaces/:id/members`,
  `PATCH`/`DELETE /workspaces/:id/members/:userKey`.

## [0.9.0] — 2026-06-20 — "Least-privilege + polish"

Locks the relationship surface to least‑privilege and hardens the edges. PATs
stop being advisory and start being **enforced**; the JWT verifier and the MCP
endpoint get the same treatment as the REST surface; and the customer‑360 gets a
performance pass.

### Added / Changed
- **PAT scope enforcement (was advisory).** REST is now **deny‑by‑default**: a
  PAT can only reach a route that declares its scope with `@RequireScopes(...)`
  and only if the token holds it — an un‑annotated route is PAT‑inaccessible. The
  MCP surface gets a **per‑tool scope gate** (`MCP_TOOL_SCOPE_MAP`, fail‑closed on
  an unmapped tool) plus a **workspace fence** on the JSON‑RPC `workspace_id` arg
  so a PAT bound to one workspace can't address another via the arg. `write:*`
  implies the matching `read:*`. A normal JWT session is unaffected (full RBAC).
- **JWT verifier hardening.** Explicit `algorithms` allow‑list (`HS256`, `RS256`
  only — closes the alg‑confusion vector) and **fail‑closed on an empty
  `JWT_SECRET`** (an unset secret can no longer accept any local HS256 token).
- **MCP endpoint rate‑limiting.** The `POST /mcp` surface is now throttled (was
  unthrottled).
- **Audit consistency for inbound engagement** — `record_customer_engagement`
  now records to the audit trail like every other relationship write, plus
  validation on the audit list query.
- **Customer‑360 performance.** Parallel federation fan‑out across the seams,
  bounded concurrency on the contact‑summary calls, and batched invoice‑cache
  writes.

## [0.8.0] — 2026-06-20 — "Audit + tokens"

Adds the two operator‑facing trust features: an append‑only system audit trail
and Personal Access Tokens for programmatic/agent access.

### Added
- **Append‑only system audit trail.** A new `audit_logs` table (migration
  `20260620000000_phase7_audit_logs`) records relationship writes and agent runs
  (an `EXECUTE` on `agent`) across **both REST and MCP**. The writer is
  RLS‑correct (routed through the workspace GUC) and never throws — auditing can't
  break the request it records. Surfaced in the cockpit as **System → Audit**.
- **Personal Access Tokens (`co_pat_`).** Mint / list / revoke from
  **session‑only** routes (`/api/v1/auth/pats/*`) — you cannot mint or revoke a
  PAT *with* a PAT. The plaintext is shown exactly **once** at creation. A token
  is bound to a single workspace and carries a set of scopes. Backed by migration
  `20260620010000_personal_access_tokens`. (Scope **enforcement** lands in
  [0.9.0].)
- **`GET /health/integrations`** — a per‑seam federation probe reporting `ok` /
  `auth-error` / `unreachable` / `not-configured` for every integration, so a
  silent auth failure can't hide behind an empty panel.

## [0.7.0] — 2026-06-05 — Federation live

The relationship cockpit goes from contract-coded seams to **live cross-app
federation**. Customer-Ops now centralizes lead identity in Contact-Ops and reads
conversation signal from Meeting-Ops, both over a Brigade-brokered, audience-bound
token chain.

### Added
- **`ingest_lead` keystone** — the durable, idempotent leadgen → Customer-Ops
  ingestion pipeline. `lead_intakes` RLS-fenced staging buffer (idempotent on
  `workspace+source+sourceDedupKey`); identity precedence explicit `contactId` →
  Contact-Ops upsert → deterministic provisional id; `LeadLabelResolver` renders
  provisional leads with real names while Contact-Ops is dormant; NO-DOWNGRADE
  rule. Exposed on REST (`…/workspaces/:ws/leads/*`) + 5 MCP tools (`ingest_lead`,
  `lead_intake_stats`, `list_lead_intakes`, `resolve_pending_leads`,
  `discard_lead_intake`).
- **Lead Ingestion cockpit screen** — observability + control surface (KPIs,
  per-source breakdown, resolve-pending, add-lead slide-over) in the `co-*` design
  system; live + preview routes.
- **Contact-Ops federation — LIVE.** `ContactOpsPort.upsertContact` write seam to
  CO's `upsert_person`; the brigade-sts auth chain (customer-ops client-credentials
  → Brigade RFC-8693 exchange → `aud=contact-ops` token). 13 dogfood leads upgraded
  from provisional to canonical CO person_ids.
- **Meeting-Ops federation — LIVE.** The customer-360 meeting panel reads
  contact-keyed meetings/summaries/action-items from Meeting-Ops'
  `/api/federation/mcp` (brigade-sts, `meetings:read`). Configurable MCP path.
- **Shared `BrigadeTokenSource`** (`common/federation`, `@Global`) — one
  implementation of the client-credentials mint + RFC-8693 exchange + per-(audience,
  workspace) token cache, reused by every federation client (no duplication as
  Accounting-Ops / Outreach / Email-Ops come online).
- Env knobs: `<APP>_AUTH_MODE` (`static`|`brigade-sts`), `<APP>_WORKSPACE_OVERRIDE`,
  `CONTACT_OPS_INGEST_TOOL`, `MEETING_OPS_MCP_PATH`, `LEAD_INTAKE_PROVISIONAL_IDENTITY`.

### Infrastructure (sibling apps, this milestone)
- **Brigade**: new RFC-8693 token-exchange endpoint (`POST /api/v1/federation/token`)
  — the app→app STS surface (Unicorn-Brigade PR #8).
- **Contact-Ops**: 5 fixes completing the never-exercised brigade ingest path
  (workspace_id over retired org_id, RLS tenant-bind, scope/role mapping) —
  Contact-Ops PR #2.

### Verified
- All migrations apply on a clean PG17; RLS proven on `lead_intakes`; full app
  boots with routes mounted + guarded; the live chains proven end-to-end
  (customer-ops → Brigade → Contact-Ops `upsert_person` created a real person;
  meet-backend logged `POST /api/federation/mcp 200` from the deployed app). 214
  backend tests green.

### Known gaps (post-0.7.0)
- Meeting panel empty until Meeting-Ops stamps participants with CO contact_ids.
- Single-workspace dogfood uses `*_WORKSPACE_OVERRIDE` to map onto CO's
  uc-registry tenant; proper fix is one shared uc-registry workspace id.
- Tenancy flag still off (`CUSTOMER_OPS_TENANCY_ENABLED=false`).
- Accounting-Ops / Outreach / Email-Ops federation awaits those apps' interfaces.

## [0.1.0–0.6.0] — Phases 1–6 foundation
Tenancy foundation (Workspace+Membership, RLS), the relationship cockpit
(funnel + customer-360 + pipeline), the world-class GUI (design system, 3D
knowledge graph, ⌘K), the Accounting-Ops / Outreach / Email-Ops / Meeting-Ops
federation ports (contract-coded), the relationship agents, branded SSO login,
and the dogfood deploy on `customer-ops.magicunicorn.dev`.

# Changelog

All notable changes to Customer-Ops. Versions track the app milestone; the MCP
tool surface version (`mcp.service.ts`) tracks alongside.

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

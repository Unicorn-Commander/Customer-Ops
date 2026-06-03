# Customer-Ops

The **relationship / funnel cockpit** of the Unicorn Commander suite. One place to run the whole customer lifecycle: source a lead, work it through outreach, qualify, convert, then manage the ongoing relationship — surfacing contacts, invoices, email, campaigns, and meeting signal in a single cockpit.

**Customer-Ops is a SURFACE, not an engine.** It owns the *relationship*; it federates everything else. It must never become a second contact store or a second invoicing engine. (See `Unicorn-Ecosystem/SUITE-ARCHITECTURE-MAP.md` for the whole suite picture, and `~/Documents/uc-suite-specs/SUITE-IDENTITY.md` for the binding identity/tenancy contract.)

> **Status:** greenfield. This README is the implementation hand-off. Quality bar: enterprise-grade, day one, no MVP. Every tenant boundary is DB-enforced (RLS), every flag defaults to current behavior.

---

## What it owns vs federates

| Concern | Own / Federate | Source of truth (repo / engine) |
|---|---|---|
| The customer relationship + **lifecycle stage** (lead→prospect→customer) + pipeline | **OWNS** | this repo (a thin projection keyed on `workspace_id` + `contactId`) |
| Contacts / orgs / enrichment / lead **sourcing** | Federate | **Contact-Ops** `/Volumes/Studio Storage/Development/Contact-Ops` (the canonical phonebook + data-intel; Northwind Leads folds in here) |
| Invoices / AR / payment status | Federate | **Accounting-Ops** `/Volumes/Studio Storage/Development/Accounting-Ops` (the one AR/invoicing engine) |
| Email campaigns + social | Federate | **Outreach** → Listmonk (email) + Postiz (social), Hostinger KVM2 on `unicorncommander.net` Headscale |
| Mailboxes / threads | Federate | **Email-Ops** → Stalwart mail server, Hostinger KVM2 (Headscale). Transactional out = Postmark |
| Conversation signal (meetings, action items) | Federate | **Meeting-Ops** (has an existing action-item → Project-Ops bridge) |
| Delivery / project / client portal (post-conversion) | Hand off to | **Project-Ops** `/Volumes/Studio Storage/Development/Project-Ops` |
| Identity / entitlements / agents / LLM | Consume | Control plane (Unicorn Commander): `uc-registry`, `uc-entitlements`, Brigade, uchub Keycloak |

**The golden rule:** a "lead" is just a contact in the ONE Contact-Ops phonebook at an early `stage`. Customer-Ops manages the *stage transitions and the pipeline view*; the contact record itself never moves or copies. Track `stage`, `source provenance`, and `consent` (Customer-Ops projection) so Outreach stays CAN-SPAM/GDPR-clean.

---

## Identity & tenancy (do this FIRST, it's binding)

Adopt the suite-canonical tenancy verbatim from `~/Documents/uc-suite-specs/SUITE-IDENTITY.md` (§2 Prisma block, §4 registry, §5 isolation, §6 GUC). The **Project-Ops foundation is your working reference implementation** — copy its pattern:
- Branch `feat/suite-tenancy-foundation` in `/Volumes/Studio Storage/Development/Project-Ops` (worktree at `_po-worktrees/suite-tenancy-foundation`).
- The step-by-step: `~/Documents/projectops-tenancy-dev-prompt.md`.

Net: `Workspace` + `Membership` (no `@default` on `Workspace.id`, minted by `uc-registry`), `workspaceId` on every scoped model, `ENABLE`+`FORCE` RLS with a `current_workspace_id()` GUC chokepoint, the `project_ops_app`-style non-owner `NOBYPASSRLS` runtime role, all gated behind a `*_TENANCY_ENABLED` flag.

## Federation seams (exact contracts)

- **Contact-Ops** — read/resolve contacts by `workspace_id`; subscribe to / drive `stage`. Use its MCP tools + the signed thin-projection endpoint. Do NOT copy contact records; hold only `contactId` + the relationship projection.
- **Accounting-Ops AR** — to bill: call AO MCP `create_invoice_from_draft(workspace_id, entity_id, external_source="customer-ops", external_ref, customer{contact_id,...}, line_items[], currency, due_date, ...)`, idempotent on `(workspace_id, external_source, external_ref)`. **No webhooks** — poll `get_invoice(external_source, external_ref)` for status. Money is `NUMERIC(20,4)` decimal strings. Entitlement: requires BOTH `customer-ops` AND `accounting-ops` in the bearer's `entitlements`; bootstrap env `UC_ENTITLEMENT_MODE=open`. (Contract detail: `~/Documents/uc-suite-specs/handoff-accounting-ops.md` + AO `app/ar/`.)
- **Outreach** — drive Listmonk (audience from Contact-Ops → campaign → send on its own domain) + Postiz (social). Replies/bounces flow back as `stage` changes.
- **Email-Ops** — surface Stalwart mailbox threads + the agent-inbox approval surface for outbound agent mail.
- **Meeting-Ops** — surface meetings/action-items on the customer; action items can become Project-Ops tasks.
- **Control plane** — `workspace_id` from `uc-registry` (consume, never mint); entitlement checks via `uc-entitlements` / the `entitlements` claim; agents via Brigade; SSO via uchub Keycloak (RS256, `aud=customer-ops`).

## The funnel (what the cockpit drives)

`source (Contact-Ops/Northwind) → lead → outreach (Outreach) → engage/qualify (+Meeting-Ops signal) → prospect → convert →` either **product** customer (control-plane mint + Lago entitlement) **or services** client (Project-Ops project + CLIENT-role portal) `→ deliver/bill (Project-Ops/AO)/retain`.

## Recommended stack

Match Project-Ops (it's the closest analog: a federation-heavy cockpit with a UI). NestJS 10 + Prisma 5 + Postgres 17 backend, Next.js 15 frontend, Keycloak SSO, MCP server for agents. Reuse PO's `Workspace`/`Membership`/RLS/`withWorkspace()` patterns wholesale.

## Suggested build order

1. **Tenancy foundation** (copy PO's, per SUITE-IDENTITY) + SSO + the MCP server skeleton.
2. **Contacts + relationship cockpit** — federate Contact-Ops; the contact 360 view + `stage`/pipeline.
3. **Invoicing surface** — the AO `create_invoice_from_draft` + `get_invoice` poll seam; "this customer's invoices" view.
4. **Outreach + Email surfaces** — Listmonk/Postiz campaigns + Stalwart threads.
5. **Meeting signal + the relationship agents** (lead-triage, follow-up drafter, collections nudge) on the 4-lane inference via ops-center.

## Key paths & references

- Suite map: `Unicorn-Ecosystem/SUITE-ARCHITECTURE-MAP.md`
- Binding identity contract + ADR + per-app hand-offs: `~/Documents/uc-suite-specs/` (`SUITE-IDENTITY.md`, `UC-Suite-Architecture-ADR.md`, `handoff-*.md`)
- Reference impl (tenancy): Project-Ops `feat/suite-tenancy-foundation`
- Control plane: `/Volumes/Studio Storage/Development/uc-ops-center` (`uc-registry`, `uc-entitlements`, `uc_entitlements_sdk`)
- Engines: Contact-Ops, Accounting-Ops (local repos above); Stalwart/Listmonk/Postiz (KVM2 on `unicorncommander.net` Headscale); Postmark (transactional out)
- Project tracking: Project-Ops project (see the suite tracking) — `P-00060` for the shared identity/tenancy foundation this builds on.

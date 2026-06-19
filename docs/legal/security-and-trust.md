> **DRAFT — NOT LEGAL ADVICE — REQUIRES REVIEW BY COUNSEL**
>
> This document describes Customer-Ops' security posture for prospects, customers,
> and their auditors. It is an engineering-authored draft. Every claim must be
> verified against the live deployment and reviewed by counsel and a qualified
> security reviewer before it is published or relied upon contractually. Where a
> control is *designed but not yet enforced in a given deployment* it is marked
> **[ROADMAP]** — do not represent a roadmap control as a live one.

# Customer-Ops — Security & Trust

**Last updated:** 2026-06-06
**Product version this describes:** v0.7.0 (relationship cockpit + live cross-app federation)
**Operator / data controller:** [LEGAL ENTITY NAME] ("[SHORT NAME]"), a [STATE OF INCORPORATION, e.g. South Carolina] [ENTITY TYPE, e.g. C corporation]
**Security contact:** [security@DOMAIN] · **Coordinated disclosure:** [security@DOMAIN] (see *Vulnerability disclosure* below)

---

## 1. What Customer-Ops is — and why that shrinks the attack surface

Customer-Ops is the **relationship / funnel cockpit** of the Unicorn Commander suite. It runs the customer lifecycle — source a lead, work it through outreach, qualify, convert, retain — in one surface.

The single most important security fact about Customer-Ops is architectural: **it is a surface, not an engine.** It deliberately does **not** become a second copy of your sensitive data:

| It does NOT… | …because that data lives in (the system-of-record) |
|---|---|
| Store the canonical contact record (name / email / phone / org) | **Contact-Ops** (the one phonebook) |
| Store invoices, ledger entries, balances, or payment instruments | **Accounting-Ops** (the one AR engine) |
| Store mailbox contents or message bodies | **Email-Ops** / Stalwart mail server |
| Run an email/social send engine or campaign list | **Outreach** (Listmonk / Postiz) |
| Store meeting transcripts, recordings, or summaries | **Meeting-Ops** |
| Run, host, route, or meter an AI model | The control-plane inference gateway (ops-center `uchub-litellm`) |

What Customer-Ops actually persists is a **thin relationship projection**: the lifecycle *stage* (lead → prospect → customer), pipeline value, owner assignment, a stage-change activity log, and **references** (the federated `contactId`, an external invoice/message ref) to records that live in the engines above. The detail is fetched **federated at read time** and is not retained.

> This is a security property, not just a design preference: a Customer-Ops database breach exposes pipeline metadata and references — not your contact database, not your invoices, not your mailbox, not meeting transcripts. The blast radius is intentionally small.

The one deliberate exception is the **lead-intake buffer** (`lead_intakes`): the ingestion front door legitimately holds raw inbound identity (display name / email / phone / org name) *until* that identity is centralized into Contact-Ops. It is RLS-fenced exactly like every other tenant table, and it exists to be resolved away, not to be a contact store. See *Data minimization* below and the Privacy Policy.

---

## 2. Tenant isolation — the moat

Customer-Ops is multi-tenant. A *workspace* (`workspace_id`, a `uuidv7` minted once by the control-plane registry — Customer-Ops never invents one) is the hard tenancy boundary. Isolation is enforced in the database, not merely in application code, so an application-layer bug cannot by itself cross a tenant boundary.

### 2.1 PostgreSQL Row-Level Security (RLS), `ENABLE` + `FORCE`

Every tenant-scoped table — `customers`, `customer_activities`, `customer_invoice_links`, `customer_outreach_links`, `customer_email_links`, and `lead_intakes` — has Row-Level Security **enabled and `FORCE`d** (so the policy applies even to the table owner). The policy predicate compares the row's denormalized `workspace_id` to a per-transaction GUC:

```
USING       (workspace_id = current_workspace_id())
WITH CHECK  (workspace_id = current_workspace_id())
```

`current_workspace_id()` reads the `app.current_workspace` session setting. Two consequences are load-bearing:

- A query with **no** workspace GUC set returns **zero rows** and can write **nothing** — the system *fails closed*, not open.
- A write that names a different workspace is rejected by the `WITH CHECK`. You cannot insert a row into another tenant.

### 2.2 The GUC chokepoint

The only sanctioned way to touch tenant data is `PrismaService.withWorkspace(workspaceId, ucUid, fn)`: it opens a transaction, `SET LOCAL`s both `app.current_workspace` (the tenant) and `app.uc_uid` (the acting user, for attribution), and runs the handler against that transaction. `SET LOCAL` means the binding is scoped to the transaction and cannot leak to the next request on a pooled connection.

### 2.3 The four-role split (least privilege at the database)

The database defines four distinct Postgres roles so the runtime can never bypass the fence:

| Role | Use | RLS bypass |
|---|---|---|
| `customer_ops_owner` | DDL / migrations only | **BYPASSRLS** (DDL must not be fenced) |
| `customer_ops_app` | the application runtime | **NOBYPASSRLS** (the fence is real) |
| `customer_ops_audit` | INSERT-only audit sink | NOBYPASSRLS |
| `customer_ops_ro` | read-only reporting | NOBYPASSRLS |

When the runtime connects as `customer_ops_app` (`NOBYPASSRLS`), RLS is **live and unbypassable** from the application path. The isolation property has been verified against a verification database via a direct `customer_ops_app` connection (the migration's A–D acceptance SQL).

> **[ROADMAP] Deployment note — honesty matters.** In the current v0.7.0 *dogfood* posture the runtime connects as the object owner and the master tenancy flag (`CUSTOMER_OPS_TENANCY_ENABLED`) is **off**, so RLS is *created-but-inert* (single-tenant operation). The fence is built, tested, and proven; it becomes live the moment the runtime `DATABASE_URL` is pointed at `customer_ops_app` and the flag is flipped. **Public multi-tenant SaaS launch requires that flip.** This document must not claim live multi-tenant RLS for a deployment where the flag is off — state the deployment's actual posture.

### 2.4 The membership gate

Even with a valid identity, a user has **zero** access to a workspace until an explicit `membership` row exists (user_key + workspace_id + role). A valid SSO token is just-in-time provisioned into a user record, but it grants nothing on its own. There is no "default access," and a federation token never auto-provisions membership.

---

## 3. Identity, authentication & SSO

- **Single sign-on via Keycloak** (the `uchub` realm). Customer-Ops does not store passwords for SSO users; authentication is delegated to the identity provider, which brokers upstream providers (e.g. Microsoft, Google) where configured.
- **The user key is the Keycloak `sub`** (a UUID), used consistently across the suite. Customer-Ops resolves the caller by `keycloakId`/`sub`.
- **Audience binding.** Customer-Ops accepts a token only if its audience is `customer-ops`. A token minted for another app (e.g. `aud=accounting-ops`) is rejected even when its signature and issuer verify — see §4.
- **Local sessions** issued after the OIDC callback are short-lived JWTs (`JWT_EXPIRES_IN`, default 1 day) signed with a per-deployment secret.
- **Role is re-derived locally.** After verifying any token, Customer-Ops derives the caller's role from its *own* membership table — it never trusts a role asserted by an inbound federation token.

---

## 4. Federation security — audience-bound, least-privilege, brokered

Customer-Ops reaches the other engines through a brokered, audience-bound token chain — never with a long-lived god credential, and never by holding another app's data.

- **Broker:** Brigade implements RFC 8693 (OAuth 2.0 Token Exchange). The shared `BrigadeTokenSource` (1) mints a Customer-Ops client-credentials *subject* token from Keycloak, then (2) exchanges it at Brigade for a token whose **audience is the specific target app** (`contact-ops`, `meeting-ops`, …) and which carries the addressed `workspace_id`.
- **Least privilege by scope intersection.** The exchanged token's authority is the intersection of the requested scopes and the subject token's scopes. The subject token is minted *per requested scope* and cached keyed by scope, so a meeting-read path cannot accidentally borrow contact-write authority — each federation path is cryptographically isolated to what it needs.
- **Per-(audience, workspace) cache.** Exchanged tokens are cached by `(audience, workspace_id)` so cross-tenant token reuse is impossible by construction.
- **Algorithm:** RS256 across the suite (manifest == verifier == deployed key). Inbound federation tokens are verified against the trusted issuer's JWKS (`<iss>/.well-known/jwks.json`) and must match the expected audience.

Net: a stolen Customer-Ops runtime credential does not yield standing access to Contact-Ops, Accounting-Ops, Email-Ops, or Meeting-Ops data — only the ability to request narrowly-scoped, audience-bound, workspace-bound exchanges that each target app independently re-authorizes against its own membership.

---

## 5. Data minimization & retention (security view)

- **Reference, don't copy.** Contact, invoice, mailbox, and meeting data is referenced and fetched at read time; it is not retained in Customer-Ops. Deleting or restricting a record at its system-of-record (e.g. Contact-Ops) removes it from the cockpit's view without a second deletion in Customer-Ops.
- **The lead-intake buffer is the one place raw PII lands**, and only transiently: it exists to be resolved into Contact-Ops, after which the row keeps its raw payload solely as an audit/replay trail and a provisional-label fallback. [ROADMAP] Operators should configure a retention/redaction job for resolved intake payloads — see the Privacy Policy and DPA for the contractual retention commitment and the [RETENTION PERIOD] placeholder.
- **Money as decimal.** Pipeline values are stored as `NUMERIC(20,4)` decimals (never floats), consistent with the suite money shape; Customer-Ops stores a *forecast* value only and posts no ledger entry.

---

## 6. Encryption

- **In transit.** All public endpoints are served over TLS (HTTPS); the reverse proxy (Traefik) terminates TLS. Service-to-service federation calls are HTTPS to each app's published base URL. *[Verify the live TLS configuration, minimum version, and HSTS before publishing specifics.]*
- **At rest.** [STATE THE TRUTH for the target deployment — e.g. volume-level / disk encryption on the host, and/or Postgres-level encryption. Do not assert at-rest encryption that is not actually configured.] Secrets (Keycloak client secret, JWT secret, DB passwords, service tokens) are supplied via environment and are never committed to source control.
- **Secrets handling.** This codebase references secrets by environment-variable **name** only; secret *values* are never logged, echoed, or committed. *(There is a known historical exception the operator is remediating — see §10 and the rotation runbook; this must be closed before launch.)*

---

## 7. Degrade-clean availability

Every external dependency **no-ops cleanly** when unconfigured. If a federated app's base URL is unset (or it is unreachable within its per-call timeout), the corresponding cockpit panel renders a "connect [App]" affordance and **makes no call** — it does not throw, and it does not block the rest of the cockpit. The AI agents likewise return an assembled-context "connect inference" result rather than failing when the inference gateway is unset. This means a single engine outage degrades one panel, not the whole product.

---

## 8. AI / agent processing

The relationship agents (lead-triage, follow-up drafter, collections nudge) assemble context from the federation seams and hand a prompt to the **control-plane inference gateway** (`uchub-litellm`), which selects the model lane and performs all metering. **Customer-Ops runs no model and meters nothing.** Agent output is **draft, advisory, and human-reviewed** — e.g. drafted outbound email is staged for explicit agent-inbox approval before any send. See the Acceptable Use Policy and Terms for the no-warranty-on-AI-output and human-in-the-loop commitments.

The default inference lanes are suite-bundled model groups. [DISCLOSE the actual model provider(s) the gateway routes to for your deployment — self-hosted vs. third-party — in the Privacy Policy subprocessor table; it is a material data-flow fact.]

---

## 9. Self-hostable deployment

Customer-Ops can be **self-hosted**. An operator who runs the suite on their own infrastructure controls where every byte lives — the database, the identity provider, the engines, and (when self-hosted) the inference gateway. In that posture, the only data leaving the operator's boundary is whatever they explicitly configure (e.g. a third-party model behind the gateway, or transactional email via Postmark). This is the strongest privacy posture and the recommended one for regulated data. [The HIPAA discussion below applies to self-hosted, BAA-covered deployments only.]

---

## 10. Vulnerability disclosure & incident response

- **Coordinated disclosure.** Report suspected vulnerabilities to [security@DOMAIN]. We ask for good-faith, non-destructive testing and reasonable time to remediate before public disclosure. [Define a safe-harbor statement and response SLA with counsel.]
- **Breach notification.** As a processor of customer contact data, the operator notifies affected customers of a personal-data breach **without undue delay** consistent with the Data Processing Addendum and applicable law (GDPR Art. 33/34; U.S. state breach-notification statutes). See the DPA for the contractual mechanics.
- **Known remediation item (pre-launch, must-close):** committed credential material exists in historical commits of one sibling app and is being rotated and purged; treat any historically-committed secret as compromised and rotate it. *(This is tracked operationally; it is listed here for transparency and must be closed before public launch. Confirm Customer-Ops' own history is clean.)*

---

## 11. Compliance posture (statements of intent — verify before relying)

- **GDPR / UK GDPR:** Customer-Ops is built to operate as a **processor** of customer-provided contact data (the customer is the controller). Data-subject-rights tooling, lawful-basis records, and international-transfer mechanics are addressed in the Privacy Policy and DPA. **[No certification is claimed.]**
- **CCPA/CPRA:** the operator acts as a **service provider**; it does not sell or share personal information as those terms are defined. See the Privacy Policy.
- **HIPAA:** PHI is **out of scope** for the standard multi-tenant offering. The suite supports a HIPAA posture (the `hipaa_mode` workspace flag ratchets `isolation_mode=strict` one-way at the database, and policy requires `isolation_tier ≥ premium` so PHI never co-resides with non-BAA tenants on RLS-only separation), but **PHI may be processed only under a signed Business Associate Agreement and the appropriate isolation tier.** Do not represent HIPAA compliance absent a BAA. **[No SOC 2 / ISO 27001 certification is claimed; remove this caveat only if and when an attestation exists.]**

---

*Companion documents: [Terms of Service](./terms-of-service.md) · [Privacy Policy](./privacy-policy.md) · [Data Processing Addendum](./data-processing-addendum.md) · [Acceptable Use Policy](./acceptable-use-policy.md).*

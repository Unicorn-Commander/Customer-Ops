# SUITE-IDENTITY.md

**Status: BINDING / NORMATIVE.** Ratified 2026-06-03. This is the single source of truth for the Unicorn Commander suite's identity, tenancy, entitlement-claim, isolation, GUC, and role atoms. Specs 1–5 reference this document **by inclusion**; they do not restate divergent versions. A change here ripples to every app — change it here first, never in an app.

**Scope:** Project-Ops (NestJS 10 / Prisma 5 / Postgres 17), Accounting-Ops (FastAPI / SQLAlchemy / schema-per-workspace), Contact-Ops (FastAPI / SQLAlchemy / single-schema RLS; canonical tree `/Volumes/Studio Storage/Development/Contact-Ops`), `uc-registry` + `uc-entitlements` (ops-center), Brigade STS, Keycloak `uchub` realm. Email-Ops / Outreach inherit this when built.

**Quality bar:** Enterprise-grade, day one. No MVP. Every flag defaults to current behavior; every migration is additive/reversible until its enforcing flag flips.

---

## 1. The atoms (frozen)

| Atom | Value | Notes |
|---|---|---|
| **User key** | uchub Keycloak `sub` (UUID) | `uc_uid` ≡ `sub` (strict alias). No client may emit a divergent `uc_uid` mapper. Called `user_key`. |
| **Workspace key** | `workspace_id` : **`uuidv7`** | Minted ONCE by `uc-registry` (§4). Lowercase canonical UUID. CO already mints `uuidv7`; AO's pre-existing `uuid4` ids are grandfathered (schema regex is version-agnostic). |
| **Entitlement claim** | flat `entitlements` array of SKU strings | `project-ops`, `accounting-ops`, `contact-ops`, `email-ops`, `outreach`. Read by AO's tolerant 3-shape reader (`entitlements`→`products`→`subscription.products`). `uc_ent` is the `uc-entitlements` **response object**, NEVER a token claim. |
| **Federation alg** | RS256 | manifest == verifier == deployed key, every app. |
| **Token workspace claim name** | `workspace_id` | `org_id` is **deprecated, not a fallback** (it means "tenant UUID" in CO but "CRM Organization" in PO's dead verifier — that split meaning dies). |

Every app also sets `app.uc_uid` = the acting user's `sub` for attribution.

---

## 2. Canonical Project-Ops Prisma block (verbatim — no `Tenant` model, no `@default` on `Workspace.id`)

```prisma
enum WorkspaceRole { VIEWER  MEMBER  MANAGER  ADMIN  OWNER }
enum MembershipStatus { ACTIVE  SUSPENDED  REVOKED }

/// Thin mirror of the uc-registry workspace record. PO NEVER mints workspace_id.
model Workspace {
  id                String   @id                    // == uc-registry workspace_id (uuidv7). NO @default.
  slug              String   @unique
  displayName       String
  parentWorkspaceId String?
  isolationMode     String   @default("standard")   // 'strict'|'standard'|'open'  (TEXT+CHECK, §5)
  isolationTier     String   @default("shared")     // 'shared'|'premium'|'enterprise'|'dedicated'
  hipaaMode         Boolean  @default(false)
  gdprMode          Boolean  @default(false)
  dataResidency     String?  @default("us-east")
  status            String   @default("active")     // active|suspended|archived|deleting
  entitlementCache  Json?                            // offline/dedicated only; null on shared SaaS
  syncedAt          DateTime @default(now())
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  memberships       Membership[]
  @@index([slug])
  @@index([status])
  @@map("workspaces")
}

model Membership {
  userKey      String                               // == User.keycloakId == uchub sub
  workspaceId  String
  role         WorkspaceRole    @default(MEMBER)
  status       MembershipStatus @default(ACTIVE)
  isDefault    Boolean          @default(false)
  createdAt    DateTime         @default(now())
  workspace    Workspace        @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  @@id([userKey, workspaceId])
  @@index([userKey])
  @@index([workspaceId])
  @@map("memberships")
}
```

Every other tenant-scoped PO model gets a nullable→NOT-NULL `workspaceId` (`Organization`, `Contact`, `OrganizationContact`, `Project`, `Task`, `Document`, `Comment`, `TaskComment`, `AuditLog`), composite hot-path indexes (`@@index([workspaceId, status])`, etc.), and `projectNumber` UNIQUE → `@@unique([workspaceId, projectNumber])`. `User` / `PersonalAccessToken` / `SystemConfig` / `EmailConfig` are NOT workspace-scoped. PO `Organization` stays the operator's **client**, never the tenancy boundary.

---

## 3. Membership logical shape (the cross-app contract every app conforms to)

```
membership(user_key text /* uchub sub */, workspace_id uuid, role text /* canonical suite role */,
           status text /* active|suspended|revoked */, is_default boolean,
           PRIMARY KEY (user_key, workspace_id))
```

- CO `user_tenant_membership` (`0035`) is the reference (key `user_uc_uid`). AO `workspace_membership` (`0001`) conforms after adding `status`+`is_default`. PO `Membership` (§2) keys `userKey`.
- Each app exposes `is_active_member(user_key, workspace_id) → bool`.
- **Contact-visibility membership** (CO `person_tenant_membership`, `organization_tenant_membership`) is NOT user-access membership — do not conflate.

---

## 4. Workspace registry ownership + minting

- **`uc-registry` on ops-center is the sole minter and system-of-record** for: workspace existence, the `uuidv7` `workspace_id`, coarse membership, `isolation_mode`, `isolation_tier`, `hipaa_mode`, `gdpr_mode`, `data_residency`, `status`.
- **Single mint API: `POST /workspaces`** (idempotent on a supplied UUID) → returns the canonical record. Any surface that creates a workspace calls this. **No app invents a `workspace_id`.** AO's `scripts/provision_workspace.py` stops calling `uuid.uuid4()` and instead receives the registry UUID, then computes `schema_for_workspace(workspace_id)`.
- **CO `public.tenants` and AO `public.workspace` are projections/mirrors**, keyed by the same UUID, holding their app-local infra columns. Mirrors are read-through, event-invalidated; the registry emits `workspace.created|updated|isolation_changed|suspended` on the Brigade bus. Until the bus ships, lazy-mirror via a signed `GET {registry}/workspaces/{id}` on first local-mirror miss.
- The registry UUID MUST satisfy AO `schema_for_workspace`, CO `current_tenant_id()`, and PO `current_workspace_id()` identically. `uuidv7` does (valid lowercase RFC-4122 UUID).

---

## 5. The two orthogonal isolation columns

Both live on the registry record and mirror to each app. Both **TEXT + CHECK** (never Postgres ENUM — so adding/reordering values is a cheap CHECK change, avoiding the one-way non-transactional `ALTER TYPE ... ADD VALUE` trap).

| Column | Axis | Values | Owner pattern | Ratchet |
|---|---|---|---|---|
| `isolation_mode` | **security fence** | `strict` \| `standard` \| `open` | Contact-Ops RESTRICTIVE fences | HIPAA→`strict`, one-way at DB |
| `isolation_tier` | **physical placement** | `shared` \| `premium` \| `enterprise` \| `dedicated` | Accounting-Ops pool/bridge/silo | monotonic promote only |

- **Default for every new workspace:** `isolation_mode=standard`, `isolation_tier=shared`.
- **Coupling rule (binding):** `hipaa_mode=true` ⇒ `isolation_mode=strict` (mandatory, DB-ratcheted) AND, as policy, `isolation_tier ≥ premium` (PHI never co-resides with non-BAA tenants on RLS-only separation).
- `isolation_mode` is the security floor; `isolation_tier` is the placement/pricing lever. Promotion (`shared→premium→enterprise→dedicated`) is monotonic and re-keys nothing — it swaps the physical mechanism behind the stable `workspace_id`.

---

## 6. GUC names (per app)

| App | GUC | Rationale |
|---|---|---|
| Accounting-Ops | `app.current_workspace` (+ `app.current_entity`) | already set by `set_workspace_search_path` |
| Contact-Ops | **`app.tenant_id`** (unchanged) | renaming breaks `0022`'s inline `current_setting('app.tenant_id')` literals; only the *wire claim* is `workspace_id` |
| Project-Ops | `app.current_workspace` (+ `app.uc_uid`) | new; matches AO's name |

---

## 7. Canonical suite role set + mapping

Rank order: `viewer < member < manager < admin < owner`.

| Suite role | CO `user_tenant_membership.role` | AO `workspace_membership.role` | PO `WorkspaceRole` |
|---|---|---|---|
| `viewer` | `viewer` | `viewer`, `client_user` | `VIEWER` |
| `member` | `member` | `bookkeeper` | `MEMBER` |
| `manager` | `manager` | `accountant`, `cpa` | `MANAGER` |
| `admin` | `admin` | `admin` | `ADMIN` |
| `owner` | (admin is CO's top) | `owner`, `client_owner` | `OWNER` |

- `platform_admin` (AO) is NOT a workspace role — it is a suite-global realm role honored as "cross-workspace operator," never on a membership row.
- AO keeps its 9-rank internal `_ROLE_RANK` and `entity_scope` unchanged; the canonical role is derived via this table when AO reports over MCP/federation.
- Each app implements `canonicalRole(appRole)→suiteRole` and `appRole(suiteRole)`; **Brigade speaks canonical roles.**

---

## 8. The binding decisions (D1–D10, condensed)

- **D1** — user key = uchub `sub`; `uc_uid ≡ sub`. Apps log loudly and use `sub` on any divergence.
- **D2** — workspace key = `uuidv7` `workspace_id`, minted by `uc-registry` (§4). Never propagate email/slug/org-name/raw KC-org-UUID as the cross-app key.
- **D3** — one workspace identity, app-local mechanism (bridge): AO schema-per-workspace; CO single-schema RLS (`app.tenant_id`); PO new single-schema RLS (`app.current_workspace`). No app rewrites its data layer.
- **D4** — per-request workspace addressing precedence: path `…/workspaces/{workspace_id}/…` → `X-Workspace-Id` → `workspace_id` claim.
- **D5** — JIT-provision the user row on any valid uchub token; **ZERO workspace access until an explicit membership row exists.** Allow-lists seed memberships; membership gates.
- **D6** — Brigade claim contract (RS256; `sub`, `workspace_id`, `scopes[]`, `act`, `aud`, `iss`, `entitlements`). Every app re-derives role from its OWN membership after verifying; no auto-provision from a Brigade token.
- **D7** — canonical role set + mapping (§7).
- **D8** — membership table contract (§3).
- **D9** — PATs stay app-local (prefixes `po_pat_`/`aops_pat_`/`co_pat_`). Local scope grammars are NOT forcibly unified; the cross-app interchange grammar is the coarse `ns:bucket`; each app publishes a `scope_map`. PAT workspace-scoping is mandatory.
- **D10** — compliance = the two columns (§5); `isolation_mode` enforced by each app's DB triggers reading its mirror; HIPAA→strict one-way at the DB.

---

## 9. Cross-app identity-equality acceptance tests (must pass)

1. A uchub token (`sub=U`, `workspace_id=W`) is accepted by all three apps; identity key = `U`; a `uc_uid ≠ sub` logs divergence and uses `sub`.
2. The same `workspace_id` (uuidv7) satisfies AO `schema_for_workspace`, CO `current_tenant_id()`, and PO `current_workspace_id()` identically, and one Brigade fixture token resolves to the same registry UUID in all three apps.
3. PO: a no-GUC request returns zero `projects`/`tasks` rows; `SELECT rolbypassrls FROM pg_roles WHERE rolname='project_ops_app'` ⇒ `f`.
4. A Brigade `aud=accounting-ops` token is rejected by PO and CO; each app re-derives role from its own membership; no auto-provision from a Brigade token.
5. `hipaa_mode=true` forces `isolation_mode=strict` and rejects any weakening UPDATE (DB ratchet) in CO and PO's mirror trigger.
6. A PO PAT with `workspaceScope=[W]` cannot act on `W2`.

---

*Companion: `UC-Suite-Architecture-ADR.md` (the full ADR + Specs 1–5). This file is Spec 1 §0 lifted to stand alone as the contract devs build against.*

# Runbook: flipping `UC_ENTITLEMENT_MODE=enforce`

**Status: OPERATIONAL.** Owner: platform. Audience: whoever flips the live flag (Aaron).
Companion to [`docs/SUITE-IDENTITY.md`](../SUITE-IDENTITY.md) §1 (the entitlement-claim atom).

Customer-Ops gates every cross-app federation call (agents, email, accounting,
outreach) on **verified entitlement SKUs read off the bearer token** — never an
HTTP header, never a local guess. `UC_ENTITLEMENT_MODE` chooses the posture:

| Mode | Behavior | When |
|---|---|---|
| `open` (bootstrap) | SKU check **bypassed**, every gate ALLOWs + logs a loud `WARN`. | Pre-Lago. The default-safe posture while the token does not yet carry SKUs. |
| `enforce` | SKU check **strict**: a gate ALLOWs only when the token carries the required SKU(s); otherwise it cleanly denies (no model call, no send) — degrade-clean, never a 500. | Once Lago → Keycloak emits SKUs into the token (per the contract below). |

> **The whole point of this runbook:** `enforce` is only safe to flip once the
> token **actually carries** the SKUs. Flip it before that and every gate denies
> every paying user — agents return "not entitled", email/AR/outreach 403. The
> code is already enforce-ready and degrade-clean; the gate is the *token claim*,
> so this runbook is mostly about the **claim contract** and **proving it lands**.

The Customer-Ops default is `enforce` (the code ships secure-by-default), so a
node that has not yet wired Lago→Keycloak SKUs **must explicitly set
`UC_ENTITLEMENT_MODE=open`** in its env until it has. The live dogfood node runs
`open` today. Do not flip it to `enforce` (or unset it) until every box below is
ticked for that node.

---

## 1. The SKU contract: Lago → Keycloak → token

A SKU is "real" to a Customer-Ops gate **only** when it rides on the
cryptographically-verified bearer token. Three hops have to be true:

```
 Lago (billing SoT)            Keycloak uchub realm                 the bearer token
 ─────────────────             ───────────────────                 ────────────────
 active subscription   ──▶     uc-entitlements resolves     ──▶    claim `entitlements`
 has plan/add-on               the user's active SKUs              = ["customer-ops", ...]
 → SKU code                    → emitted as a token claim          (verified by JwtStrategy)
```

### 1a. Where each SKU originates (Lago)

SKUs are Lago **plan codes / add-on codes** on the customer's active
subscription. The canonical suite SKU strings Customer-Ops gates on (these MUST
match the Lago codes exactly — see `SKU_*` consts in each federation client):

| SKU string | Lago origin | Gates it unlocks in Customer-Ops |
|---|---|---|
| `customer-ops` | the Customer-Ops seat/plan | **base** — required to run ANY agent (bundled lanes 1-2) and is half of every dual-SKU gate below |
| `ai-metered` | the metered-AI add-on | metered inference lanes 3-4 (frontier/metered-API drafts); absent ⇒ a metered request is **downgraded** to bundled, not denied |
| `email-ops` | the Email-Ops plan | sending/drafting outbound mail via Email-Ops (with `customer-ops`) |
| `accounting-ops` | the Accounting-Ops plan | the AR/invoice federation: poll status, push invoices (with `customer-ops`) |
| `outreach` | the Outreach plan | the outreach federation writes (with `customer-ops`) |

> Reads (list threads, view invoice status, view touches) are **viewer-level** and
> are NOT dual-SKU gated — only the *write/spend* affordances are. `customer-ops`
> alone is enough to read the cockpit.

### 1b. Where the claim is emitted (Keycloak)

`uc-entitlements` (ops-center) resolves the user's active SKUs from Lago and they
are emitted into the token as a **flat array claim**. Per **SUITE-IDENTITY §1 the
canonical claim name is `entitlements`** (an array of SKU strings):

```jsonc
// minimal verified token (claims that matter to the gate)
{
  "iss": "https://brigade.unicorncommander.ai",   // or the Keycloak realm
  "aud": "customer-ops",                            // audience-bound to THIS app
  "sub": "…uchub user UUID…",
  "workspace_id": "…uuidv7…",
  "entitlements": ["customer-ops", "ai-metered"]    // ← the SKU claim
}
```

This must be emitted on BOTH token paths Customer-Ops accepts:
- the **Keycloak realm** token (OIDC browser login / forwarded realm token) — via
  a realm/client **protocol mapper** that projects the resolved SKUs onto
  `entitlements`;
- the **Brigade federation** token (RFC-8693 exchange for service/agent calls) —
  Brigade must **carry the SKU claim through** the exchange (the minted token
  keeps the subject's entitlements). A Brigade token with `aud=customer-ops` but
  no `entitlements` claim will be DENIED by every gate under `enforce`.

> **`uc_ent` is NOT a token claim** (SUITE-IDENTITY §1): it is the
> `uc-entitlements` *response object*. Do not map `uc_ent` onto the token; map the
> flat SKU list onto `entitlements`.

### 1c. What Customer-Ops reads (the tolerant reader — no code change needed)

`JwtStrategy.readEntitlements()` (`backend/src/auth/strategies/jwt.strategy.ts`)
is the **single** place the claim is extracted; it stamps `user.__entitlements`,
which `entitlementsOf(user)` then feeds into every gate's context. It is tolerant
of how the claim lands so a mapper-name decision does not require a code change
(first non-empty wins, canonical first):

1. `entitlements` — **canonical** (SUITE-IDENTITY §1). Array OR space/comma string.
2. `uc_skus` — the suite-namespaced spelling, same two shapes.
3. `products` — alternate key (AO compatibility).
4. `entitlement` — singular fallback (a single-SKU mapper).
5. `subscription.products` / `subscription.entitlements` — nested.

Items may be plain strings or `{code|product|sku, active?}` objects (inactive
dropped). SKU **spelling** is also tolerated downstream (`customer_ops`,
`customerops`, `co` → `customer-ops`; `mail` → `email-ops`; `ai`/`metered-ai` →
`ai-metered`; etc. — the `SKU_ALIASES` maps in each client). **Prefer the
canonical `entitlements` + exact SKU strings**; the tolerance is a safety net, not
a license to emit a divergent shape.

An **absent / empty / malformed** claim ⇒ `[]` ⇒ under `enforce` the gate
**denies** (degrade-clean), under `open` it allows + WARNs.

---

## 2. Per-app pre-flip checklist (ALL must be true before `enforce`)

Run these against the **specific node** you intend to flip. Do not flip globally;
flip the dogfood node first, soak, then the customer node.

**Billing / claim plumbing (the prerequisite — owned by Lago/Keycloak, not this repo):**

- [ ] **Lago SKU codes exist** and match the canonical strings in §1a exactly
      (`customer-ops`, `ai-metered`, `email-ops`, `accounting-ops`, `outreach`).
- [ ] **uc-entitlements resolves** a known test user's active subscription to the
      expected SKU list.
- [ ] **Keycloak realm mapper** projects the SKU list onto the `entitlements`
      claim for the **realm** token (OIDC login path).
- [ ] **Brigade carries `entitlements` through** the RFC-8693 exchange for the
      **federation** token path (service/agent calls), with `aud=customer-ops`.
- [ ] **Every active paying workspace's user(s)** have the SKUs they pay for on
      their Lago subscription (a customer who pays for email but whose token will
      not carry `email-ops` will lose mail the moment you flip).

**Proof the claim actually lands (do NOT skip — this is the failure mode):**

- [ ] Mint/obtain a **real token** for a test user and decode it: confirm a
      non-empty `entitlements` (or tolerated) claim with `customer-ops` present.
      *(JWT payloads are not secret like a key is, but treat the token itself as a
      live credential — decode locally, never paste it anywhere.)*
- [ ] Hit a gated Customer-Ops endpoint with that token and confirm the
      **`entitled: true`** affordance comes back (e.g. the customer-360 invoice
      panel reports `entitled`, or an agent run returns `entitled: true`). This
      proves the §1c reader saw the claim end-to-end. The
      `entitlement-claim-flow.spec.ts` integration test pins this thread in CI;
      this step proves it on the live token shape.
- [ ] Confirm a token **without** `customer-ops` is cleanly **denied** (agent
      returns "not entitled", AR/email/outreach return the not-entitled
      affordance) — not a 500.

**App posture (Customer-Ops side — already true in code, verify env):**

- [ ] On the node being flipped, every federation seam either (a) has its base URL
      set AND is expected to enforce, or (b) is intentionally dormant (base URL
      unset ⇒ that seam degrades-clean regardless of mode — see §4).
- [ ] No env override is masking the suite var. `UC_ENTITLEMENT_MODE` wins for
      every gate; per-gate vars (`AGENT_INFERENCE_ENTITLEMENT_MODE`,
      `EMAIL_OPS_CROSS_APP_ENTITLEMENT_MODE`, `ACCOUNTING_OPS_…`, `OUTREACH_…`) are
      fallbacks only. Set the **suite var** so all gates move together; do not leave
      a stray per-gate `open` behind.

**The flip itself:**

- [ ] Set `UC_ENTITLEMENT_MODE=enforce` in the node's env, **redeploy/restart** the
      backend (env is read at startup), and re-run the two proof steps above
      against the live node.
- [ ] Watch logs for `entitlement gate is OPEN` WARNs — after the flip there should
      be **none**; their absence confirms enforce is active. A burst of "DENIED /
      not entitled" for a *paying* user means their token is missing a SKU → roll
      back (§3) and fix the claim, do not loosen the gate.

---

## 3. Rollback

`enforce` ⇄ `open` is a **single env var + restart**; nothing in the database or
schema changes, so rollback is instant and lossless.

1. Set `UC_ENTITLEMENT_MODE=open` on the affected node.
2. Redeploy/restart the Customer-Ops backend (the mode is read at startup).
3. Verify: the gated affordances allow again and the logs resume emitting the
   `entitlement gate is OPEN … set the mode to 'enforce' once Lago emits
   entitlements` WARN (its presence confirms `open` is active).
4. Root-cause the claim gap (almost always a missing Lago SKU, a Keycloak mapper
   not emitting `entitlements`, or Brigade dropping the claim in the exchange)
   **before** re-flipping. Re-run §2.

> Because every flag in the suite defaults to current behavior and every gate is
> degrade-clean, a botched flip degrades to "everyone denied" (annoying, visible,
> instantly reversible), **never** to "everyone allowed" or a crash. That is the
> intended safety property.

---

## 4. Reference: the gates and their config

All gates live in Customer-Ops and read `entitlementsOf(request.user)`:

| Gate | File | Requires (enforce) | Notes |
|---|---|---|---|
| Agents / inference | `agents/inference/agent-inference.client.ts` | `customer-ops`; `+ai-metered` for metered | metered → bundled **downgrade** (not deny) when `ai-metered` absent |
| Email-Ops | `email-ops/email-ops.client.ts` | `customer-ops` + `email-ops` | reads viewer-level (no dual SKU) |
| Accounting-Ops | `accounting-ops/accounting-ops.client.ts` | `customer-ops` + `accounting-ops` | reads viewer-level |
| Outreach-Ops | `outreach-ops/outreach-ops.client.ts` | `customer-ops` + `outreach` | reads viewer-level |

**Mode resolution (every gate):** `UC_ENTITLEMENT_MODE` (suite-wide) → per-gate
fallback var → default `enforce`. `"open"` (case-insensitive) ⇒ bootstrap; any
other value ⇒ strict.

**Degrade-clean vs. entitlement are independent.** A seam whose base URL is unset
(`AGENT_INFERENCE_BASE_URL`, `EMAIL_OPS_BASE_URL`, `ACCOUNTING_OPS_BASE_URL`,
`OUTREACH_OPS_BASE_URL`) is **dormant**: it returns a "connect X" affordance and
makes no call **regardless of mode** — flipping `enforce` cannot break a seam that
is not wired. Entitlement only gates a seam that IS configured.

**Claim extractor / context plumbing (do not fork — one chokepoint):**
- `auth/strategies/jwt.strategy.ts` → `readEntitlements()` (the tolerant claim
  reader) + `validate()` (stamps `user.__entitlements` off the **verified** token).
- `common/workspace/workspace.util.ts` → `entitlementsOf(user)` (reads it back).
- Each agent + `customers/customers.service.ts` build their federation context
  with `entitlements: entitlementsOf(user)`.
- CI proof: `agents/inference/entitlement-claim-flow.spec.ts` (claim → gate
  end-to-end), `auth/strategies/jwt.strategy.spec.ts` (the reader),
  `agents/inference/agent-inference.client.spec.ts` (the pure gate).

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

### 1d. The PAT lane (`co_pat_`) — no token, so a mint-time SKU snapshot

A **Personal Access Token** carries NO bearer token, hence no live `entitlements`
claim. Before this fix the auth chokepoint stamped `__workspaceClaim` + `__ucUid`
onto a PAT request but **not** `__entitlements`, so `entitlementsOf(user)` returned
`[]` and **every gated MCP action 403'd under `enforce` even for a paying user**
(agentic drafts, AR/email/outreach writes). That is the money bug this lane fixes.

How a PAT gets its SKUs now:

```
 mint (JWT-only route)                 auth chokepoint (per request)         gate
 ─────────────────────                 ────────────────────────────         ────
 session user's verified      ──▶      PAT.entitlements snapshot     ──▶     effective =
 __entitlements SNAPSHOTTED             stamped onto request.user             snapshot ∩ workspace
 onto PersonalAccessToken               .__entitlements                       (see §1e)
 .entitlements at create
```

- The snapshot is taken at **mint** from the minting session user's verified
  claim (the PAT create route is `@JwtOnly`, so the session token's SKUs are
  present) and frozen on the token row (`PersonalAccessToken.entitlements`).
- `JwtAuthGuard` stamps that snapshot onto `request.user.__entitlements` when it
  resolves a `co_pat_` bearer, so the SAME `entitlementsOf(user)` reader feeds the
  gates for a PAT exactly as for a JWT.
- **Snapshot staleness**: the snapshot column itself is frozen at mint, but it is
  no longer what the guard stamps. `PatService.findByPlaintext` re-intersects it
  with the bound workspace's **current** server-side entitlements on every request
  — see **§1f** for the precedence table and the exact revocation window. A
  pre-fix PAT (no snapshot, empty column) resolves to `[]` and stays **denied**
  under enforce until re-minted — secure-by-default, never over-grants.

### 1e. Binding entitlements to the acting (user, workspace)

The claim (JWT or PAT snapshot) is **per user**. A gate binds it to the workspace
being acted in by **intersecting** it with that workspace's server-side
entitlements before checking a SKU:

```
 effectiveEntitlements(user, workspaceId)
   = entitlementsOf(user)  ∩  Workspace.entitlementCache[workspaceId]
```

- `Workspace.entitlementCache` **null / no mirror row** ⇒ *no server-side source*
  ⇒ the claim stands unchanged (today's shared-SaaS default — the token is already
  minted for its `workspace_id`). Flipping enforce changes nothing here.
- `entitlementCache` **present** (offline/dedicated nodes, or once the mirror is
  populated) ⇒ it is authoritative: a caller whose token/PAT carries `customer-ops`
  from **another org** is denied it in a workspace whose cache lacks it — even
  though the raw claim has it. A present-but-empty `[]` cache denies everything.

This is resolved in ONE place —
`WorkspaceContextService.effectiveEntitlements(user, workspaceId)` — and every
gate call-site (`customers.service.ts` federation contexts, the relationship
agents, the relations-officer) consumes it in place of the bare
`entitlementsOf(user)`.

> **⚠️ KNOWN LIMIT — shared-SaaS cross-org enforcement is NOT closed here
> (task 29817abc).** On shared SaaS `Workspace.entitlementCache` is **null by
> design** (see the column comment in `schema.prisma`), so the bind takes the
> null branch and is a **no-op** — `intersectEntitlements(claim, null)` returns
> the claim unchanged. That is only safe **if Keycloak mints a token whose
> `entitlements` claim is already scoped to the token's `workspace_id`** (the
> token is then the per-`(user, workspace)` authority). If a token instead carries
> a user's **union of SKUs across every org they belong to**, a member of
> workspace W2 could exercise a `customer-ops` SKU that only their *other* org (W1)
> holds. This repo has **no server-side entitlements source** to close that gap:
> `entitlementCache` is read-only here (nothing in this repo writes it), and
> `uc-entitlements` lives in ops-center/Keycloak, not as a client Customer-Ops can
> call. We deliberately do **not** fail this branch closed, because on shared SaaS
> the cache is *always* null — denying there would deny **every paying user on
> every gate**.
>
> **To actually enforce cross-org on shared SaaS (product decision for Aaron),
> pick one:**
> 1. **Per-workspace Keycloak claim** — have `uc-entitlements` emit an
>    `entitlements` claim scoped to the token's `workspace_id` (not the user's
>    union). No code change here; the null-branch assumption above becomes a
>    guaranteed invariant. *Lowest-lift; recommended if the mapper can do it.*
> 2. **A server-side uc-entitlements source** — add a client that resolves a
>    workspace's active SKUs server-side and populate `Workspace.entitlementCache`
>    on shared SaaS. Then the branch stops being null and the intersection
>    enforces (identical to today's offline/dedicated behavior). *Higher-lift;
>    needs a new client + a sync path.*
>
> Until (1) or (2) lands, shared-SaaS cross-org rests on assumption (1)'s
> unverified form. Offline/dedicated nodes (populated `entitlementCache`) already
> enforce and are unaffected. Tracked as the `TODO(29817abc)` in
> `intersectEntitlements` (`backend/src/common/workspace/workspace.util.ts`).
>
> **UPDATE — option (2) now has a landing strip in-repo. THE GAP IS NOT CLOSED.**
> `workspace_entitlements` (see §1f) is the server-side, per-workspace mirror, and
> the consumer that reads it is wired and tested. **Nothing writes it**, and
> nothing writes `Workspace.entitlementCache` either, so on every shipping node
> the intersection still takes its "trust the claim" branch and this limit stands
> exactly as described above. The missing piece is the *producer*, which is a
> product decision outside this codebase — see the box at the top of §1f.

### 1f. The PAT lane's server-side entitlement source + the REVOCATION WINDOW

> ## ⚠️ READ THIS FIRST: THIS SECTION DESCRIBES GROUNDWORK, NOT ENFORCEMENT
>
> **On every deployable configuration of this repo today, nothing described below
> enforces anything.** That is not a caveat, it is the headline.
>
> `WorkspaceEntitlementsResolver` is the CONSUMER half of a server-side
> entitlement bind. The PRODUCER half does not exist:
>
> * **Nothing in this repo ever writes `Workspace.entitlementCache`.** It is
>   read-only here — an operator sets it by hand on an offline/dedicated node.
>   On shared SaaS it is documented as always NULL.
> * **Nothing in this repo ever writes `workspace_entitlements`.** The resolver
>   only refreshes that table from a 200 off the entitlements endpoint — and that
>   endpoint lookup is dormant unless BOTH `ENTITLEMENTS_ENDPOINT_URL` and
>   `ENTITLEMENTS_SERVICE_TOKEN` are set, which they are not on any node today.
>   There is no backfill job, no sync worker, no admin write path.
>
> So the resolver answers `{ skus: null, source: 'none' }` for every workspace,
> `intersectEntitlements` takes its "trust the claim" branch, and the PAT lane
> behaves exactly as it did before this work. **The revocation window on a
> shipping node is still "until the PAT is revoked or expires."**
>
> ### What is actually delivered here
>
> 1. The consumer path, wired end to end and tested, so that the day a producer
>    exists the bind enforces with no further code change.
> 2. A **fail-CLOSED** posture at every indeterminate point, so that turning a
>    producer on cannot fail open (see the precedence table, and especially
>    `source-unavailable`).
> 3. A mint that **refuses** rather than persisting a dead credential.
> 4. Honest boot logging about which lanes are live.
>
> ### The decision that is still owed (outside this codebase) — `TODO(29817abc)`
>
> Pick ONE and build it; until then this is inert:
>
> * **(a) uc-entitlements client.** Stand up / point at a service that answers
>   "what does workspace W hold", give Customer-Ops a service credential
>   (`ENTITLEMENTS_SERVICE_TOKEN`), and the resolver populates
>   `workspace_entitlements` itself on first use. Cost: a new service dependency
>   on the request path, plus credential rotation.
> * **(b) per-workspace Keycloak claim.** Have Keycloak emit an `entitlements`
>   claim already scoped to the token's `workspace_id`, making the token itself
>   the per-(user, workspace) authority. Cost: a Keycloak mapper change; also
>   fixes the JWT lane's cross-org limit in §1e, but does **nothing** for the PAT
>   lane, which has no token — a PAT would still need (a) or an operator pin.
>
> Do not let anyone read the rest of this section as "entitlements are enforced
> per workspace." They are not, yet.

A `co_pat_` bearer is **not a JWT**, so there is no token to forward to the suite
entitlements endpoint on the caller's behalf (`EntitlementsService.resolve()`
bails on `isRs256`). That means the mint-time snapshot is the **only** source on
the PAT lane, and it is authoritative *forever*: a SKU revoked at the authority
stays usable until the PAT itself is revoked or expired. **That is still true on
a shipping node** — see the box above.

The lane is now WIRED to resolve the PAT's **bound workspace** server-side on
every request and intersect it with the snapshot, so that once a source exists
the snapshot becomes a **floor that can only narrow**:

```
 PatService.findByPlaintext(co_pat_…)
   effective = PAT.entitlements (mint snapshot, already workspace-scoped)
                 ∩  WorkspaceEntitlementsResolver.skusFor(PAT.workspaceId)
   ↓
 JwtAuthGuard stamps `effective` (NOT the frozen column) onto __entitlements
```

**`WorkspaceEntitlementsResolver` precedence** (`backend/src/common/workspace/workspace-entitlements.resolver.ts`):

| # | source | result | meaning |
|---|---|---|---|
| 1 | `Workspace.entitlementCache` non-null | authoritative | the OPERATOR pin (offline/dedicated). Never clobbered by the resolver. |
| 2 | entitlements endpoint 200 | authoritative + refreshes the mirror | needs `ENTITLEMENTS_ENDPOINT_URL` **and** `ENTITLEMENTS_SERVICE_TOKEN` |
| 3 | `workspace_entitlements` row, unexpired | authoritative | survives restarts / endpoint blips |
| 4 | `workspace_entitlements` row, **past `expiresAt`** | **`[]` — FAIL CLOSED** | a source exists but is unreachable ⇒ indeterminate ⇒ deny, never a stale grant |
| 4b | endpoint **configured but unavailable** (non-2xx incl. 401/403/404, network error, timeout, unparseable body) **and no mirror row** | **`[]` — FAIL CLOSED** (`source-unavailable`) | a source exists, we just cannot read it ⇒ indeterminate ⇒ deny |
| 5 | no row, no pin, endpoint **unconfigured** | `null` — "no server-side source" | the claim / PAT snapshot stands (**this is the row every shipping node lands on**) |
| — | any DB / parse error | **`[]` — FAIL CLOSED** | deny; never widen on failure |

> **Row 4b is the one that used to be missing**, and its absence was a fail-OPEN.
> `EntitlementsService` collapsed "unconfigured" and "configured but 500/401/
> timeout" into the same `null`, so a broken endpoint fell through to row 5 —
> which means TRUST THE CLAIM. A one-second blip, or an expired service
> credential, silently disabled the entire bind. `lookupWorkspace` now returns a
> three-state `unconfigured | ok | unavailable` and only `unconfigured` may reach
> row 5. An unexpired mirror row still wins over `unavailable` (rows 3/4), because
> a persisted answer carries its own `expiresAt` and therefore cannot become an
> unbounded grant.

#### THE REVOCATION WINDOW (state this when anyone asks)

- **A server-side source is configured** (operator pin, endpoint, or a populated
  `workspace_entitlements` row): a revoked SKU stops working within
  **`WORKSPACE_ENTITLEMENTS_TTL_MS` — default 60 seconds** — of the authority
  reflecting the change. That is the resolver's in-process cache TTL *and* the
  `expiresAt` it stamps on the mirror row, so the two do not compound.
- **A source is configured but unreachable**: the lane **denies immediately** —
  either the mirror row is past `expiresAt` (row 4) or there is no mirror at all
  (row 4b). Under-enforcement is never traded for availability here, and a
  failure is never allowed to read as "no source".
- **NO server-side source is configured** (the shipping shared-SaaS default —
  no `entitlementCache`, no endpoint credential, no mirror row): the mint-time
  snapshot remains the only source and revocation is bounded **only by PAT
  revoke/expiry**. ⚠️ This is unchanged from before and is *not* something this
  repo can fix alone — populate `workspace_entitlements` (or `entitlementCache`)
  to get the 60 s window.

`invalidate(workspaceId)` on the resolver drops the cache for an immediate
refresh after an operator writes the pin by hand.

#### ⚠️ THE OUTAGE POSTURE — read this BEFORE you set `ENTITLEMENTS_ENDPOINT_URL`

The bullet above ("a source is configured but unreachable ⇒ deny immediately") is
correct fail-closed enforcement **and** a large availability change, and it only
starts biting the day someone wires the endpoint. Stated without euphemism:

> With `ENTITLEMENTS_ENDPOINT_URL` + `ENTITLEMENTS_SERVICE_TOKEN` set, an endpoint
> outage that outlasts the mirror's `expiresAt` **denies every user in every
> workspace on every gate**. A paying JWT user who held `customer-ops` resolves to
> `[]`, not to their claim.

That is the default, deliberately — an entitlement source you cannot reach is an
answer you do not have, and an unknown answer is a deny. But it is now a *named*
decision you can operate, not an emergent property:

| var | default | effect |
|---|---|---|
| `WORKSPACE_ENTITLEMENTS_OUTAGE_POSTURE` | `deny` | **`deny`** (default, fail-closed): indeterminate ⇒ `skus: []` ⇒ gates deny. **`trust-claim`** (opt-in, **fail-OPEN**): indeterminate ⇒ `skus: null` ⇒ the caller's token claim / PAT snapshot is honoured, i.e. the pre-server-side-lane behaviour. Choose `trust-claim` only if you would rather serve an unenforced request than a 403 during an upstream outage — a broken service credential then silently restores full trust. An unrecognised value falls back to `deny`. |
| `WORKSPACE_ENTITLEMENTS_FAILURE_TTL_MS` | `1000` | how long an **indeterminate** answer is cached. Kept separate from the 60 s success TTL on purpose: caching a failure at the success TTL turned a 1-second endpoint blip into a 60-second denial that outlived the recovery. `0` = never serve a failed answer from cache (every request retries; each retry costs an `ENTITLEMENTS_TIMEOUT_MS` wait during a hard outage). |

`trust-claim` governs **request-time gating only**. PAT *minting* still refuses
(`503`) on an indeterminate answer under either posture — see the mint section
below; never bake an outage into a credential.

**Diagnosing an outage in seconds, not hours.** The resolver logs the moment it
starts serving degraded answers, and again when it stops:

```bash
docker logs customer-ops-backend 2>&1 | grep ENTITLEMENTS-SOURCE-DEGRADED
docker logs customer-ops-backend 2>&1 | grep ENTITLEMENTS-SOURCE-RECOVERED
```

The `DEGRADED` line is `ERROR` level and carries `source=`, `posture=`,
`endpointConfigured=`, `workspaceLookupConfigured=` and `degradedForMs=`. It is
emitted on the transition and re-emitted at most once a minute while degraded, so
it is loud without drowning the log. If you see a wave of 403s, grep that marker
first — it distinguishes "the entitlement source is down" from "this org really
lacks the SKU".

#### Request volume: ONE resolve per workspace per REQUEST

`WORKSPACE_ENTITLEMENTS_JWT_TTL_MS` defaults to `0` (no cache) so an operator pin
edit lands on the very next request. On its own that multiplied badly:
`WorkspaceContextService.effectiveEntitlements` has ~12 production call sites
(`customers.service` ×5, the five relationship agents, the relations officer, the
PAT chokepoint), so one inbound API request became a dozen outbound endpoint
fetches — each with a 5 s timeout — and a dozen `workspace_entitlements` UPSERTs.

The resolver therefore memoises per **request**, not per interval
(`common/workspace/entitlement-request-scope.ts`, an `AsyncLocalStorage` opened by
`RequestContextMiddleware`, which already runs before guards on every route):
the first call for a workspace reads the source, every later call in that request
reuses the same in-flight promise, and the next request starts empty. Freshness
and request volume are both fixed; **do not raise
`WORKSPACE_ENTITLEMENTS_JWT_TTL_MS` to "fix" load** — that only buys staleness.
Pinned by `workspace-entitlements.hardening.spec.ts` (N call sites in one request
⇒ exactly one fetch; a second request re-fetches).

#### The mint snapshot is now workspace-scoped — and a mint FAILS LOUDLY

`PatService.create()` snapshots `sessionClaim ∩ serverSide(workspaceId)` instead
of the raw session claim. The session claim is the user's **union across every
org they belong to**; snapshotting it raw let a PAT bound to workspace B carry a
SKU only workspace A bought. Pure narrowing — a mint can never grant more than
before.

**If the resolver cannot give a current answer at mint time, the mint returns
`503` and no token is created.** It does *not* snapshot a fail-closed `[]`.

Why this is different from the auth path, where `[]` is exactly right: the mint
writes a COLUMN, and `findByPlaintext` only ever re-INTERSECTS that column — it
never re-widens it. An `[]` persisted because the source blipped for one second
is therefore a **permanently dead credential**: it holds no SKUs, it can never
regain any once the source recovers, and the user was handed a `201 Created` with
a plaintext token and no hint that anything was wrong. They find out as a 403 at
some unrelated later moment. A deny at auth time is recoverable; a deny baked
into a credential is not.

Operator note: if PAT mints start returning `503 …entitlement source is
unavailable…`, the entitlements source is down or the service credential is
wrong. Existing PATs keep working (subject to the fail-closed intersection);
only issuance is blocked.

#### The entitlements interceptor deliberately skips the PAT lane

`EntitlementsInterceptor` used to no-op on a `co_pat_` request **by accident**
(the bearer failed `isRs256`). It now short-circuits **explicitly** on `req.pat`,
because overwriting `__entitlements` from a *user*-scoped endpoint answer would
discard the (token, workspace) bind the guard just computed. Consequence, stated
plainly: `ENTITLEMENTS_LAUNCH_GATE=enforce` **does not 403 a PAT** — that lane is
gated per-workspace by the SKU gates instead. Covered by
`entitlements.interceptor.spec.ts`.

#### New knobs (no deployed default changed)

| var | default | effect |
|---|---|---|
| `WORKSPACE_ENTITLEMENTS_TTL_MS` | `60000` (falls back to `ENTITLEMENTS_CACHE_TTL_MS`) | the revocation window above, for the **PAT** lane |
| `WORKSPACE_ENTITLEMENTS_JWT_TTL_MS` | `0` — **no cache** | max staleness the **JWT/session** lane accepts. `0` reproduces the pre-resolver behaviour exactly: `Workspace.entitlementCache` is re-read every request, so an operator pin edit lands on the very next call. Raise it only if you have configured a network entitlements source and want to cut its request volume — you are buying that many ms of under-enforcement. |
| `ENTITLEMENTS_SERVICE_TOKEN` | unset ⇒ the per-workspace endpoint lookup is **dormant** | service credential for `GET {ENTITLEMENTS_ENDPOINT_URL}?workspace_id=…`. ⚠️ Setting `ENTITLEMENTS_ENDPOINT_URL` **without** this yields zero server-side enforcement; the service logs a loud `WARN` at boot when it sees that combination, and the boot log states plainly whether each lane is LIVE or INERT. The resolver gates the server-side lane on `EntitlementsService.isWorkspaceLookupConfigured()` (URL **and** credential) rather than on `isConfigured()` (URL only), so a half-configured lane never even attempts a call it cannot authenticate. |
| `WORKSPACE_ENTITLEMENTS_OUTAGE_POSTURE` | `deny` | see the OUTAGE POSTURE box above. |
| `WORKSPACE_ENTITLEMENTS_FAILURE_TTL_MS` | `1000` | see the OUTAGE POSTURE box above. |

`UC_ENTITLEMENT_MODE` is **untouched** — same variable, same reducer, same
default (`enforce` for anything that is not literally `open`).

#### Sentinel: `personal_access_tokens.workspaceId` is nullable

Every PAT fence used to be written `if (workspaceId) { …check… }` — at the auth
guard, in the MCP `workspace_id` arg check, and in the entitlement bind. A NULL
therefore did not *fail* those checks, it **skipped** them, producing a token that
could address any workspace and that carried its snapshot unbound.

⚠️ **CORRECTION.** An earlier version of this section said "`PatService.create`
has never been able to produce such a row". That was true of `NULL` and **false
of a BLANK**. `ConfigService.get(key, default)` applies its default only to
`undefined`, so an explicitly-empty `DEFAULT_WORKSPACE_ID=` (trivial in a compose
file or a templated env) made `MembershipService.bootstrapWorkspaceId` return
`''`, `resolveAndAuthorize` return `''`, and `create()` persist `workspaceId: ''`
— which the sentinel then rejected with a generic 401 on **every** request,
forever, for a token that worked before this branch. A `201 Created` handing back
a permanently dead credential is exactly the failure mode the mint-time `503`
exists to prevent.

Fixed at the **write** side: `bootstrapWorkspaceId` (and
`WorkspaceContextService.defaultWorkspaceId`) now treat blank/whitespace as
absent and fall back to `DEFAULT_WORKSPACE_FALLBACK`, and `PatService.create()`
refuses outright (`503`) rather than persisting an unbindable binding. Pinned by
`auth/pat/pat-blank-workspace.spec.ts`, including the full mint → authenticate
round-trip. The sentinel itself is unchanged — it remains the last line for
hand-inserted rows, restored backups, and future migrations. All three sites
treat
"no bound workspace" as a **deny**, and `findByPlaintext` refuses the row outright
(generic 401). Each site is pinned by its own test, driven directly — not merely
shadowed by the layer in front of it.

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
- [ ] **PAT lane (§1d):** mint a `co_pat_` for the test paying user and hit a
      gated MCP tool (e.g. `triage_customer`) — confirm it is **entitled**, not
      403'd. A PAT minted BEFORE this fix shipped (empty `entitlements` column)
      will be denied until re-minted; that is expected, re-mint it.
- [ ] **Cross-org bind (§1e), only where `entitlementCache` is populated:** confirm
      a token/PAT carrying a SKU bought in another workspace does **not** unlock a
      workspace whose `entitlementCache` lacks it. (Where the cache is null this is
      a no-op — the claim stands.)

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
- `auth/guards/jwt-auth.guard.ts` → for a `co_pat_` bearer, stamps
  `user.__entitlements` off the PAT's mint-time snapshot (`§1d`) — the PAT has no
  token of its own.
- `auth/pat/pat.service.ts` → snapshots the minting user's SKUs onto
  `PersonalAccessToken.entitlements` at create.
- `common/workspace/workspace.util.ts` → `entitlementsOf(user)` (reads it back) +
  `parseWorkspaceEntitlements` / `intersectEntitlements` (the `§1e` bind).
- `common/workspace/workspace-context.service.ts` →
  `effectiveEntitlements(user, workspaceId)` = claim ∩ workspace cache. Each agent
  + `customers/customers.service.ts` + `relations-officer` build their federation
  / inference context with `entitlements: await …effectiveEntitlements(user, ws)`
  (NOT the bare `entitlementsOf(user)`).
- CI proof: `agents/inference/entitlement-claim-flow.spec.ts` (JWT claim → gate),
  `common/workspace/entitlement-workspace-binding.spec.ts` (PAT snapshot → gate +
  the (user, workspace) bind, incl. cross-org deny), `auth/guards/jwt-auth.guard.spec.ts`
  (PAT `__entitlements` stamp), `auth/pat/pat.service.spec.ts` (the snapshot),
  `auth/strategies/jwt.strategy.spec.ts` (the reader),
  `agents/inference/agent-inference.client.spec.ts` (the pure gate).

# Runbook — Activating multi-tenancy (RLS go-live) for Customer-Ops

Turning the tenant fence **live**: pointing the runtime at the `NOBYPASSRLS`
`customer_ops_app` role AND setting `CUSTOMER_OPS_TENANCY_ENABLED=true`, so
Postgres Row Level Security actually scopes every query to the request's
workspace. This is the **#1 production keystone** — do it deliberately, in the
order below, dogfood first, then prod.

> **This runbook flips nothing by itself.** It is the tested, ordered procedure.
> Every live mutation (env edit, `ALTER ROLE … PASSWORD`, `up -d backend`) is an
> **operator (Aaron) action**, called out as such. Read it end-to-end once before
> running step 1.

The database half of this is **proven green** by
[`scripts/verify-tenancy.sh`](../../scripts/verify-tenancy.sh) (33 assertions, all
six scoped tables: own-read OK / cross-read 0 / cross-write blocked / no-GUC and
empty-GUC fail closed, as the real `customer_ops_app` role). Run it before and
keep its output with the change record.

---

## 0. The model in one paragraph (why two switches, not one)

RLS is **created + FORCED** by the migrations on every tenant-scoped table, but
it is **inert today** because the runtime connects as `customer_ops_admin`, which
is a member of `customer_ops_owner` and therefore **`BYPASSRLS`** — a bypass role
is never subject to policy, even under FORCE. Two independent things must BOTH be
true for isolation to be real:

1. **`DATABASE_URL` points at `customer_ops_app`** (`NOBYPASSRLS`) — this is the
   security flip; it makes the DB enforce the policy on the runtime.
2. **`CUSTOMER_OPS_TENANCY_ENABLED=true`** — this is the app flip; it turns the
   membership gate on (routes 403 without an active membership) and makes the
   membership-derived workspace drive the GUC.

The GUC chokepoint (`PrismaService.withWorkspace` → `SET LOCAL
app.current_workspace`) already runs today and is harmless under the owner; it
just isn't *enforced* until switch #1. Flip them **together**, in one
`up -d backend`.

> **The trap if you only flip #1:** the fence enforces, but the app still resolves
> every request to `DEFAULT_WORKSPACE_ID` (the gate is off), so a token carrying a
> different `workspace_id` claim would set the GUC to that other id and read
> **zero rows** — a confusing "my data vanished", not a security hole. Flip #2
> with it. **The trap if you only flip #2:** the gate 403s non-members, but the DB
> still doesn't enforce row isolation (owner BYPASSRLS), so a bug that leaks a GUC
> wouldn't be caught by the database. Neither half alone is the contract.

---

## 1. Pre-flight (no live mutation — run these read-only first)

All `docker exec … psql` reads below are **non-mutating** `SELECT`s; safe to run
against the live dogfood DB.

### 1a. Prove the DB contract on a throwaway DB (must be green)

```bash
# From the repo root, on a machine with docker + the repo's node_modules:
./scripts/verify-tenancy.sh
# expect: "TENANCY FENCE PROVEN — 33 checks passed, 0 failed." exit 0
```

### 1b. Confirm the live role + RLS posture is what we expect

```bash
# Roles: app=f (NOBYPASSRLS), owner=t (BYPASSRLS), admin=t (BYPASSRLS via owner).
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -tA -c \
  "select rolname, rolbypassrls, rolcanlogin from pg_roles where rolname like 'customer_ops%' order by 1;"
#   customer_ops_admin|t|t
#   customer_ops_app|f|t      <- the runtime role we will switch to
#   customer_ops_audit|f|t
#   customer_ops_owner|t|f
#   customer_ops_ro|f|t

# Every scoped table is ENABLE + FORCE with the workspace_isolation policy:
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -tA -c \
  "select c.relname, c.relrowsecurity, c.relforcerowsecurity,
          (select count(*) from pg_policies p where p.tablename=c.relname and p.policyname='workspace_isolation') as pol
   from pg_class c
   where c.relname in ('customers','customer_activities','customer_invoice_links',
                       'customer_outreach_links','customer_email_links','lead_intakes')
   order by 1;"
# every row must be: <table>|t|t|1
```

### 1c. Confirm the DATA invariant (every row carries a real workspace_id)

```bash
# No NULL workspace_id anywhere (a NULL row is invisible+unwritable under RLS —
# fail-closed — so it would silently disappear at go-live). Expect 0 for all six.
for t in customers customer_activities customer_invoice_links \
         customer_outreach_links customer_email_links lead_intakes; do
  docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -tA -c \
    "select '$t', count(*) from \"$t\" where \"workspaceId\" is null;"
done

# How many distinct workspaces hold data today, and which? (dogfood = exactly one.)
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -tA -c \
  "select \"workspaceId\", count(*) from customers group by 1 order by 2 desc;"
# dogfood today: 0190a000-7e57-7000-8000-00000000c007 | 14   (one workspace)
```

> **Verified on the live dogfood DB at the time this runbook was written**
> (2026‑06‑06, read-only): all six tables ENABLE+FORCE+policy present; app role
> `NOBYPASSRLS`; **zero NULL workspace_id rows**; **all data under the single
> bootstrap workspace `…c007`** (14 customers, 14 lead_intakes); **`memberships`
> table empty** (see §3 — this is the one thing you must seed before §4).

### 1d. Confirm the membership/identity state (the gate's inputs)

```bash
# Memberships seeded? (dogfood: likely 0 — the JIT seeder only runs when tenancy
# is ON, and the migration's bootstrap INSERT only fires for SSO-linked
# access-list users that already existed at migrate time.)
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -tA -c \
  "select count(*) as memberships from memberships;"

# The operators who must keep access — are they SSO-linked (keycloakId not null)?
# The membership key IS keycloakId; a null-keycloakId user cannot be seeded.
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -tA -c \
  "select email, (\"keycloakId\" is not null) as sso_linked from users order by email;"
# Each operator on CUSTOMER_OPS_ACCESS_LIST as :OWNER must show sso_linked = t.
```

---

## 2. The security flip — set the `customer_ops_app` password (operator)

`customer_ops_app` exists with a placeholder password (`change_me_app` from
`01-init.sql`, or `verify_app` from the RLS migration's dev default). Set a real
one **before** repointing `DATABASE_URL` at it.

```bash
# AARON: pick a strong app password OUT OF BAND (do not paste it anywhere it is
# logged). Then, on bigboy:
APP_PW='<generate: openssl rand -hex 24>'   # avoid + / = to keep the URL clean
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -c \
  "ALTER ROLE customer_ops_app LOGIN PASSWORD '$APP_PW';"
# (NOBYPASSRLS / NOCREATEDB / NOCREATEROLE are already pinned by init + migration.)
```

> **Secret hygiene:** this password is the new runtime DB credential. It belongs in
> Vaultwarden + the rotation checklist, and only in `deploy/.env` on the host. Never
> commit it; never echo it into a shell that ships logs.

---

## 3. The DATA step — pre-seed memberships + re-home workspace ids

This is the step the short go-live note in `deploy/DEPLOY.md` glosses over and the
one most likely to lock you out. Do it **before** the flip.

### 3a. Re-home existing rows to the shared uc-registry workspace (only if changing the id)

Customer-Ops **consumes** workspace ids from uc-registry; it never mints them. The
dogfood ran on the locally-minted bootstrap id `…c007`. The suite plan
(SUITE-IDENTITY §0.1) is for the apps to share **one** uc-registry workspace id
for the Magic Unicorn tenant.

- **If go-live keeps `…c007`** (the suite agrees to adopt the bootstrap id as the
  canonical uc-registry id for this tenant): **no data move needed** — all rows
  already carry `…c007` (verified §1c). Skip to §3b.
- **If uc-registry assigns a DIFFERENT canonical id** `$UC_REGISTRY_WS`: re-home
  every scoped table **as the owner** (BYPASSRLS — so the UPDATE isn't itself
  fenced), in one transaction, and update the `Workspace` mirror + memberships +
  `DEFAULT_WORKSPACE_ID` to match. **Because all data is under one id today, this
  is a single deterministic remap, not a per-row decision.**

```bash
# AARON, ONLY in the "different id" case. Take a backup first (§6 rollback).
OLD='0190a000-7e57-7000-8000-00000000c007'
NEW='<uc-registry canonical workspace_id>'
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -v ON_ERROR_STOP=1 <<SQL
BEGIN;
-- 1. The workspace mirror row must exist at the NEW id first (FK target).
INSERT INTO workspaces (id, slug, "displayName", "isolationMode", "isolationTier",
                        status, "syncedAt", "createdAt", "updatedAt")
  SELECT '$NEW', slug, "displayName", "isolationMode", "isolationTier",
         status, now(), "createdAt", now()
  FROM workspaces WHERE id = '$OLD'
ON CONFLICT (id) DO NOTHING;
-- 2. Re-home every scoped table (owner bypasses RLS, so these see all rows).
UPDATE customers              SET "workspaceId" = '$NEW' WHERE "workspaceId" = '$OLD';
UPDATE customer_activities    SET "workspaceId" = '$NEW' WHERE "workspaceId" = '$OLD';
UPDATE customer_invoice_links SET "workspaceId" = '$NEW' WHERE "workspaceId" = '$OLD';
UPDATE customer_outreach_links SET "workspaceId" = '$NEW' WHERE "workspaceId" = '$OLD';
UPDATE customer_email_links   SET "workspaceId" = '$NEW' WHERE "workspaceId" = '$OLD';
UPDATE lead_intakes           SET "workspaceId" = '$NEW' WHERE "workspaceId" = '$OLD';
-- 3. Move memberships (if any were seeded under the old id).
UPDATE memberships            SET "workspaceId" = '$NEW' WHERE "workspaceId" = '$OLD';
-- 4. Verify nothing is left on the old id, THEN drop the stale mirror row.
--    (Abort the whole tx if any scoped row stayed behind.)
DO \$\$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM customers WHERE "workspaceId" = '$OLD';
  IF n > 0 THEN RAISE EXCEPTION 'customers still on old id: %', n; END IF;
END \$\$;
DELETE FROM workspaces WHERE id = '$OLD'
  AND NOT EXISTS (SELECT 1 FROM customers WHERE "workspaceId" = '$OLD');
COMMIT;
SQL
# Then set DEFAULT_WORKSPACE_ID=$NEW in deploy/.env (§4).
```

> The `*_WORKSPACE_OVERRIDE` federation shims (`CONTACT_OPS_WORKSPACE_OVERRIDE`,
> `MEETING_OPS_WORKSPACE_OVERRIDE`) are an **outbound address remap** — they
> rewrite the workspace id Customer-Ops sends to the *remote* app, so a single
> dogfood workspace maps onto each peer's own tenant id while the suite isn't yet
> on one shared id. They do **not** touch Customer-Ops' own RLS GUC. Once the
> whole suite shares one uc-registry id, **unset both overrides** so
> `ctx.workspaceId` (the real local id) flows through unchanged. Until then, leave
> them as-is; they are independent of this flip. (See §7 gap list.)

### 3b. Pre-seed the operators' memberships (so the flip doesn't lock you out)

With the gate ON, a route 403s unless the caller has an **active membership** in
the resolved workspace. The app *will* JIT-seed an allow-listed, SSO-linked user
on their first request after the flip (`MembershipService.ensureSeededMembership`)
— but **do not rely on that for the operator doing the flip**; seed explicitly so
the very first authed request already passes.

```bash
# AARON, on bigboy. WS is the canonical workspace id you're going live on
# (…c007, or $NEW from §3a). Seed OWNER for every operator on the access list,
# keyed by their keycloakId (the membership key). Idempotent.
WS='0190a000-7e57-7000-8000-00000000c007'   # or the uc-registry id from §3a
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -v ON_ERROR_STOP=1 -c "
  INSERT INTO memberships (\"userKey\", \"workspaceId\", role, status, \"isDefault\", \"createdAt\")
  SELECT u.\"keycloakId\", '$WS', 'OWNER', 'ACTIVE', true, now()
  FROM users u
  WHERE u.\"keycloakId\" IS NOT NULL
    AND lower(u.email) IN ('aaron@magicunicorn.tech','shafenkhan@users.noreply.github.com')
  ON CONFLICT (\"userKey\", \"workspaceId\") DO NOTHING;"

# Verify at least one ACTIVE OWNER membership exists in WS before flipping:
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -tA -c \
  "select \"userKey\", role, status from memberships where \"workspaceId\"='$WS';"
```

> If an operator shows `sso_linked = f` in §1d, they have **no keycloakId** and
> cannot be seeded by key — have them sign in once (JIT-links the keycloakId)
> **before** the flip, then re-run this seed. The Workspace mirror row for `$WS`
> must also exist (the bootstrap migration created `…c007`; §3a creates `$NEW`).

---

## 4. The flip (operator — dogfood first)

Edit `deploy/.env` on bigboy. Change exactly these, leave everything else:

```diff
# point the runtime at the NOBYPASSRLS role (the security flip)
-DATABASE_URL=postgresql://localhost:5432/customer_ops<admin-pw>@customer-ops-postgres:5432/customerops?schema=public
+DATABASE_URL=postgresql://localhost:5432/customer_ops<APP_PW from §2>@customer-ops-postgres:5432/customerops?schema=public

# KEEP migrations on the owner/BYPASSRLS role (see the CRITICAL note below)
 ADMIN_DATABASE_URL=postgresql://localhost:5432/customer_ops<admin-pw>@customer-ops-postgres:5432/customerops?schema=public

# turn the membership gate on (the app flip)
-CUSTOMER_OPS_TENANCY_ENABLED=false
+CUSTOMER_OPS_TENANCY_ENABLED=true

# if §3a changed the id, also:
-DEFAULT_WORKSPACE_ID=0190a000-7e57-7000-8000-00000000c007
+DEFAULT_WORKSPACE_ID=<$NEW>
```

> ### CRITICAL — migrations vs runtime role (the deploy trap)
> The backend container's start command is hard-coded:
> `npx prisma migrate deploy && node dist/main`, and **`prisma migrate deploy`
> reads `DATABASE_URL`** — *not* `ADMIN_DATABASE_URL` (which nothing in the code
> consumes today; it is documentation-only). So once `DATABASE_URL` points at
> `customer_ops_app` (`NOBYPASSRLS`, `NOCREATEROLE`, no schema-owner privilege),
> the **next deploy's migrate step will FAIL** on any migration that creates a
> role / type / table or alters grants. **Before this flip becomes the steady
> state, change how migrations run.** Pick ONE:
>
> - **(A) Recommended — separate the migrate step from the runtime URL.** Change
>   the backend `command` to run the migrate as the owner and the app as the app
>   role, e.g.
>   `sh -c 'DATABASE_URL="$ADMIN_DATABASE_URL" npx prisma migrate deploy && node dist/main'`
>   (so the long-lived process keeps the app `DATABASE_URL`, but migrations use
>   the admin URL). **This is a code change to `deploy/docker-compose.dogfood.yml`
>   + `backend/Dockerfile` CMD — out of this runbook's file scope; tracked as a
>   followup. Land it BEFORE go-live.**
> - **(B) Interim — run migrations manually as admin, then start the app.** Keep
>   `command: node dist/main` (no migrate on boot) and run
>   `docker exec -e DATABASE_URL=<admin-url> customer-ops-backend npx prisma migrate deploy`
>   as a deliberate pre-deploy step each release. Simpler now, but a release that
>   forgets the manual migrate starts stale.
>
> Until (A) lands, treat every go-live deploy as: **(1) migrate as admin, (2)
> start app as app role.** Do not `up -d --build` with the app-role `DATABASE_URL`
> and the boot-migrate command together.

Then recreate the backend so the new env is read (`up -d`, **never** `restart` —
`restart` does not re-read `env_file`):

```bash
cd ~/customer-ops
# Path (A) in place — the boot-migrate uses ADMIN_DATABASE_URL, runtime uses app role:
docker compose -f deploy/docker-compose.dogfood.yml up -d backend
# Path (B) — migrate first, then recreate:
#   docker exec -e DATABASE_URL="<admin-url>" customer-ops-backend npx prisma migrate deploy
#   docker compose -f deploy/docker-compose.dogfood.yml up -d backend
```

---

## 5. Smoke tests (right after the flip — dogfood)

```bash
# 5a. Runtime is actually the app role now (from INSIDE the container's env):
docker exec customer-ops-backend printenv DATABASE_URL | sed -E 's#(//)([^:]+):[^@]*@#\1\2:REDACTED@#'
#   -> postgresql://localhost:5432/customer_ops   (NOT _admin)
docker exec customer-ops-backend printenv CUSTOMER_OPS_TENANCY_ENABLED   # -> true

# 5b. Health + DB connectivity through the app role:
curl -fsS https://customer-ops.magicunicorn.dev/api/v1/health | jq .
#   -> status "ok", database "up"  (proves the app role can connect + run withWorkspace)

# 5c. AUTHED own-workspace read still returns the operator's rows (gate admits the
#     pre-seeded OWNER; the GUC binds to WS; the 14 dogfood customers resolve):
#   Sign in at https://customer-ops.magicunicorn.dev as aaron@magicunicorn.tech,
#   open the pipeline — the existing relationships must render (count unchanged).
#   Equivalent API check with a real bearer:
TOKEN='<paste a fresh uchub access token for the operator>'
curl -fsS https://customer-ops.magicunicorn.dev/api/v1/customers \
  -H "Authorization: Bearer $TOKEN" | jq 'length'    # -> 14 (or your live count)

# 5d. The fence is LIVE for the runtime role (defense in depth — prove a no-GUC
#     read returns 0 even though the app is connected):
docker exec -e PGPASSWORD='<APP_PW>' customer-ops-postgres \
  psql -X -tA -U customer_ops_app -d customerops -c "select count(*) from customers;"
#   -> 0   (no app.current_workspace set on this ad-hoc psql session => fail-closed)

# 5e. A NON-member is fenced: a valid uchub token for a user with NO membership in
#     WS must 403 on /customers (the gate), not 200-with-0-rows.
curl -s -o /dev/null -w '%{http_code}\n' https://customer-ops.magicunicorn.dev/api/v1/customers \
  -H "Authorization: Bearer <token for a non-member user>"   # -> 403
```

If 5c returns `0` (instead of your live count) for the **operator**, the most
likely cause is a workspace mismatch: the token's `workspace_id` claim, the
pre-seeded membership's `workspaceId`, and the data's `workspaceId` are not the
same id. Reconcile to ONE id (§3) — do not "fix" it by reverting the role; that
just re-hides the bug.

---

## 6. Rollback (fast, safe)

The flip is **env-only** + an idempotent membership seed; nothing about the schema
or data changes (RLS was already created+forced). To revert to today's behavior:

```bash
# In deploy/.env, restore both switches:
#   DATABASE_URL -> customer_ops_admin (the BYPASSRLS owner)
#   CUSTOMER_OPS_TENANCY_ENABLED=false
docker compose -f deploy/docker-compose.dogfood.yml up -d backend
```

The owner role bypasses RLS, so all rows are immediately visible again and the
membership gate is a no-op. The pre-seeded memberships are harmless when the flag
is off (they're simply ignored). **Leave them** — they're exactly what you need on
the next attempt.

> If you ran the §3a **data re-home** and need to undo it, that is a real data
> move — restore from the backup you took before §3a (`pg_dump` of the volume), or
> run the inverse UPDATE swapping `$NEW`/`$OLD`. This is why §3a says *take a
> backup first*. The env flip (§4) and the membership seed (§3b) need no backup;
> the data re-home does.

```bash
# Backup BEFORE §3a (only needed if you change the workspace id):
docker exec customer-ops-postgres pg_dump -U customer_ops_admin -Fc customerops \
  > ~/customer-ops-pre-tenancy-$(date +%Y%m%d%H%M).dump
```

---

## 7. Prod / additional tenants (after dogfood is green)

Dogfood is a single tenant on one workspace; the "prod" posture for Customer-Ops
is the **same two switches** plus real multi-tenant data:

1. **Repeat §1–§5 on the prod node** with that node's `customer_ops_app` password
   and its `deploy/.env`. The throwaway-DB proof (§1a) is environment-independent —
   it already covers the multi-workspace case (it seeds two workspaces and proves
   cross-isolation), so it's your prod gate too.
2. **Multiple tenants:** each workspace id comes from **uc-registry** (Customer-Ops
   never mints one). Provisioning a tenant = (a) the `Workspace` mirror row exists
   locally (synced from uc-registry), (b) the tenant's users have **ACTIVE
   memberships** in that workspace. The membership gate + RLS then isolate them
   automatically — there is no per-tenant schema or policy work; the
   `workspace_isolation` policy is generic on `workspaceId = current_workspace_id()`.
3. **Keep `migrate deploy` on the owner** (the §4 CRITICAL note) on every node.
4. **Unset the `*_WORKSPACE_OVERRIDE` shims** once the suite shares one uc-registry
   id per tenant (see the gap list), so federated calls address peers by the real
   workspace id instead of the dogfood remap.

---

## Appendix — what breaks under RLS, and why these don't (the gap audit)

The codebase was audited for RLS-incompatible access patterns. Findings:

- **Raw SQL (`$queryRaw` / `$executeRaw`).** Every occurrence runs on the
  transaction client `tx` inside `withWorkspace` (so the GUC is bound), and each
  reads `current_workspace_id()` and **fails closed** if unset
  (`customers.service.ts` / `lead-intake.service.ts` `boundWorkspaceId`, the three
  `agents/*.agent.ts` activity writers). The only non-`tx` raw query is
  `health/prisma.health.ts` `SELECT 1` — touches no scoped table. **Safe.**
- **Direct `this.prisma.<model>` (bypassing `withWorkspace`).** Audited: the only
  models accessed directly off the base client are `user`, `membership`,
  `workspace` — the three **non-RLS control/identity tables** (intentionally not
  fenced; the membership *is* the tenancy boundary). **Zero** direct base-client
  calls hit a scoped model (`customer*`, `lead_intakes`). **Safe.**
- **MCP tool paths.** `mcp.service.ts` does no DB work itself; it delegates to
  `CustomersService` / `LeadIntakeService`, which use `runForUser` /
  `withWorkspace`. Each MCP tool takes an optional `workspace_id` that flows into
  `resolveAndAuthorize` (membership-gated when tenancy is on). **Same chokepoint as
  REST — safe.**
- **The agents.** `lead-triage` / `follow-up-drafter` / `collections-nudge` all
  enter via `workspaces.runForUser` and read the bound GUC before writing the
  `AGENT_RUN` activity. **Safe.**
- **Seed scripts.** There is **no** standalone seed script that writes scoped
  tables outside a request. The migrations seed only the **control** tables
  (`workspaces`, `memberships`) — not RLS-fenced — as the owner. **Safe.**
- **Cross-workspace joins.** None. Every scoped table denormalizes `workspaceId`
  and the cockpit reads within one workspace; there is no query that joins rows
  across two workspaces (which RLS would silently filter to the empty intersection
  anyway). **Safe.**
- **The `*_WORKSPACE_OVERRIDE` shims — the one thing to retire, not a break.**
  `CONTACT_OPS_WORKSPACE_OVERRIDE` / `MEETING_OPS_WORKSPACE_OVERRIDE` remap the
  workspace id sent to *peer* apps (outbound federation addressing); they do
  **not** affect Customer-Ops' own GUC, so they don't break under RLS. But they
  exist only because the suite isn't yet on one shared uc-registry id. **Action at
  prod (§7):** once the suite shares the id, unset both so `ctx.workspaceId` flows
  through. Until then they are correct and inert w.r.t. this flip.

The single load-bearing risk is **operator/data**, not code: ensure every existing
row's `workspaceId`, the operators' membership `workspaceId`, and the token's
`workspace_id` claim are the **same** uc-registry id (§3). The code path is already
RLS-clean.

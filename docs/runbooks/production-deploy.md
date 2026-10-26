# Customer-Ops — Production Deploy Runbook (centerdeep / unicorncommander.ai)

Target: frontend **customer-ops.unicorncommander.ai** + backend
**api.customer-ops.unicorncommander.ai** on **centerdeep** (Tailscale
`100.87.46.87`, public origin IP `72.61.2.67`, user `muut`, Docker, Traefik v3.6).

> **Why centerdeep (not commander).** Decision (Aaron, 2026-06): the public
> Customer-Ops SaaS runs on **centerdeep**, where the other customer-facing suite
> apps already live (project-ops-customer, contact-ops, meeting-ops). Commander
> remains the suite's shared identity/billing/inference plane (Keycloak `auth.`,
> Brigade, uc-registry, Lago, the litellm gateway) — those cross-app seams below
> still point at commander on purpose.

This is the **public production** posture — the deltas from the dogfood bring-up
(`deploy/DEPLOY.md`, host bigboy) are:

| | Dogfood (bigboy) | **Production (centerdeep)** |
| --- | --- | --- |
| Frontend host | customer-ops.magicunicorn.dev | **customer-ops.unicorncommander.ai** |
| Backend host | (same host /api) | **api.customer-ops.unicorncommander.ai** |
| Tenancy | OFF (runtime = owner) | **ON (runtime = NOBYPASSRLS `customer_ops_app`)** |
| Entitlements | `open` (warn) | **`enforce`** |
| Federation | all seams blank | **wired one app at a time** |
| Compose | `docker-compose.dogfood.yml` | **`docker-compose.prod.yml`** |
| Env | `.env.dogfood.example` | **`.env.prod.example`** |
| Traefik provider | docker labels (bigboy) | **docker labels, network `web` (centerdeep)** |
| Traefik entrypoint | `web`/`websecure` | **`websecure`** |
| Cert resolver | `letsencrypt` (HTTP-01) | **`cloudflare` (DNS-01)** |
| API routing | same-host `/api` | **api.* subdomain (matches the centerdeep sibling)** |

> Read `deploy/DEPLOY.md` first — the app-level mechanics (KC client shape, the
> `prisma migrate deploy` boot sequence) are identical; this runbook layers on the
> production host + the security flips + the cross-app dependency order. **Note:**
> DEPLOY.md describes the same-host `/api` routing rationale (the commander/dogfood
> shape). On **centerdeep** the API is on a dedicated `api.` host instead, to match
> the centerdeep sibling **project-ops-customer** (which puts its API on
> `api.projectops.unicorncommander.ai`) — see §5 for why that 3-level host works
> here (DNS-01) when it didn't on commander (HTTP-01 only).

---

## 0. Cross-app dependency order (do these BEFORE first deploy)

Customer-Ops is a federation client. Bring the dependencies up first, in this
order, or the first authed request fails:

1. **Keycloak `customer-ops` client** (auth.unicorncommander.ai, realm `uchub`) —
   §1 below. *Gates: sign-in.*
2. **Brigade audience allow-list** must include `customer-ops` — §2 below.
   *Gates: cross-app federation tokens (Contact-Ops / Meeting-Ops handshakes).*
3. **uc-registry workspace** for the prod tenant — §3 below.
   *Gates: tenant resolution / membership under live tenancy.*
4. **Lago entitlement claim** for customer-ops emitted — §4 below.
   *Gates: `UC_ENTITLEMENT_MODE=enforce` (until then run `open`).*
5. **Per-app federation tokens** (Contact-Ops, etc.) — wired incrementally
   AFTER first boot, one at a time (§7).

Items 1–3 are **Aaron levers** (Keycloak admin, Brigade config, uc-registry). The
deploy itself (§5–6) can proceed in `open` entitlement mode the moment 1–3 exist.

---

## 1. Keycloak `customer-ops` client (realm `uchub`)

Identical to the dogfood client (`deploy/DEPLOY.md` §a.1) **except the redirect
URIs use the prod hosts**. On **auth.unicorncommander.ai**, realm **uchub**:

- **Client ID:** `customer-ops`  (confidential, OIDC, **RS256**)
- **Standard flow:** ON. Direct access grants: off.
- **Valid redirect URIs** (NOTE the OIDC callback is on the **api.** host on
  centerdeep, because the backend — which serves `/api/v1/auth/keycloak/callback`
  — is on that host):
  - `https://api.customer-ops.unicorncommander.ai/api/v1/auth/keycloak/callback`
    (the exact `KEYCLOAK_CALLBACK_URL`)
  - `https://customer-ops.unicorncommander.ai/*` (the frontend host, for the
    post-login return to the SPA)
- **Valid post-logout redirect URIs:** `https://customer-ops.unicorncommander.ai/*`
- **Web origins:** `https://customer-ops.unicorncommander.ai` (the SPA origin)
  — and add `https://api.customer-ops.unicorncommander.ai` if you see CORS
  preflight rejections on the auth callback.
- **Audience:** issued tokens must carry `aud=customer-ops` (matches
  `BRIGADE_EXPECTED_AUDIENCE`). Add an **Audience** mapper if the realm doesn't by
  default.
- **Secret:** Credentials tab → copy → this is `KEYCLOAK_CLIENT_SECRET` in `.env`.

> A single `customer-ops` client can carry both hosts' redirect URIs (dogfood +
> prod) if you prefer one client; production-only is cleaner. Either way the
> secret in commander's `.env` must match the client you point it at.

---

## 2. Brigade audience allow-list

Brigade (brigade.unicorncommander.ai) brokers RFC-8693 token exchange. For
Customer-Ops to (a) accept federation tokens addressed to it and (b) mint
exchange requests to Contact-Ops/Meeting-Ops, **`customer-ops` must be on
Brigade's audience allow-list** (the access-list / audience-binding config the
suite uses). This is already proven for the dogfood node (memory:
customer-ops→Brigade STS→Contact-Ops upsert_person works); confirm the **prod**
`aud=customer-ops` is allowed for the commander Brigade instance.

*Read-only check (no mutation):* confirm Brigade is healthy and the audience
appears in its config:
```bash
curl -fsS https://brigade.unicorncommander.ai/health
```
The actual allow-list edit is a **Brigade-side config change (Aaron lever)** —
see the Brigade federation runbook, not this repo.

---

## 3. uc-registry workspace

Under live tenancy, the membership gate resolves the acting user → a workspace via
uc-registry (uc-ops-center on **commander** — the shared identity plane, NOT on
centerdeep). Ensure the prod workspace exists and the OWNER users (from
`CUSTOMER_OPS_ACCESS_LIST`) are members. `DEFAULT_WORKSPACE_ID` in `.env` is the
seeded bootstrap/owner workspace (`0190a000-7e57-7000-8000-00000000c007`); for a
public multi-tenant posture, new tenants' workspaces come from uc-registry at
sign-in.

*Read-only check (run on commander):* `uc-ops-center-uc-registry-1` is healthy
(`ssh commander docker ps`). The workspace/membership provisioning is a
**uc-registry operation (Aaron lever)**.

---

## 4. Lago entitlement claim

`UC_ENTITLEMENT_MODE=enforce` makes cross-app + inference gates return 402/403
when Lago (`unicorn-lago-api` on commander) does NOT emit a sufficient
customer-ops entitlement claim. **Bring up the first prod boot in `open`**
(warn-only), confirm the claim flows for your OWNER accounts, THEN flip to
`enforce` and `docker compose ... up -d customer-ops-backend`. Flipping enforce
before the claim exists 402s legitimate users.

---

## 5. DNS (Cloudflare) + TLS posture (centerdeep)

Centerdeep splits the app across **two** hosts, with two different Cloudflare
postures — this MATCHES the live sibling `project-ops-customer` exactly.

**Frontend — `customer-ops.unicorncommander.ai` (2-level, ORANGE-cloud / proxied):**
No new DNS record needed. The Cloudflare wildcard `*.unicorncommander.ai` already
resolves it to the CF edge (verified: `dig +short customer-ops.unicorncommander.ai`
→ CF anycast `104.21.34.94` / `172.67.203.72`, identical to the live 2-level
sibling `projectops.unicorncommander.ai`, which serves the CF edge cert
`CN=unicorncommander.ai`, Google Trust Services). Universal SSL covers this
2-level name at the edge. Keep the zone SSL mode at **Full (strict)**; the
`cloudflare` DNS-01 resolver also mints a real origin cert behind the proxy so the
CF→origin pull validates.

**Backend — `api.customer-ops.unicorncommander.ai` (3-level, GRAY-cloud / DNS-only):**
**ONE new DNS record is required (Aaron lever):**
> Add an **A record** `api.customer-ops` → **`72.61.2.67`** (centerdeep's origin
> IP), **gray-cloud (Proxy status: DNS only)** in the `unicorncommander.ai` zone.

Why gray-cloud + DNS-01 (the moat detail, VERIFIED on the sibling):
- A **3-level** name is **NOT** covered by Cloudflare Universal SSL (the wildcard
  `*.unicorncommander.ai` is one level only). Behind the orange-cloud proxy a
  3-level host therefore has no valid edge cert.
- On **centerdeep this is solved, not avoided**: Traefik's `cloudflare` cert
  resolver uses the **DNS-01** challenge (`CF_DNS_API_TOKEN`-backed, configured in
  `/home/muut/Production/traefik/traefik.yml`) to mint a real per-host Let's
  Encrypt cert for the 3-level name. VERIFIED LIVE on the sibling: the TLS
  handshake to `api.projectops.unicorncommander.ai` presents a real LE origin cert
  `CN=api.projectops.unicorncommander.ai` (issuer Let's Encrypt). `dig` confirms
  that sibling is gray-clouded — it resolves to the bare origin `72.61.2.67`, not
  the CF anycast range.
- Commander could NOT do this (its only resolver was HTTP-01 `letsencrypt`, which
  cannot answer the ACME challenge for a proxied 3-level host), which is the only
  reason the commander artifact used a same-host `/api` split. Centerdeep's DNS-01
  resolver removes that constraint, so we match the sibling's `api.` shape.

No Cloudflare zone SSL-mode change is needed for the gray-cloud `api.` host — it
bypasses the CF edge entirely; clients hit the centerdeep origin and Traefik
serves the DNS-01 cert directly.

> The same-host `/api` alternative (the commander shape) is preserved in the
> Appendix for reference, but the **api.* subdomain is the centerdeep default**
> because it matches the sibling and the DNS-01 resolver makes it free.

---

## 6. First deploy

All commands on **centerdeep** as `muut` (`ssh centerdeep`). The deploy root
convention here is `~/Production/<app>` (siblings: `~/Production/project-ops-customer`,
`~/Production/contact-ops`). Compose is invoked with `-f deploy/docker-compose.prod.yml`
from the repo root.

```bash
# 1. Get the repo next to the siblings:
cd ~/Production
git clone <customer-ops repo URL> customer-ops
cd ~/Production/customer-ops
git checkout <release ref>        # the reviewed prod commit/tag (deploy/centerdeep-prod)

# 2. Env file:
cp deploy/.env.prod.example deploy/.env
#   Generate + fill (NEVER commit .env):
openssl rand -base64 32   # -> POSTGRES_PASSWORD + ADMIN_DATABASE_URL (admin/owner pw, 2 places)
openssl rand -base64 32   # -> CUSTOMER_OPS_APP_DB_PASSWORD (the runtime app role pw, used in DATABASE_URL)
openssl rand -base64 64   # -> JWT_SECRET
#   plus KEYCLOAK_CLIENT_SECRET (from §1). Fill federation *_SERVICE_TOKEN later (§7).
#   FIRST BOOT TIP: set UC_ENTITLEMENT_MODE=open here; flip to enforce in §4 after
#   confirming the Lago claim.
nano deploy/.env

# 3. Confirm the ingress network exists:
docker network inspect web >/dev/null && echo "web OK"

# 4. Bring up ONLY postgres first, so first-boot init creates the role split:
docker compose -f deploy/docker-compose.prod.yml up -d customer-ops-postgres
until docker exec customer-ops-postgres pg_isready -U customer_ops_admin -d customerops >/dev/null 2>&1; do sleep 2; done

# 5. Run the schema migration ONCE as a one-shot, as the OWNER (the app role is
#    NOBYPASSRLS/NOCREATEDB and cannot apply DDL). Do this BEFORE setting the real
#    app password (step 6): the RLS-roles migration carries an `ALTER ROLE
#    customer_ops_app … PASSWORD '<placeholder>'` that overwrites the role password
#    on its first run, so the real password MUST be set after this, not before:
docker compose -f deploy/docker-compose.prod.yml run --rm --entrypoint sh \
  customer-ops-backend -c 'DATABASE_URL="$ADMIN_DATABASE_URL" npx prisma migrate deploy'

# 6. NOW set the REAL customer_ops_app password ON THE ROLE. This MUST equal
#    CUSTOMER_OPS_APP_DB_PASSWORD in DATABASE_URL. Migrations are already applied,
#    so the backend's own boot-migrate (step 7) is a no-op and will NOT reset it:
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -c \
  "ALTER ROLE customer_ops_app PASSWORD '<CUSTOMER_OPS_APP_DB_PASSWORD>';"

# 7. Bring up the rest (build images + start backend+frontend):
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

What happens on backend start (see the compose `command`): the boot re-runs
`DATABASE_URL="$ADMIN_DATABASE_URL" npx prisma migrate deploy` — now a **no-op**
because step 5 already applied every migration (so it neither re-runs the
placeholder-password migration nor clobbers step 6's real password) — then
`node dist/main` boots the app reading the runtime `DATABASE_URL` (the **app**
role). RLS is live and enforced per request via the `app.current_workspace` GUC.

The production backend sets `HOME=/tmp` because its root filesystem is
read-only and `/tmp` is the writable tmpfs. This keeps Chromium's crashpad
configuration/database writable when quote PDF rendering is enabled; keep the
same value in `deploy/.env` when preparing production.

> **Why migrate is a one-shot BEFORE the password (step 5 → 6).** The
> `…_suite_tenancy_rls_roles` migration carries `ALTER ROLE customer_ops_app …
> PASSWORD '<placeholder>'`, which overwrites the role's password on its FIRST
> run. If you set the real password first and then let the backend's boot-migrate
> run it, the role password reverts to the placeholder while `DATABASE_URL` still
> holds the real one → the backend crash-loops on password auth. Migrating first
> (placeholder harmless) and setting the real password after (migrate will never
> run again) closes that window. The migration file is immutable history — editing
> it breaks Prisma's applied checksum on the already-migrated dogfood DB — so the
> **ordering** is the fix, not a migration change.

---

## 7. Wire federation (after first boot, one app at a time)

Each seam is degrade-clean while blank. For each app: set its `*_BASE_URL` +
`*_SERVICE_TOKEN` in `deploy/.env`, then
`docker compose -f deploy/docker-compose.prod.yml up -d customer-ops-backend`
(**`up -d`, not `restart`** — env only reloads on container recreate).

Order (first → last): Contact-Ops (relationship cockpit; live) → Meeting-Ops
(conversation signal; federation live) → Accounting-Ops (invoicing) →
Outreach/Email-Ops → Agent inference (point `AGENT_INFERENCE_BASE_URL` at the
`uchub-litellm` gateway). Confirm the exact prod base URL for each from its own
runbook before filling.

---

## 8. Smoke test (through Traefik + Cloudflare)

```bash
# Backend health (proves the api. host + DNS-01 TLS + DB up):
curl -fsS https://api.customer-ops.unicorncommander.ai/api/v1/health | jq .       # status:"ok", database:up
curl -fsS https://api.customer-ops.unicorncommander.ai/api/v1/health/live          # {"status":"ok",...}

# Frontend at the root (2-level host, CF edge):
curl -fsS -o /dev/null -w "%{http_code}\n" https://customer-ops.unicorncommander.ai/   # 200

# Confirm the api. host presents a REAL LE cert (DNS-01), like the sibling:
echo | openssl s_client -connect api.customer-ops.unicorncommander.ai:443 \
  -servername api.customer-ops.unicorncommander.ai 2>/dev/null \
  | openssl x509 -noout -issuer -subject   # issuer=Let's Encrypt, CN=api.customer-ops...

# Roles + RLS in the DB:
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -c \
  "select rolname, rolbypassrls from pg_roles where rolname like 'customer_ops%' order by 1;"
#   expect: customer_ops_app=f (NOBYPASSRLS), customer_ops_owner=t (BYPASSRLS)

# Migrations applied:
docker exec customer-ops-backend npx prisma migrate status

# SSO round-trip: browser -> https://customer-ops.unicorncommander.ai -> "Sign in"
#   -> uchub login -> back as OWNER. Confirm the cockpit shows YOUR workspace's
#   data and nothing cross-tenant (the live tenant fence).
```

If `https://api.customer-ops.unicorncommander.ai/api/v1/health` does not resolve
or the TLS handshake fails: (a) confirm the **gray-cloud A record** for
`api.customer-ops` → `72.61.2.67` exists and is **DNS-only** (orange-cloud would
break the DNS-01 origin cert — `dig +short api.customer-ops.unicorncommander.ai`
must return the bare origin `72.61.2.67`, NOT the CF anycast range); (b) confirm
the backend router rule + `certresolver=cloudflare` + `entrypoints=websecure` in
`docker compose -f deploy/docker-compose.prod.yml config`; (c) Traefik mints the
DNS-01 cert on first request — give it ~30s and check `docker logs traefik` for
an ACME error if it doesn't appear.

If the backend **crash-loops with a password/authentication failure** right after
first boot: a migration reset the `customer_ops_app` password to its placeholder
(the step 5 → 6 ordering exists to prevent this — it means the real password was
set before the first migrate ran). Re-assert the real password and recreate:
```bash
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -c \
  "ALTER ROLE customer_ops_app PASSWORD '<CUSTOMER_OPS_APP_DB_PASSWORD>';"
docker compose -f deploy/docker-compose.prod.yml up -d customer-ops-backend
```
Migrations are already applied, so it won't recur.

If the app boots but every list is empty: the runtime is connecting with the
wrong role or `DATABASE_URL`'s `customer_ops_app` password ≠ the role password.
Re-assert it (above) and `up -d customer-ops-backend`.

---

## 9. Rollback

```bash
cd ~/Production/customer-ops

# Stop + remove containers + the app-private net (KEEPS the DB volume):
docker compose -f deploy/docker-compose.prod.yml down

# Roll code back to the previous good ref, rebuild:
git checkout <previous-good-ref>
docker compose -f deploy/docker-compose.prod.yml up -d --build

# Bad MIGRATION (data wrong): restore from a dump — see backup-restore.md §4.
# DESTRUCTIVE (wipes the DB volume — only for a clean re-init):
#   docker compose -f deploy/docker-compose.prod.yml down -v
```

Traefik drops the routes the moment containers stop, so the public host 404s
cleanly after `down`. No Cloudflare/Traefik-side cleanup needed (label-driven).

> **Migration rollbacks are not automatic.** Prisma `migrate deploy` is
> forward-only. To undo a schema change you restore the pre-migration dump
> (`backup-restore.md` §4, Scenario A) and redeploy the prior code. Always take a
> fresh `scripts/backup.sh` immediately before applying a migration that isn't
> additive.

---

## 10. Disaster recovery

Database backup, off-box retention, restore procedures, and the PITR upgrade path
live in **`docs/runbooks/backup-restore.md`**. Install the scheduled backup
(`scripts/backup.sh` at 02:30 cron) as part of go-live — see that runbook §2.

---

## Appendix: API on the SAME 2-level host under `/api` (the commander shape — NOT the centerdeep default)

The **default on centerdeep is the `api.` subdomain** (this runbook + the compose
labels), because it matches the live sibling `project-ops-customer` and the
`cloudflare` DNS-01 resolver mints the 3-level cert for free. If you ever prefer to
collapse onto the single 2-level host under `/api` instead (the commander shape —
e.g. to skip the gray-cloud `api.` DNS record entirely):
1. Rebuild the frontend with
   `NEXT_PUBLIC_API_URL=https://customer-ops.unicorncommander.ai/api/v1`.
2. Set `KEYCLOAK_CALLBACK_URL=https://customer-ops.unicorncommander.ai/api/v1/auth/keycloak/callback`
   + update the KC client redirect URI to that host.
3. Replace the backend router rule with
   `Host(\`customer-ops.unicorncommander.ai\`) && PathPrefix(\`/api\`)` and add
   `priority=100` (so it beats the SPA catch-all on the same host); set the
   frontend router `priority=10`. Keep `entrypoints=websecure` +
   `certresolver=cloudflare` (centerdeep has no `letsencrypt`/HTTP-01 resolver).
4. No new DNS record needed — the 2-level host is already orange-cloud + covered by
   Universal SSL.

The `api.` subdomain split in `docker-compose.prod.yml` is the supported default
precisely because it matches the centerdeep sibling and the DNS-01 resolver makes
the 3-level cert a non-issue.

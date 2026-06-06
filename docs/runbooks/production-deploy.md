# Customer-Ops — Production Deploy Runbook (commander / unicorncommander.ai)

Target: **customer-ops.unicorncommander.ai** on **commander** (Tailscale
`100.79.41.137`, user `muut`, Docker, Traefik v3.6).

This is the **public production** posture — the deltas from the dogfood bring-up
(`deploy/DEPLOY.md`, host bigboy) are:

| | Dogfood (bigboy) | **Production (commander)** |
| --- | --- | --- |
| Host | customer-ops.magicunicorn.dev | **customer-ops.unicorncommander.ai** |
| Tenancy | OFF (runtime = owner) | **ON (runtime = NOBYPASSRLS `customer_ops_app`)** |
| Entitlements | `open` (warn) | **`enforce`** |
| Federation | all seams blank | **wired one app at a time** |
| Compose | `docker-compose.dogfood.yml` | **`docker-compose.prod.yml`** |
| Env | `.env.dogfood.example` | **`.env.prod.example`** |
| Traefik provider | docker labels (bigboy) | **docker labels, network `web` (commander)** |
| Cert resolver | `letsencrypt` (HTTP-01) | `letsencrypt` (+ `letsencrypt-cf` DNS-01 fallback) |

> Read `deploy/DEPLOY.md` first — the app-level mechanics (KC client shape, the
> same-host `/api` routing rationale, the `prisma migrate deploy` boot sequence)
> are identical; this runbook only layers on the production host + the security
> flips + the cross-app dependency order.

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
URIs use the prod host**. On **auth.unicorncommander.ai**, realm **uchub**:

- **Client ID:** `customer-ops`  (confidential, OIDC, **RS256**)
- **Standard flow:** ON. Direct access grants: off.
- **Valid redirect URIs:**
  - `https://customer-ops.unicorncommander.ai/*`
  - `https://customer-ops.unicorncommander.ai/api/v1/auth/keycloak/callback`
    (the exact `KEYCLOAK_CALLBACK_URL`)
- **Valid post-logout redirect URIs:** `https://customer-ops.unicorncommander.ai/*`
- **Web origins:** `https://customer-ops.unicorncommander.ai`
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
uc-registry (uc-ops-center on commander). Ensure the prod workspace exists and the
OWNER users (from `CUSTOMER_OPS_ACCESS_LIST`) are members. `DEFAULT_WORKSPACE_ID`
in `.env` is the seeded bootstrap/owner workspace
(`0190a000-7e57-7000-8000-00000000c007`); for a public multi-tenant posture,
new tenants' workspaces come from uc-registry at sign-in.

*Read-only check:* `uc-ops-center-uc-registry-1` is healthy (`docker ps`). The
workspace/membership provisioning is a **uc-registry operation (Aaron lever)**.

---

## 4. Lago entitlement claim

`UC_ENTITLEMENT_MODE=enforce` makes cross-app + inference gates return 402/403
when Lago (`unicorn-lago-api` on commander) does NOT emit a sufficient
customer-ops entitlement claim. **Bring up the first prod boot in `open`**
(warn-only), confirm the claim flows for your OWNER accounts, THEN flip to
`enforce` and `docker compose ... up -d customer-ops-backend`. Flipping enforce
before the claim exists 402s legitimate users.

---

## 5. DNS (Cloudflare)

**No new DNS record is required.** The Cloudflare wildcard `*.unicorncommander.ai`
already resolves `customer-ops.unicorncommander.ai` to the Cloudflare edge
(verified: `dig +short customer-ops.unicorncommander.ai` returns the CF anycast
IPs `104.21.x` / `172.67.x`, exactly like the live sibling
`projectops.unicorncommander.ai`).

TLS posture — **why customer-ops uses the SAME-HOST `/api` split and a 2-level
host** (the moat detail):
- `customer-ops.unicorncommander.ai` is a **2-level** subdomain → covered by
  Cloudflare's **Universal SSL** wildcard `*.unicorncommander.ai`. A live 2-level
  sibling serves Cloudflare's edge cert (`CN=unicorncommander.ai`, Google Trust
  Services) and returns 200.
- An `api.` **3-level** subdomain (e.g. `api.customer-ops.unicorncommander.ai`)
  is **NOT** covered by Universal SSL — verified: the TLS handshake to the live
  3-level `api.brigade.unicorncommander.ai` returns nothing (broken edge cert).
  project-ops works around this with the `cloudflare` DNS-01 resolver + a
  gray-cloud. **Customer-Ops avoids the gap entirely** by routing its API on the
  same 2-level host under `/api`, which the frontend already bakes
  (`NEXT_PUBLIC_API_URL=.../api/v1`) — zero app rebuild, no second cert.

Cloudflare proxy + origin cert:
- If the record stays **orange-cloud (proxied)**: set the zone SSL mode to
  **Full (strict)** and keep `certresolver=letsencrypt` so the origin presents a
  real LE cert for Cloudflare's origin pull. If Cloudflare intercepts the HTTP-01
  challenge at the origin (it can, for proxied hosts), switch the two routers in
  `docker-compose.prod.yml` to `certresolver=letsencrypt-cf` (the DNS-01 resolver
  already configured in commander's `traefik.yml`, `CF_DNS_API_TOKEN`-backed) so
  the origin cert is minted via DNS and never needs an HTTP path. *(Aaron lever:
  the Cloudflare zone SSL-mode setting + any gray/orange toggle.)*
- If you prefer **gray-cloud (DNS-only)** like `brigade.unicorncommander.ai`:
  point an A record at commander's origin IP and `letsencrypt` (HTTP-01) just
  works (gray-cloud lets the ACME challenge through). This bypasses the CF edge.

---

## 6. First deploy

All commands on **commander** as `muut`.

```bash
# 1. Get the repo next to the siblings:
cd ~/Production
git clone <customer-ops repo URL> customer-ops
cd ~/Production/customer-ops
git checkout <release ref>        # the reviewed prod commit/tag

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

# 5. Set the REAL customer_ops_app password ON THE ROLE (the init script seeds a
#    placeholder). This MUST equal CUSTOMER_OPS_APP_DB_PASSWORD in DATABASE_URL:
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -c \
  "ALTER ROLE customer_ops_app PASSWORD '<CUSTOMER_OPS_APP_DB_PASSWORD>';"

# 6. Bring up the rest (build images + start backend+frontend):
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

What happens on backend start (see the compose `command`):
`DATABASE_URL="$ADMIN_DATABASE_URL" npx prisma migrate deploy` runs the schema +
RLS + grants + seed **as the owner** (the app role is NOBYPASSRLS/NOCREATEDB and
cannot apply DDL), then `node dist/main` boots the app reading the runtime
`DATABASE_URL` (the **app** role). RLS is now live and enforced per request via
the `app.current_workspace` GUC.

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
# Backend health (proves same-host /api routing + TLS + DB up):
curl -fsS https://customer-ops.unicorncommander.ai/api/v1/health | jq .       # status:"ok", database:up
curl -fsS https://customer-ops.unicorncommander.ai/api/v1/health/live          # {"status":"ok",...}

# Frontend at the root:
curl -fsS -o /dev/null -w "%{http_code}\n" https://customer-ops.unicorncommander.ai/   # 200

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

If `/api/v1/health` returns the SPA HTML instead of JSON, the `/api` router lost
to the catch-all — confirm `priority=100` + `PathPrefix(/api)` on the backend
router in `docker compose -f deploy/docker-compose.prod.yml config`.

If the app boots but every list is empty: the runtime is connecting with the
wrong role or `DATABASE_URL`'s `customer_ops_app` password ≠ the role password
(step 5). Re-assert it and `up -d customer-ops-backend`.

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

## Appendix: API on an `api.` subdomain (the project-ops shape — NOT default)

If you ever prefer the project-ops shape
(`api.customer-ops.unicorncommander.ai`), you MUST handle the 3-level Universal
SSL gap (see §5):
1. Rebuild the frontend with
   `NEXT_PUBLIC_API_URL=https://api.customer-ops.unicorncommander.ai/api/v1`.
2. Set `KEYCLOAK_CALLBACK_URL` to that subdomain + add it to the KC client.
3. Replace the backend router rule with
   `Host(\`api.customer-ops.unicorncommander.ai\`)` (drop `&& PathPrefix(/api)`
   + the priority) and set **`certresolver=letsencrypt-cf`** (DNS-01) — HTTP-01
   cannot work behind the Cloudflare proxy for a 3-level host.
4. Gray-cloud the `api.` record OR rely on the DNS-01 origin cert; either way the
   2-level Universal SSL does NOT cover it.

The same-host `/api` split in `docker-compose.prod.yml` is the supported default
precisely because it sidesteps all of this.

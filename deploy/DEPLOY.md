# Customer-Ops — Dogfood Deploy Runbook

Target: **customer-ops.magicunicorn.dev** on **bigboy** (SSH alias `magicunicorn`,
user `muut`, Docker 29, Traefik v3.6 reverse proxy).

This deploys the Phase-1 dogfood posture: single bootstrap workspace, tenancy
OFF, RLS inert (runtime connects as the table owner), all cross-app federation
degrade-clean (blank `*_BASE_URL`), entitlements in `open` (warn-only) mode.

Matched from the live siblings (`project-ops`, `contact-ops`) on the same host:

| Property            | Value                         |
| ------------------- | ----------------------------- |
| Traefik ingress net | `web` (external)              |
| Entrypoint          | `websecure` (443)             |
| TLS cert resolver   | `letsencrypt`                 |
| Frontend route      | `Host(customer-ops.magicunicorn.dev)` -> :3000 |
| Backend route       | same host **`&& PathPrefix(/api)`** (priority 100) -> :3211 |

> **Routing note.** project-ops puts its API on a subdomain
> (`api.projectops.magicunicorn.dev`). Customer-Ops instead routes the API on the
> **same host under `/api`** because the frontend bakes
> `NEXT_PUBLIC_API_URL=https://customer-ops.magicunicorn.dev/api/v1` and the
> Keycloak callback is the path `/api/v1/auth/keycloak/callback` — same-host path
> routing matches the app's own config with zero changes and needs no second
> certificate. (Alternative subdomain wiring is documented at the bottom.)
>
> Wildcard `*.magicunicorn.dev` already resolves to bigboy, so **no DNS change**
> is required for `customer-ops.magicunicorn.dev`.

---

## (a) Prerequisites — do these BEFORE deploying

### 1. Create the Keycloak `customer-ops` client (realm `uchub`)

On **auth.unicorncommander.ai**, realm **uchub**, create an OIDC client:

- **Client ID:** `customer-ops`
- **Client type / access:** OpenID Connect, **confidential** (Client
  authentication ON) — the backend uses client-credentials + an authorization-code
  callback.
- **Signing:** **RS256** (suite default; the backend verifies via the realm JWKS).
- **Standard flow:** ON (authorization code). Direct access grants: off.
- **Valid redirect URIs:**
  - `https://customer-ops.magicunicorn.dev/*`
  - `https://customer-ops.magicunicorn.dev/api/v1/auth/keycloak/callback`
    (the exact `KEYCLOAK_CALLBACK_URL` from `.env`)
- **Valid post-logout redirect URIs:** `https://customer-ops.magicunicorn.dev/*`
- **Web origins:** `https://customer-ops.magicunicorn.dev` (and/or `+`)
- **Audience:** ensure the issued tokens carry `aud=customer-ops` (the backend's
  `BRIGADE_EXPECTED_AUDIENCE`). If your realm doesn't add the client to `aud` by
  default, add an **Audience** mapper (Included Client Audience = `customer-ops`)
  on the client's dedicated scope.
- **Grab the secret:** Credentials tab -> copy the **Client secret** -> this is
  `KEYCLOAK_CLIENT_SECRET` in `.env`.

> Per memory: when a NEW backend scope (`require_scopes`) lands later, you must
> create the scope on Keycloak + assign it as a default-client-scope on this
> client + have the user re-auth. Not needed for the Phase-1 dogfood bring-up.

### 2. Confirm the access list

`CUSTOMER_OPS_ACCESS_LIST` (already set in the env example) grants sign-in + JIT
role:

```
aaron@magicunicorn.tech:OWNER, shafenkhan@users.noreply.github.com:OWNER, *@magicunicorn.tech:MEMBER
```

No Keycloak group wiring is required for this — the app resolves role from the
access list at OIDC-callback time. Just make sure those users exist in the
`uchub` realm and can log in.

### 3. Confirm the ingress network exists (it does)

`web` is the shared external Traefik network already carrying project-ops +
contact-ops. Verify on the host:

```bash
ssh magicunicorn 'docker network inspect web >/dev/null && echo "web OK"'
```

---

## (b) Deploy

All commands run on **bigboy** as `muut`.

### 1. Get the repo onto bigboy

```bash
ssh magicunicorn
# Pick a home for it next to the siblings:
cd ~
git clone <customer-ops repo URL> customer-ops      # or: pull an existing checkout
cd ~/customer-ops
git checkout feat/phase1-stunning-gui               # the dogfood branch
```

> If you copy from the worktree instead of cloning, make sure the whole repo is
> present (the compose build contexts are `../backend`, `../frontend`, and the DB
> init mount is `../infrastructure/database/init` — all relative to `deploy/`).

### 2. Write the env file + generate secrets

```bash
cd ~/customer-ops
cp deploy/.env.dogfood.example deploy/.env

# Generate the three secrets:
openssl rand -base64 32   # -> POSTGRES_PASSWORD (paste into POSTGRES_PASSWORD,
                          #    DATABASE_URL, and ADMIN_DATABASE_URL — same value)
openssl rand -base64 64   # -> JWT_SECRET

# Then edit deploy/.env and fill:
#   POSTGRES_PASSWORD + the two DB URLs  (the rand-base64-32 value, 3 places)
#   JWT_SECRET                           (the rand-base64-64 value)
#   KEYCLOAK_CLIENT_SECRET               (from the KC client, step a.1)
nano deploy/.env
```

> The `:` and `/` chars are URL-safe in a userinfo password, but `+` and `=` from
> base64 are fine inside a `.env` value and inside the DATABASE_URL here (no shell
> expansion — `env_file` reads literally). If you'd rather avoid `+`/`/` in the URL
> entirely, use `openssl rand -hex 24` for `POSTGRES_PASSWORD`.

### 3. Bring it up (build + start)

Run from the **repo root** so the `../backend` / `../frontend` build contexts
resolve:

```bash
cd ~/customer-ops
docker compose -f deploy/docker-compose.dogfood.yml up -d --build
```

This will:
1. build the backend + frontend images (frontend bakes `NEXT_PUBLIC_API_URL`),
2. start `customer-ops-postgres` and wait for it to be **healthy** (first boot
   runs `infrastructure/database/init/01-init.sql` — role split + extensions),
3. start `customer-ops-backend`, whose entrypoint runs
   `npx prisma migrate deploy` (applies the schema + RLS + grants + seeds the
   bootstrap workspace) then `node dist/main`,
4. start `customer-ops-frontend`,
5. Traefik auto-discovers the labels and provisions the LE cert for the host.

---

## (c) Post-deploy verification

```bash
# 1. All three containers up + healthy
docker compose -f deploy/docker-compose.dogfood.yml ps

# 2. Migrations applied (expect a list ending at 20260603202000_suite_tenancy_rls_roles)
docker exec customer-ops-backend npx prisma migrate status

# 3. Roles + RLS exist in the DB
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -c \
  "select rolname, rolbypassrls from pg_roles where rolname like 'customer_ops%' order by 1;"
# expect: customer_ops_app=f (NOBYPASSRLS), customer_ops_owner=t (BYPASSRLS)
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -c \
  "select relname, relrowsecurity, relforcerowsecurity from pg_class where relname='customers';"
# expect: customers | t | t

# 4. Bootstrap workspace seeded
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -c \
  "select id, slug from workspaces where id='0190a000-7e57-7000-8000-00000000c007';"

# 5. Backend health THROUGH Traefik (proves same-host /api routing + TLS)
curl -fsS https://customer-ops.magicunicorn.dev/api/v1/health | jq .
# expect status:"ok" with database:up
curl -fsS https://customer-ops.magicunicorn.dev/api/v1/health/live   # {"status":"ok",...}

# 6. Frontend served at the root
curl -fsS -o /dev/null -w "%{http_code}\n" https://customer-ops.magicunicorn.dev/   # 200

# 7. SSO round-trip: browser -> https://customer-ops.magicunicorn.dev -> "Sign in"
#    -> uchub login -> back to /auth/sso-callback?token=... -> logged in as OWNER.
```

If `curl .../api/v1/health` returns the SPA HTML instead of JSON, the `/api`
router priority lost to the catch-all — confirm the backend router has
`priority=100` and `PathPrefix(/api)` in `docker compose ... config`.

### Later: go-live toggles (when promoting past dogfood)

Do these as a deliberate, separately-reviewed change — **not** at first bring-up:

1. **Wire federation, one app at a time.** For each app you connect, set its
   `*_BASE_URL` (+ `*_SERVICE_TOKEN`) in `deploy/.env`. Contact-Ops is the first
   (it's live on bigboy): `CONTACT_OPS_BASE_URL=https://mcp.contacts.magicunicorn.dev`
   (confirm the exact MCP base) + a service token. Then:
   `docker compose -f deploy/docker-compose.dogfood.yml up -d backend`.
2. **Turn the tenant fence live** (the security flip — do both together):
   - point the runtime at the NOBYPASSRLS role:
     `DATABASE_URL=postgresql://localhost:5432/customer_ops<app-pw>@customer-ops-postgres:5432/customerops?schema=public`
     (set the `customer_ops_app` password out-of-band first:
     `docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -c "ALTER ROLE customer_ops_app PASSWORD '<app-pw>';"`),
   - keep `ADMIN_DATABASE_URL` on `customer_ops_admin` (migrations stay on the
     owner / BYPASSRLS),
   - set `CUSTOMER_OPS_TENANCY_ENABLED=true`,
   - `docker compose -f deploy/docker-compose.dogfood.yml up -d backend` and
     re-run the verification SQL + an authed request to confirm rows still
     resolve and cross-tenant reads are now fenced.
3. **Enforce entitlements:** once Lago emits the claim, set
   `UC_ENTITLEMENT_MODE=enforce` and recycle the backend.

Each toggle is a backend-only `up -d backend` (env reloads on recreate — use
`up -d`, NOT `restart`, or the new env is not picked up).

---

## (d) Rollback

```bash
cd ~/customer-ops

# Stop + remove the containers + the app-private network (KEEPS the DB volume):
docker compose -f deploy/docker-compose.dogfood.yml down

# Roll back code: redeploy the previous image/commit, then up -d --build again.
git checkout <previous-good-ref>
docker compose -f deploy/docker-compose.dogfood.yml up -d --build

# DESTRUCTIVE (wipes the database too — only for a clean re-init):
# docker compose -f deploy/docker-compose.dogfood.yml down -v
```

Traefik drops the routes the moment the containers stop, so the public host
404s cleanly after `down`. No DNS or Traefik-side cleanup is needed (everything
is label-driven on the app containers).

---

## Alternative: API on a subdomain (matching project-ops exactly)

If you later prefer the project-ops shape (`api.customer-ops.magicunicorn.dev`):

1. Rebuild the frontend with
   `NEXT_PUBLIC_API_URL=https://api.customer-ops.magicunicorn.dev/api/v1`.
2. Set `KEYCLOAK_CALLBACK_URL` to the full absolute URL on that subdomain and add
   it to the KC client's redirect URIs (`KEYCLOAK_CALLBACK_URL` is consumed as
   the passport `callbackURL`; the strategy reads it directly).
3. Replace the backend's router rule with
   `Host(\`api.customer-ops.magicunicorn.dev\`)` (drop the `&& PathPrefix(/api)`
   and the `priority`), keeping `websecure` + `letsencrypt`, and add a
   `projectops-cors`-style Traefik headers middleware if you want CORS at the edge.
4. `api.customer-ops.magicunicorn.dev` is a 3-level host; on `magicunicorn.dev`
   the LE per-host challenge works (project-ops already runs
   `api.projectops.magicunicorn.dev`), so no wildcard-SSL gap like the
   `unicorncommander.ai` 3-level case.

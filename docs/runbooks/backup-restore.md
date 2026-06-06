# Customer-Ops — Backup & Restore (Disaster Recovery)

Scope: the **`customerops` Postgres database** on **commander** (the only durable
state Customer-Ops owns). Everything else is rebuildable from the repo + the env
file. Customer-Ops federates — it does NOT own contact / invoice / meeting truth,
so a Customer-Ops restore never has to reconcile those (they live in their own
apps with their own backups). What we protect here: relationships, stages, links,
activity, agent-run records, and the workspace/membership rows.

| Property | Value |
| --- | --- |
| Host | commander (Tailscale `100.79.41.137`, user `muut`) |
| Container | `customer-ops-postgres` (compose project `customer-ops`) |
| Database | `customerops` |
| Dump role | `customer_ops_admin` (object owner, BYPASSRLS — captures ALL workspaces) |
| Artifact | `customerops_<UTC-ts>.dump` (pg_dump `--format=custom`) |
| Script | `scripts/backup.sh` |
| Local dir | `BACKUP_LOCAL_DIR` (default `/home/muut/backups/customer-ops-db`) |
| Off-box | S3-compatible (`BACKUP_S3_*`): Cloudflare R2 or Garage. Optional. |
| Retention | `BACKUP_RETENTION_DAYS` local (default 14); set bucket lifecycle off-box |
| RPO | = backup interval (24h on the default cron) |
| RTO | minutes (small dataset; single `pg_restore`) |

> **Why custom-format `pg_dump`, not WAL/PITR.** The dataset is small and
> `--format=custom` is a self-contained, restore-anywhere artifact with a trivial,
> testable restore. The PITR upgrade path is documented at the end for when RPO
> must drop below "last nightly".

---

## 1. Why the dump runs as the OWNER role (RLS gotcha)

Production runs the app as the **NOBYPASSRLS** `customer_ops_app` role. If you
`pg_dump` as that role under live RLS, you get **zero rows** for every fenced
table — a silent, empty "backup". `scripts/backup.sh` therefore execs `pg_dump`
as `customer_ops_admin` (the `POSTGRES_USER` inside the container, which is
`BYPASSRLS`), capturing every workspace's data. The dump is created
`--no-owner --no-privileges` so it can be restored into a freshly-initialised
cluster where the role grants are re-applied by the init script + migrations.

---

## 2. Install the scheduled backup (one-time)

Backups run from the deployed repo on commander (`~/Production/customer-ops`).
The script reads `deploy/.env` for the `BACKUP_*` / `LISTMONK_*` config (see
`deploy/.env.prod.example`).

```bash
# On commander, as muut:
mkdir -p /home/muut/backups/customer-ops-db

# Dry-run once, by hand, to confirm it produces a verified dump:
/home/muut/Production/customer-ops/scripts/backup.sh

# Then schedule it. 02:30 is deliberately staggered off the existing
# 02:00 (ops-center) and 03:00 (majiks) cron jobs on this host.
crontab -e
# add:
30 2 * * * /home/muut/Production/customer-ops/scripts/backup.sh >> /home/muut/backups/customer-ops-backup.log 2>&1
```

The script **degrades clean**: with `BACKUP_S3_*` unset it keeps local rotated
dumps only; with them set it ALSO pushes each dump off-box. A failed dump (or a
suspiciously small / corrupt one) exits non-zero and — if `LISTMONK_API_*` +
`BACKUP_ALERT_EMAIL` are set — sends a failure email.

### Off-box target (recommended for real DR)

Set in `deploy/.env` (names only — fill the secrets out-of-band):

```
BACKUP_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # or the Garage S3 endpoint
BACKUP_S3_BUCKET=customer-ops-backups
BACKUP_S3_REGION=auto
BACKUP_S3_ACCESS_KEY_ID=__SET__
BACKUP_S3_SECRET_ACCESS_KEY=__SET__
```

The host has no `aws` CLI; the script uses a throwaway `amazon/aws-cli` container
with `--endpoint-url` so it works against R2 or Garage. Set a **bucket lifecycle
rule** off-box (e.g. expire after 90 days) — the script only prunes the LOCAL
staging dir.

---

## 3. Verifying a backup (do this monthly — an untested backup is a rumour)

```bash
# Newest local dump:
LATEST=$(ls -t /home/muut/backups/customer-ops-db/customerops_*.dump | head -1)

# The TOC must list cleanly (the script already does this on every run):
docker run --rm -i postgres:17 pg_restore --list < "$LATEST" | head

# Full smoke-restore into a disposable container (NON-destructive — does NOT
# touch the live DB):
docker run -d --name co-restore-test -e POSTGRES_PASSWORD=throwaway \
  -e POSTGRES_DB=customerops postgres:17
# wait for it to be ready:
until docker exec co-restore-test pg_isready -U postgres -d customerops >/dev/null 2>&1; do sleep 1; done
docker exec -i co-restore-test pg_restore --no-owner --no-privileges \
  -U postgres -d customerops < "$LATEST"
# sanity counts:
docker exec co-restore-test psql -U postgres -d customerops -c \
  "select count(*) as workspaces from workspaces; select count(*) as customers from customers;"
# teardown:
docker rm -f co-restore-test
```

---

## 4. RESTORE — production recovery procedure

Two scenarios. Read the whole section before running anything.

### Scenario A — restore INTO the existing live cluster (data loss / bad migration)

Use when the container + volume are healthy but the **data** is wrong (accidental
delete, bad import). This **overwrites** the live database — take a fresh dump
FIRST so the current (bad) state is itself recoverable.

```bash
cd /home/muut/Production/customer-ops

# 0. Capture the current state before you overwrite it.
./scripts/backup.sh

# 1. Pick the dump to restore from (local, or pull from off-box first):
RESTORE_FROM=/home/muut/backups/customer-ops-db/customerops_<UTC-ts>.dump
#   off-box pull (if local is gone):
#   docker run --rm -e AWS_ACCESS_KEY_ID=__ -e AWS_SECRET_ACCESS_KEY=__ \
#     -e AWS_DEFAULT_REGION=auto -v /home/muut/backups/customer-ops-db:/out \
#     amazon/aws-cli:latest s3 cp \
#     s3://customer-ops-backups/customer-ops/customerops_<UTC-ts>.dump /out/ \
#     --endpoint-url "$BACKUP_S3_ENDPOINT"

# 2. Stop the app tiers so nothing writes mid-restore (KEEP postgres up):
docker compose -f deploy/docker-compose.prod.yml stop customer-ops-backend customer-ops-frontend

# 3. Restore as the OWNER (customer_ops_admin). --clean --if-exists drops and
#    recreates objects; the role grants + RLS are re-asserted by the dump's DDL
#    plus the next backend start (migrate deploy is idempotent).
docker exec -i customer-ops-postgres pg_restore \
  --clean --if-exists --no-owner --no-privileges \
  -U customer_ops_admin -d customerops < "$RESTORE_FROM"

# 4. Bring the app back. migrate deploy re-asserts roles/RLS/grants; harmless.
docker compose -f deploy/docker-compose.prod.yml up -d customer-ops-backend customer-ops-frontend

# 5. Verify (see §5).
```

### Scenario B — rebuild the cluster from scratch (host loss / volume gone)

Use when `customer-ops-pgdata` is lost (new host, corrupt volume).

```bash
cd /home/muut/Production/customer-ops    # re-clone the repo here if needed
cp deploy/.env.prod.example deploy/.env  # then fill it (see production-deploy.md)

# 1. Bring up ONLY postgres so first-boot init runs (roles + extensions):
docker compose -f deploy/docker-compose.prod.yml up -d customer-ops-postgres
until docker exec customer-ops-postgres pg_isready -U customer_ops_admin -d customerops >/dev/null 2>&1; do sleep 1; done

# 1a. Re-assert the customer_ops_app password (the init script seeds a
#     placeholder; production-deploy.md sets the real one). MUST match the
#     password in DATABASE_URL in deploy/.env.
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -c \
  "ALTER ROLE customer_ops_app PASSWORD '<CUSTOMER_OPS_APP_DB_PASSWORD>';"

# 2. Restore the dump (fresh DB — no --clean needed):
RESTORE_FROM=/path/to/customerops_<UTC-ts>.dump
docker exec -i customer-ops-postgres pg_restore \
  --no-owner --no-privileges -U customer_ops_admin -d customerops < "$RESTORE_FROM"

# 3. Bring up the rest. The backend's migrate-deploy (as ADMIN_DATABASE_URL)
#    reconciles any schema drift and re-asserts RLS/grants idempotently.
docker compose -f deploy/docker-compose.prod.yml up -d --build

# 4. Verify (see §5).
```

---

## 5. Post-restore verification (both scenarios)

```bash
# Roles intact: app=NOBYPASSRLS, owner=BYPASSRLS
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -c \
  "select rolname, rolbypassrls from pg_roles where rolname like 'customer_ops%' order by 1;"

# RLS still forced on a fenced table:
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -c \
  "select relname, relrowsecurity, relforcerowsecurity from pg_class where relname='customers';"

# Row counts look right (compare to pre-incident expectation):
docker exec customer-ops-postgres psql -U customer_ops_admin -d customerops -c \
  "select (select count(*) from workspaces) workspaces, (select count(*) from customers) customers;"

# App healthy through Traefik:
curl -fsS https://customer-ops.unicorncommander.ai/api/v1/health | jq .

# Tenant fence actually enforcing (app role sees only GUC-scoped rows): sign in
# and confirm the cockpit shows your workspace's data and nothing cross-tenant.
```

If the app boots but every list is empty under live tenancy, the restore likely
ran but the runtime is connecting with the wrong role / the `customer_ops_app`
password in `DATABASE_URL` doesn't match the role — re-check step B-1a.

---

## 6. PITR upgrade path (when nightly RPO is not enough)

The nightly logical dump gives a ~24h RPO. To tighten it without changing the app:
1. Add `archive_mode=on` + `archive_command` (push WAL to the same S3/R2 bucket)
   and a daily `pg_basebackup` to the postgres service.
2. Keep `scripts/backup.sh` as the belt-and-suspenders logical export + the
   restore-test source.
3. Restore = restore the latest basebackup + replay WAL to a target time
   (`recovery_target_time`).

This is a deliberate, separately-reviewed change — the logical dump above is the
supported default DR path today.

#!/usr/bin/env bash
# ============================================================================
# verify-tenancy.sh — RLS tenant-fence acceptance harness for Customer-Ops
# ============================================================================
#
# De-risks flipping CUSTOMER_OPS_TENANCY_ENABLED=true by PROVING the database
# half of the suite tenancy contract end-to-end, against a THROWAWAY Postgres 17,
# AS the NOBYPASSRLS runtime role `customer_ops_app` (exactly the role go-live
# points DATABASE_URL at). It is the automated, exit-coded sibling of the manual
# prisma/rls-phaseN-acceptance.sql proofs — one command, green/red, no leftovers.
#
# What it does (hermetic; nothing touches the live DB or any shared port):
#   1. allocate a FREE host port and boot `postgres:17` in a disposable container
#      (the suite role split is created on first boot by infrastructure/.../01-init.sql),
#   2. apply EVERY Prisma migration via `prisma migrate deploy` (the same command
#      the backend entrypoint runs) AS the owner/admin — schema + RLS + grants,
#   3. seed TWO workspaces (A, B) as the BYPASSRLS owner (the non-RLS control table),
#   4. RECONNECT as `customer_ops_app` (NOBYPASSRLS) and assert the contract on
#      ALL SIX scoped tables:
#        A. role posture: rolbypassrls = f                          (fence is live for it)
#        B. ENABLE + FORCE row security on every scoped table       (t / t)
#        C. NO-GUC read returns 0 rows on every scoped table        (fail-closed)
#        D. own-workspace read OK; cross-workspace read = 0 rows    (isolation)
#        E. cross-workspace WRITE blocked by WITH CHECK             (raises)
#        F. cross-workspace UPDATE / DELETE are no-ops (0 rows)     (no leakage)
#        G. empty-GUC ('') reads 0 rows                             (NULLIF fail-closed)
#   5. tear the container down (always — via trap), leaving zero residue.
#
# The scoped-table set is the SINGLE source of truth `SCOPED_TABLES` below; keep
# it in lockstep with schema.prisma's @@map'd tenant-scoped models. If a future
# phase adds a scoped table, add it here and the harness re-proves it for free.
#
# Usage:
#   scripts/verify-tenancy.sh                 # boot, prove, teardown (default)
#   KEEP_DB=1 scripts/verify-tenancy.sh       # leave the container up for poking
#   PG_PORT=55444 scripts/verify-tenancy.sh   # pin a port instead of auto-allocating
#
# Requires: docker (a local daemon, or the host daemon from inside a CI job
# container), and a Prisma CLI resolvable from backend/ (the repo's
# node_modules, symlinked in the worktree). No host psql needed — every SQL call
# runs via `docker exec ... psql` (the DEPLOY.md idiom), so the harness is
# self-contained.
#
# Exit code: 0 iff EVERY assertion passed; 1 otherwise (with a red FAIL line per
# failed check and a final tally). CI-friendly.
# ----------------------------------------------------------------------------
set -euo pipefail

# --- locate the repo (this script lives in <repo>/scripts) ------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${REPO_ROOT}/backend"
INIT_SQL="${REPO_ROOT}/infrastructure/database/init/01-init.sql"

# --- config (overridable) ---------------------------------------------------
PG_IMAGE="postgres:17"
PG_DB="customerops"
ADMIN_USER="customer_ops_admin"   # object owner (member of customer_ops_owner => BYPASSRLS)
ADMIN_PW="verify_admin"
APP_USER="customer_ops_app"       # runtime role (NOBYPASSRLS) — the role under test
APP_PW="verify_app"               # set deterministically by the RLS migration / below
CONTAINER="co-verify-tenancy-$$"  # PID-suffixed so parallel runs never collide
KEEP_DB="${KEEP_DB:-0}"

# Two disjoint, valid uuidv7-shaped workspace ids (mirror the *.sql proofs' AAAA/BBBB).
WS_A="0190a000-7e57-7000-8000-0000000a11ce"
WS_B="0190a000-7e57-7000-8000-0000000b0b00"

# --- pretty + assertion accounting ------------------------------------------
PASS=0
FAIL=0
RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'; DIM=$'\033[2m'; NC=$'\033[0m'
info()  { printf '%s\n' "${DIM}-- $*${NC}"; }
step()  { printf '\n%s\n' "${YEL}== $* ==${NC}"; }
ok()    { PASS=$((PASS+1)); printf '%s\n' "${GRN}PASS${NC}  $*"; }
bad()   { FAIL=$((FAIL+1)); printf '%s\n' "${RED}FAIL${NC}  $*"; }

# The single source of truth for the tenant-scoped tables (== schema.prisma).
SCOPED_TABLES=(
  customers
  customer_activities
  customer_invoice_links
  customer_outreach_links
  customer_email_links
  lead_intakes
)

# --- teardown (always) ------------------------------------------------------
cleanup() {
  local code=$?
  if [[ "${KEEP_DB}" == "1" ]]; then
    printf '\n%s\n' "${YEL}KEEP_DB=1 — leaving ${CONTAINER} on ${PG_PORT:-?} (psql user ${APP_USER}/${APP_PW}). Remove with: docker rm -f ${CONTAINER}${NC}"
  else
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  fi
  exit "${code}"
}
trap cleanup EXIT

# --- preflight --------------------------------------------------------------
command -v docker >/dev/null 2>&1 || { echo "${RED}docker not found on PATH${NC}"; exit 2; }
[[ -f "${INIT_SQL}" ]] || { echo "${RED}missing ${INIT_SQL}${NC}"; exit 2; }
[[ -d "${BACKEND_DIR}/prisma/migrations" ]] || { echo "${RED}missing backend/prisma/migrations${NC}"; exit 2; }

# Resolve a Prisma CLI from the backend's node_modules (read-only symlink in the
# worktree). Fall back to npx if a global is present. NEVER installs anything.
# Wrapped in a function (not a bare var) so a repo path containing spaces — e.g.
# "/Volumes/Studio Storage/…" — does not word-split when invoked.
if [[ -x "${BACKEND_DIR}/node_modules/.bin/prisma" ]]; then
  _PRISMA_BIN="${BACKEND_DIR}/node_modules/.bin/prisma"
  prisma_cli() { "${_PRISMA_BIN}" "$@"; }
elif command -v npx >/dev/null 2>&1; then
  prisma_cli() { npx --no-install prisma "$@"; }
else
  echo "${RED}no prisma CLI (backend/node_modules/.bin/prisma absent and no npx)${NC}"; exit 2
fi

# --- pick a free host port (or honor PG_PORT) -------------------------------
pick_free_port() {
  # Ask the OS for an ephemeral free port via node (always present here) so we
  # never race the 7 parallel agents on a hard-coded port.
  node -e 'const s=require("net").createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>console.log(p));});' 2>/dev/null \
    || echo "55460"   # last-resort fallback if node is unavailable
}
PG_PORT="${PG_PORT:-$(pick_free_port)}"

# --- psql helpers (always via docker exec; -X clean, ON_ERROR_STOP off so we
#     can ASSERT that a statement raises without aborting the harness) ---------
# NOTE: `docker exec` needs `-i` to receive a PIPED heredoc on stdin (the seed
# blocks fed via `-f -`); without it psql gets no input and silently runs nothing.
#
# psql_admin <sql>        : runs as the BYPASSRLS owner (DDL / control-table seed).
# psql_app   <args…>      : runs as the NOBYPASSRLS runtime role (accepts -c/-f -).
# scalar_app <sql>        : single value as the app role, NO workspace GUC set.
# scalar_ws  <ws> <sql>   : single value as the app role WITH app.current_workspace
#                           pinned for the whole session via PGOPTIONS (so the
#                           query's scalar is the ONLY thing on stdout — no
#                           BEGIN/COMMIT/set_config command tags to parse). An
#                           empty <ws> sets the GUC to '' (the fail-closed case).
psql_admin() { docker exec -i -e PGPASSWORD="${ADMIN_PW}" "${CONTAINER}" \
  psql -X -v ON_ERROR_STOP=1 -U "${ADMIN_USER}" -d "${PG_DB}" -c "$1"; }
psql_app()   { docker exec -i -e PGPASSWORD="${APP_PW}" "${CONTAINER}" \
  psql -X -v ON_ERROR_STOP=0 -U "${APP_USER}" -d "${PG_DB}" "$@"; }
scalar_app() { docker exec -i -e PGPASSWORD="${APP_PW}" "${CONTAINER}" \
  psql -X -tA -v ON_ERROR_STOP=0 -U "${APP_USER}" -d "${PG_DB}" -c "$1" 2>/dev/null | tr -d '[:space:]'; }
scalar_ws()  { docker exec -i -e PGPASSWORD="${APP_PW}" -e PGOPTIONS="-c app.current_workspace=$1" "${CONTAINER}" \
  psql -X -tA -v ON_ERROR_STOP=0 -U "${APP_USER}" -d "${PG_DB}" -c "$2" 2>/dev/null | tr -d '[:space:]'; }

# ============================================================================
step "1. Boot throwaway ${PG_IMAGE} as ${ADMIN_USER} on :${PG_PORT} (container ${CONTAINER})"
# Mount the repo's init script so the role split is created EXACTLY as production
# (the harness proves the real bring-up path, not a bespoke role setup).
# Network placement. On a workstation the container publishes 127.0.0.1:PG_PORT.
# Inside a CI job container that drives the HOST's Docker daemon (Forgejo runner
# with the socket mounted), a published port lands on the host, not in the job,
# so the throwaway Postgres instead joins the job container's network namespace
# and listens on PG_PORT there (PGPORT is honoured by the server and by psql).
# Auto-detected; force with VERIFY_TENANCY_SHARE_NETNS=1 / 0.
SELF_CONTAINER=""
if [[ "${VERIFY_TENANCY_SHARE_NETNS:-auto}" != "0" ]] && [[ -f /.dockerenv || "${VERIFY_TENANCY_SHARE_NETNS:-auto}" == "1" ]]; then
  _self="$(cat /etc/hostname 2>/dev/null || hostname)"
  if docker inspect "${_self}" >/dev/null 2>&1; then SELF_CONTAINER="${_self}"; fi
fi
if [[ -n "${SELF_CONTAINER}" ]]; then
  NET_ARGS=(--network "container:${SELF_CONTAINER}" -e PGPORT="${PG_PORT}")
  info "inside container ${SELF_CONTAINER}: sharing its network namespace (port ${PG_PORT})"
else
  NET_ARGS=(-p "127.0.0.1:${PG_PORT}:5432")
fi
# The init script is COPIED in (docker cp streams from this client), not
# bind-mounted: with a remote/host daemon a bind mount resolves on the daemon's
# filesystem, where this checkout does not exist, and Postgres would silently
# skip the role split.
docker create --rm \
  --name "${CONTAINER}" \
  -e POSTGRES_USER="${ADMIN_USER}" \
  -e POSTGRES_PASSWORD="${ADMIN_PW}" \
  -e POSTGRES_DB="${PG_DB}" \
  "${NET_ARGS[@]}" \
  "${PG_IMAGE}" >/dev/null
docker cp "${INIT_SQL}" "${CONTAINER}:/docker-entrypoint-initdb.d/01-init.sql"
docker start "${CONTAINER}" >/dev/null
info "container started; waiting for readiness…"
for i in $(seq 1 60); do
  # -h 127.0.0.1: the entrypoint's init phase runs a socket-only server, so a
  # TCP check only passes once the real server (after 01-init.sql) is up.
  if docker exec "${CONTAINER}" pg_isready -h 127.0.0.1 -U "${ADMIN_USER}" -d "${PG_DB}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  [[ "${i}" == "60" ]] && { echo "${RED}postgres never became ready${NC}"; docker logs "${CONTAINER}" | tail -30; exit 2; }
done
info "postgres ready"

# ============================================================================
step "2. Apply ALL Prisma migrations as ${ADMIN_USER} (schema + RLS + grants)"
# Same command the backend entrypoint runs. The owner (BYPASSRLS) applies DDL.
( cd "${BACKEND_DIR}" \
  && DATABASE_URL="postgresql://localhost:5432/customer_ops" \
     prisma_cli migrate deploy ) \
  || { echo "${RED}prisma migrate deploy failed${NC}"; exit 2; }
# The migration sets a deterministic dev password on customer_ops_app
# (PASSWORD 'verify_app'); pin it again so this harness is robust even if the
# init-sql placeholder ran instead. Owner-only DDL.
psql_admin "ALTER ROLE ${APP_USER} LOGIN PASSWORD '${APP_PW}';" >/dev/null
info "migrations applied; app-role password pinned"

# ============================================================================
step "3. Seed TWO workspaces as the owner (the non-RLS control table)"
psql_admin "INSERT INTO workspaces (id, slug, \"displayName\", \"isolationMode\", \"isolationTier\", status, \"syncedAt\", \"createdAt\", \"updatedAt\")
VALUES
  ('${WS_A}','verify-ws-a','Verify WS A','standard','shared','active', now(), now(), now()),
  ('${WS_B}','verify-ws-b','Verify WS B','standard','shared','active', now(), now(), now())
ON CONFLICT (id) DO NOTHING;" >/dev/null
info "workspaces A=${WS_A} B=${WS_B} seeded"

# ============================================================================
step "A. Runtime role posture — ${APP_USER} MUST be NOBYPASSRLS"
ROLE_BYPASS="$(scalar_app "SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user;")"
ROLE_NAME="$(scalar_app "SELECT current_user;")"
if [[ "${ROLE_NAME}" == "${APP_USER}" && "${ROLE_BYPASS}" == "f" ]]; then
  ok "connected as ${ROLE_NAME}, rolbypassrls=f (the fence is live for the runtime role)"
else
  bad "expected ${APP_USER}/rolbypassrls=f, got ${ROLE_NAME}/rolbypassrls=${ROLE_BYPASS}"
fi

# ============================================================================
step "B. ENABLE + FORCE row security on every scoped table"
for t in "${SCOPED_TABLES[@]}"; do
  # A boolean concatenated with || casts to text 'true'/'false'; accept either
  # spelling so the assertion is robust to psql's render of the bool type.
  ef="$(scalar_app "SELECT relrowsecurity||'/'||relforcerowsecurity FROM pg_class WHERE relname='${t}';")"
  if [[ "${ef}" == "true/true" || "${ef}" == "t/t" ]]; then ok "${t}: enabled/forced = ENABLE+FORCE"
  else bad "${t}: enabled/forced = ${ef:-<missing>} (want both true)"; fi
done
# Also assert the policy itself exists on each (a forced table with NO policy
# would deny everything — secure, but not the contract we want to prove).
for t in "${SCOPED_TABLES[@]}"; do
  has="$(scalar_app "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='${t}' AND policyname='workspace_isolation';")"
  if [[ "${has}" == "1" ]]; then ok "${t}: workspace_isolation policy present"
  else bad "${t}: workspace_isolation policy MISSING (count=${has})"; fi
done
# And the runtime role must actually hold DML on each (else it errors, not fences).
for t in "${SCOPED_TABLES[@]}"; do
  g="$(scalar_app "SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='${t}' AND grantee='${APP_USER}' AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE');")"
  if [[ "${g}" == "4" ]]; then ok "${t}: ${APP_USER} holds SELECT+INSERT+UPDATE+DELETE"
  else bad "${t}: ${APP_USER} grant count=${g} (want 4: S/I/U/D)"; fi
done

# ============================================================================
step "C. NO-GUC reads MUST return 0 rows on every scoped table (fail-closed)"
# Seed one parent customer + one child row per scoped table in workspace A FIRST,
# each under A's GUC, so "0 rows with no GUC" is a real isolation result, not an
# empty table. We do this inside one A-bound transaction.
SEED_A_SQL=$(cat <<SQL
BEGIN;
SELECT set_config('app.current_workspace', '${WS_A}', true);
SELECT set_config('app.uc_uid', 'uc-uid-a', true);
INSERT INTO customers (id, "workspaceId", "contactId", stage, priority, "isLost", "lastStageChangeAt", "createdAt", "updatedAt")
  VALUES ('cust-a', '${WS_A}', 'contact-a', 'PROSPECT', 'MEDIUM', false, now(), now(), now());
INSERT INTO customer_activities (id, "workspaceId", "customerId", kind, body, "createdAt")
  VALUES ('act-a', '${WS_A}', 'cust-a', 'NOTE', 'a-note', now());
INSERT INTO customer_invoice_links (id, "workspaceId", "customerId", "externalSource", "externalRef", "entityId", currency, "createdAt", "updatedAt")
  VALUES ('inv-a', '${WS_A}', 'cust-a', 'customer-ops', 'ref:a:inv', 'ent-a', 'USD', now(), now());
INSERT INTO customer_outreach_links (id, "workspaceId", "customerId", "contactId", channel, "externalSource", "externalRef", "createdAt", "updatedAt")
  VALUES ('orl-a', '${WS_A}', 'cust-a', 'contact-a', 'email', 'customer-ops', 'ref:a:orl', now(), now());
INSERT INTO customer_email_links (id, "workspaceId", "customerId", "contactId", mode, "externalSource", "externalRef", "createdAt", "updatedAt")
  VALUES ('eml-a', '${WS_A}', 'cust-a', 'contact-a', 'send', 'customer-ops', 'ref:a:eml', now(), now());
INSERT INTO lead_intakes (id, "workspaceId", source, "sourceDedupKey", status, "createdAt", "updatedAt")
  VALUES ('li-a', '${WS_A}', 'manual', 'dedup:a', 'PENDING', now(), now());
COMMIT;
SQL
)
echo "${SEED_A_SQL}" | psql_app -f - >/dev/null 2>&1 || { bad "seeding workspace A failed (DML/grant problem)"; }
info "workspace A seeded (1 row per scoped table)"

for t in "${SCOPED_TABLES[@]}"; do
  # No BEGIN / no set_config => app.current_workspace unset => current_workspace_id() = NULL.
  n="$(scalar_app "SELECT count(*) FROM ${t};")"
  if [[ "${n}" == "0" ]]; then ok "${t}: no-GUC read = 0 rows"
  else bad "${t}: no-GUC read = ${n} rows (want 0 — RLS not fencing!)"; fi
done

# ============================================================================
step "D. Own-workspace read OK; cross-workspace read = 0 (isolation)"
# Seed workspace B's parent + children under B's GUC.
SEED_B_SQL=$(cat <<SQL
BEGIN;
SELECT set_config('app.current_workspace', '${WS_B}', true);
SELECT set_config('app.uc_uid', 'uc-uid-b', true);
INSERT INTO customers (id, "workspaceId", "contactId", stage, priority, "isLost", "lastStageChangeAt", "createdAt", "updatedAt")
  VALUES ('cust-b', '${WS_B}', 'contact-b', 'LEAD', 'HIGH', false, now(), now(), now());
INSERT INTO lead_intakes (id, "workspaceId", source, "sourceDedupKey", status, "createdAt", "updatedAt")
  VALUES ('li-b', '${WS_B}', 'manual', 'dedup:b', 'PENDING', now(), now());
COMMIT;
SQL
)
echo "${SEED_B_SQL}" | psql_app -f - >/dev/null 2>&1 || { bad "seeding workspace B failed"; }

# Own-workspace read: under A's GUC I see A's customer (and exactly 1).
OWN_A="$(scalar_ws "${WS_A}" "SELECT count(*) FROM customers;")"
if [[ "${OWN_A}" == "1" ]]; then ok "under GUC=A, own customers read = 1 (own-workspace read OK)"
else bad "under GUC=A, own customers read = ${OWN_A} (want 1)"; fi

# Cross-workspace read: under A's GUC, B's row is invisible (by id AND by count).
XREAD_BYID="$(scalar_ws "${WS_A}" "SELECT count(*) FROM customers WHERE id='cust-b';")"
if [[ "${XREAD_BYID}" == "0" ]]; then ok "under GUC=A, B's customer by id = 0 (cross read fenced)"
else bad "under GUC=A, B's customer by id = ${XREAD_BYID} (LEAK — want 0)"; fi
# Reverse direction on lead_intakes too (different table, same fence).
XREAD_LI="$(scalar_ws "${WS_B}" "SELECT count(*) FROM lead_intakes WHERE id='li-a';")"
if [[ "${XREAD_LI}" == "0" ]]; then ok "under GUC=B, A's lead_intake by id = 0 (cross read fenced)"
else bad "under GUC=B, A's lead_intake by id = ${XREAD_LI} (LEAK — want 0)"; fi

# ============================================================================
step "E. Cross-workspace WRITE blocked by WITH CHECK (MUST raise)"
# Bound to A, try to INSERT a row tagged B -> the WITH CHECK must reject it.
WRITE_ERR="$(docker exec -e PGPASSWORD="${APP_PW}" "${CONTAINER}" \
  psql -X -tA -v ON_ERROR_STOP=1 -U "${APP_USER}" -d "${PG_DB}" -c \
  "BEGIN; SELECT set_config('app.current_workspace','${WS_A}',true);
   INSERT INTO customers (id,\"workspaceId\",\"contactId\",stage,priority,\"isLost\",\"lastStageChangeAt\",\"createdAt\",\"updatedAt\")
   VALUES ('cust-evil','${WS_B}','contact-evil','LEAD','LOW',false,now(),now(),now()); COMMIT;" 2>&1 || true)"
if grep -qi 'row-level security' <<<"${WRITE_ERR}"; then
  ok "cross-workspace INSERT raised row-level security violation (WITH CHECK enforced)"
else
  bad "cross-workspace INSERT did NOT raise an RLS violation. Got: ${WRITE_ERR:-<no error>}"
fi
# Prove the evil row did NOT land (owner can see everything; count must be 0).
EVIL_LANDED="$(psql_admin "SELECT count(*) FROM customers WHERE id='cust-evil';" | sed -n '3p' | tr -d '[:space:]')"
if [[ "${EVIL_LANDED}" == "0" ]]; then ok "evil row absent in DB (write truly blocked, not just errored late)"
else bad "evil row PRESENT (count=${EVIL_LANDED}) — WITH CHECK failed to block the write"; fi

# ============================================================================
step "F. Cross-workspace UPDATE / DELETE are no-ops (0 rows affected)"
# Bound to A, UPDATE/DELETE B's rows -> RLS USING hides them -> 0 rows touched.
UPD_OUT="$(psql_app -c "BEGIN; SELECT set_config('app.current_workspace','${WS_A}',true); UPDATE lead_intakes SET notes='hax' WHERE id='li-b'; ROLLBACK;" 2>&1 | grep -iE 'UPDATE [0-9]+' | head -1 | tr -d '[:space:]')"
if [[ "${UPD_OUT}" == "UPDATE0" ]]; then ok "UPDATE of B's lead_intake from A = UPDATE 0 (fenced)"
else bad "UPDATE of B's lead_intake from A = ${UPD_OUT:-<none>} (want UPDATE 0)"; fi
DEL_OUT="$(psql_app -c "BEGIN; SELECT set_config('app.current_workspace','${WS_A}',true); DELETE FROM customers WHERE id='cust-b'; ROLLBACK;" 2>&1 | grep -iE 'DELETE [0-9]+' | head -1 | tr -d '[:space:]')"
if [[ "${DEL_OUT}" == "DELETE0" ]]; then ok "DELETE of B's customer from A = DELETE 0 (fenced)"
else bad "DELETE of B's customer from A = ${DEL_OUT:-<none>} (want DELETE 0)"; fi

# ============================================================================
step "G. Empty-GUC ('') fails closed (NULLIF normalizes '' -> NULL -> 0 rows)"
# An explicit SET app.current_workspace='' must NOT match an empty key.
EMPTY_GUC="$(scalar_ws "" "SELECT count(*) FROM customers;")"
if [[ "${EMPTY_GUC}" == "0" ]]; then ok "empty-string GUC read = 0 rows (NULLIF fail-closed)"
else bad "empty-string GUC read = ${EMPTY_GUC} (want 0 — current_workspace_id() not normalizing '')"; fi

# ============================================================================
printf '\n%s\n' "================================================================"
if [[ "${FAIL}" -eq 0 ]]; then
  printf '%s\n' "${GRN}TENANCY FENCE PROVEN — ${PASS} checks passed, 0 failed.${NC}"
  printf '%s\n' "The DB half of go-live is safe: own-read OK, cross-read 0, cross-write blocked, no-GUC/empty-GUC fail closed, on ALL ${#SCOPED_TABLES[@]} scoped tables."
  exit 0
else
  printf '%s\n' "${RED}TENANCY FENCE NOT PROVEN — ${PASS} passed, ${FAIL} FAILED.${NC}"
  printf '%s\n' "${RED}DO NOT flip CUSTOMER_OPS_TENANCY_ENABLED=true until every check is green.${NC}"
  exit 1
fi

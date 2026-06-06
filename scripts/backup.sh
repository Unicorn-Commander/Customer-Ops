#!/usr/bin/env bash
# =============================================================================
# Customer-Ops — production database backup (host: commander)
# =============================================================================
# Logical pg_dump of the customerops database -> gzip -> local rotation, and
# (when configured) an off-box push to an S3-compatible target (Cloudflare R2 or
# Garage). Mirrors the live commander backup idiom (majiks.online/backup-database.sh):
# dump inside the container, verify, rotate by age, alert on failure via Listmonk.
#
# WHY logical pg_dump (not WAL/PITR): the customerops dataset is small and a
# single-file `pg_dump --format=custom` is a self-contained, version-portable,
# restore-anywhere artifact — the simplest thing that gives a correct, testable
# restore (see docs/runbooks/backup-restore.md, which also documents the PITR
# upgrade path if/when RPO needs tightening).
#
# IMPORTANT — RLS + the dump role:
#   The dump runs as `customer_ops_admin` (the object OWNER, BYPASSRLS) so it
#   captures EVERY workspace's rows. The runtime DATABASE_URL app role
#   (customer_ops_app) is NOBYPASSRLS and would dump nothing under live RLS, so
#   we deliberately exec pg_dump with the admin role (POSTGRES_USER inside the
#   container), NOT the app credentials.
#
# SECRETS: every credential is referenced by ENV-VAR NAME and read from the
# deploy .env. Nothing secret is written to disk by this script except the dump
# itself (the dump IS sensitive data — keep BACKUP_LOCAL_DIR + the bucket private).
#
# Schedule (cron, commander) — staggered off the existing 02:00/03:00 jobs:
#   30 2 * * * /home/muut/Production/customer-ops/scripts/backup.sh \
#                >> /home/muut/backups/customer-ops-backup.log 2>&1
# =============================================================================

set -euo pipefail

# --- Resolve the deploy .env (so cron gets the same config as compose) --------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/deploy/.env}"
if [ -f "${ENV_FILE}" ]; then
  set -a            # export everything sourced, so child docker runs inherit it
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

# --- Fixed facts about the deploy --------------------------------------------
CONTAINER="${BACKUP_PG_CONTAINER:-customer-ops-postgres}"
DB_NAME="${BACKUP_PG_DB:-customerops}"
DB_USER="${BACKUP_PG_USER:-customer_ops_admin}"   # the OWNER role (BYPASSRLS)

# --- Configurable, with safe defaults ----------------------------------------
BACKUP_DIR="${BACKUP_LOCAL_DIR:-/home/muut/backups/customer-ops-db}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
# .dump = pg_dump custom format (compressed, restored with pg_restore).
BACKUP_FILE="${BACKUP_DIR}/customerops_${TIMESTAMP}.dump"
LOG_PREFIX="[customer-ops-backup]"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') ${LOG_PREFIX} $*"; }

# --- Optional failure alert via Listmonk (degrades clean if unset) -----------
send_alert() {
  local subject="$1" body="$2"
  if [ -z "${LISTMONK_API_USER:-}" ] || [ -z "${LISTMONK_API_TOKEN:-}" ] \
     || [ -z "${BACKUP_ALERT_EMAIL:-}" ]; then
    return 0   # alerting not configured — log-only, no throw
  fi
  curl -fsS -u "${LISTMONK_API_USER}:${LISTMONK_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"subscriber_email\":\"${BACKUP_ALERT_EMAIL}\",\"subject\":\"${subject}\",\"body\":\"${body}\",\"content_type\":\"html\",\"from_email\":\"Backup Alert <support@magicunicorn.tech>\"}" \
    "${LISTMONK_URL:-http://localhost:8301}/api/tx" >/dev/null 2>&1 || true
}

fail() {
  log "ERROR: $*"
  send_alert "[CUSTOMER-OPS] DB backup FAILED" \
    "<p>customerops backup failed at $(date) on $(hostname).</p><p>${*}</p>"
  exit 1
}

# --- Preconditions ------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "docker not found on PATH"
docker inspect "${CONTAINER}" >/dev/null 2>&1 \
  || fail "postgres container '${CONTAINER}' not found / not running"
mkdir -p "${BACKUP_DIR}"

# --- Dump ---------------------------------------------------------------------
log "Starting pg_dump of '${DB_NAME}' (role ${DB_USER}) from container ${CONTAINER}..."
# --format=custom: compressed, parallel-restorable, pg_restore-driven.
# Stream stdout to the host file so nothing is written inside the (read-only intent)
# container. `set -o pipefail` makes a pg_dump failure fail the whole pipe.
if ! docker exec "${CONTAINER}" \
      pg_dump --format=custom --no-owner --no-privileges \
              -U "${DB_USER}" "${DB_NAME}" > "${BACKUP_FILE}"; then
  rm -f "${BACKUP_FILE}"
  fail "pg_dump returned non-zero"
fi

# --- Verify the artifact is plausible ----------------------------------------
FILESIZE="$(stat -c%s "${BACKUP_FILE}" 2>/dev/null || stat -f%z "${BACKUP_FILE}" 2>/dev/null || echo 0)"
if [ "${FILESIZE}" -lt 1024 ]; then
  rm -f "${BACKUP_FILE}"
  fail "dump suspiciously small (${FILESIZE} bytes) — treating as failure"
fi
# Confirm the custom-format header is intact (pg_restore can read the TOC).
if ! docker run --rm -i postgres:17 pg_restore --list < "${BACKUP_FILE}" >/dev/null 2>&1; then
  fail "dump failed pg_restore --list integrity check"
fi
HUMAN_SIZE="$(du -h "${BACKUP_FILE}" | cut -f1)"
log "Dump OK: ${BACKUP_FILE} (${HUMAN_SIZE})"

# --- Off-box push (S3-compatible: Cloudflare R2 / Garage). Degrades clean. ----
if [ -n "${BACKUP_S3_BUCKET:-}" ] && [ -n "${BACKUP_S3_ENDPOINT:-}" ] \
   && [ -n "${BACKUP_S3_ACCESS_KEY_ID:-}" ] && [ -n "${BACKUP_S3_SECRET_ACCESS_KEY:-}" ]; then
  S3_KEY="customer-ops/$(basename "${BACKUP_FILE}")"
  log "Pushing off-box -> s3://${BACKUP_S3_BUCKET}/${S3_KEY} (endpoint ${BACKUP_S3_ENDPOINT})"
  # Host has no aws CLI — use a throwaway amazon/aws-cli container. Creds are
  # passed as env (by NAME) and never logged. --endpoint-url targets R2/Garage.
  if docker run --rm \
        -e AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID}" \
        -e AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY}" \
        -e AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-auto}" \
        -v "${BACKUP_DIR}:/backups:ro" \
        amazon/aws-cli:latest \
        s3 cp "/backups/$(basename "${BACKUP_FILE}")" \
              "s3://${BACKUP_S3_BUCKET}/${S3_KEY}" \
              --endpoint-url "${BACKUP_S3_ENDPOINT}" >/dev/null; then
    log "Off-box push OK"
  else
    # Off-box failure is alert-worthy but the local dump is still good — do NOT
    # exit non-zero solely on the remote leg (local copy already protects us).
    log "WARNING: off-box push failed (local dump retained)"
    send_alert "[CUSTOMER-OPS] DB backup off-box push FAILED" \
      "<p>Local customerops dump succeeded but the off-box push to s3://${BACKUP_S3_BUCKET} failed at $(date).</p>"
  fi
else
  log "Off-box target not configured (BACKUP_S3_* unset) — keeping local-only copy"
fi

# --- Rotate local copies by age ----------------------------------------------
DELETED="$(find "${BACKUP_DIR}" -name 'customerops_*.dump' -mtime +"${RETENTION_DAYS}" -print -delete 2>/dev/null | wc -l | tr -d ' ')"
[ "${DELETED}" -gt 0 ] && log "Rotated ${DELETED} local dump(s) older than ${RETENTION_DAYS}d"
REMAINING="$(find "${BACKUP_DIR}" -name 'customerops_*.dump' | wc -l | tr -d ' ')"
log "Done. ${REMAINING} local dump(s) retained in ${BACKUP_DIR}"

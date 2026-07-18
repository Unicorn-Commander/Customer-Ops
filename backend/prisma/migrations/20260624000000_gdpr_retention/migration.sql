-- ============================================================================
-- Customer-Ops — GDPR data lifecycle: workspace retention window
-- ============================================================================
--
-- Adds the ONE column the GDPR data-lifecycle work needs: a per-workspace
-- data-retention window (`retention_days`) on the tenancy CONTROL table
-- `workspaces`. This is the "minimal retention setting" that gates the DORMANT
-- record retention sweep (Contact-Ops `retention_sweep` parity).
--
-- POSTURE — PURGES NOTHING BY DEFAULT:
--   * The column is NULLABLE with NO default, so every existing + new workspace
--     starts with retention DISABLED (NULL).
--   * The sweep is additionally gated by the CUSTOMER_OPS_RETENTION_SWEEP_ENABLED
--     feature flag (default OFF). Both must be set before a single row is purged.
--
-- `workspaces` is the tenancy control table (NOT RLS-fenced — see
-- 20260603202000_suite_tenancy_rls_roles §4/§5a), so this is a plain column add.
-- The runtime role already holds SELECT/INSERT/UPDATE/DELETE on `workspaces`
-- (grant 5a), so no new GRANT is required — the owner-gated retention setter
-- writes this column through the existing privilege.
--
-- Chained off migration head 20260623000000_m365_connections. (Sibling GDPR /
-- feature branches may add later-timestamped migrations; the human merge gate
-- linearizes them — this migration only adds a column and is order-independent.)

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "retentionDays" INTEGER;

-- Guard: a retention window, when set, must be a positive number of days. NULL
-- stays allowed (retention disabled). Enforced at the DB so a bad setter value
-- can never mean "purge everything older than 0 days".
ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_retention_days_check"
  CHECK ("retentionDays" IS NULL OR "retentionDays" > 0);

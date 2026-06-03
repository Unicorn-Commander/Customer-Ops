-- ============================================================================
-- Customer-Ops — Phase 2: the relationship cockpit + activity log
-- ============================================================================
--
-- Normative contract: SUITE-IDENTITY.md (§5 isolation, §6 GUC `app.current_workspace`).
-- Builds on the Phase 1 RLS foundation (20260603202000_suite_tenancy_rls_roles):
-- the role split, current_workspace_id(), and the `customers` policy already
-- exist; this migration adds the Phase 2 pipeline columns + the new scoped
-- `customer_activities` table and brings it under the SAME ENABLE+FORCE RLS
-- workspace-isolation policy as `customers`.
--
-- ROLLOUT POSTURE (identical to Phase 1 — ADDITIVE / INERT for the running app):
--   * Every new column has a default reproducing today's effective value
--     (priority=MEDIUM, isLost=false, lastStageChangeAt=now, currency=USD),
--     so the alter is a behavioral no-op for existing rows.
--   * The new table is born with a NOT NULL workspaceId and is ENABLED+FORCED
--     for row security with the workspace_isolation policy from line ~one. The
--     running app still connects as the BYPASSRLS object owner, so the fence is
--     created-but-inert until DATABASE_URL flips to the NOBYPASSRLS
--     `customer_ops_app` role (a later phase) — exactly like `customers`.
--   * Proven against the verify DB via a DIRECT `customer_ops_app` connection
--     (no-GUC reads return 0 rows on the new table; FORCE on; cross-workspace
--     writes/reads blocked).
--
-- NULL workspace_id handling (unchanged): the policy predicate is
-- `workspaceId = current_workspace_id()`; a NULL workspaceId yields NULL (not
-- TRUE) under three-valued logic, so such a row is invisible + un-writable —
-- fail-closed. `customer_activities.workspaceId` is NOT NULL, so none can exist.

-- ----------------------------------------------------------------------------
-- 1. ENUMS
-- ----------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "RelationshipPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "CustomerActivityKind" AS ENUM ('STAGE_CHANGE', 'NOTE', 'CREATED', 'REOPENED', 'MARKED_LOST', 'OWNER_CHANGED');

-- ----------------------------------------------------------------------------
-- 2. Pipeline columns on the relationship projection (all additive, defaulted).
--    These are RELATIONSHIP-owned, not contact data — contact PII is never
--    stored here; it federates from Contact-Ops at read time.
-- ----------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "closedLostAt" TIMESTAMP(3),
ADD COLUMN     "currency" TEXT DEFAULT 'USD',
ADD COLUMN     "expectedValue" DECIMAL(20,4),
ADD COLUMN     "isLost" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastStageChangeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lostReason" TEXT,
ADD COLUMN     "nextActionAt" TIMESTAMP(3),
ADD COLUMN     "ownerUserKey" TEXT,
ADD COLUMN     "priority" "RelationshipPriority" NOT NULL DEFAULT 'MEDIUM';

-- ----------------------------------------------------------------------------
-- 3. The relationship activity log (new tenant-scoped table).
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "customer_activities" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" "CustomerActivityKind" NOT NULL,
    "fromStage" "RelationshipStage",
    "toStage" "RelationshipStage",
    "body" TEXT,
    "actorUcUid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_activities_workspaceId_idx" ON "customer_activities"("workspaceId");

-- CreateIndex
CREATE INDEX "customer_activities_workspaceId_customerId_createdAt_idx" ON "customer_activities"("workspaceId", "customerId", "createdAt");

-- CreateIndex
CREATE INDEX "customers_workspaceId_stage_isLost_idx" ON "customers"("workspaceId", "stage", "isLost");

-- CreateIndex
CREATE INDEX "customers_workspaceId_ownerUserKey_idx" ON "customers"("workspaceId", "ownerUserKey");

-- AddForeignKey
ALTER TABLE "customer_activities" ADD CONSTRAINT "customer_activities_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_activities" ADD CONSTRAINT "customer_activities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 4. GRANTS — the new scoped table gets the same least-privilege DML grant the
--    runtime app role holds on `customers` (RLS fences the rows). The Phase 1
--    ALTER DEFAULT PRIVILEGES only fires for tables created by customer_ops_owner;
--    this migration runs as the connection owner (postgres/customer_ops_admin),
--    so grant explicitly to be safe + deterministic.
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_activities" TO customer_ops_app;
GRANT SELECT ON "customer_activities" TO customer_ops_ro;

-- ----------------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY — bring `customer_activities` under the identical
--    ENABLE + FORCE + workspace_isolation policy used for `customers` in Phase 1.
--    USING gates reads/updates/deletes; WITH CHECK gates the post-image of
--    inserts/updates so an activity can never be written into a workspace other
--    than the GUC's. The Phase-2 scoped-table set is { customers (already),
--    customer_activities (here) }; future cockpit tables join this list.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  scoped_tables text[] := ARRAY[
    'customer_activities'
  ];
BEGIN
  FOREACH t IN ARRAY scoped_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS workspace_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I '
      || 'USING ("workspaceId" = current_workspace_id()) '
      || 'WITH CHECK ("workspaceId" = current_workspace_id())',
      t
    );
  END LOOP;
END
$$;

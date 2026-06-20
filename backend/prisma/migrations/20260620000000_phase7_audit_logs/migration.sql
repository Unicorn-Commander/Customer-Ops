-- ============================================================================
-- Customer-Ops — Phase 7: the system audit trail (audit_logs)
-- ============================================================================
--
-- Normative contract: SUITE-IDENTITY.md (§5 isolation, §6 GUC `app.current_workspace`).
-- Adds the workspace-scoped, APPEND-ONLY `audit_logs` table and brings it under
-- the SAME ENABLE+FORCE RLS workspace-isolation policy as `customers` /
-- `customer_activities`. The `customer_ops_audit` sink role (reserved since
-- 20260603202000_suite_tenancy_rls_roles) finally gets its table.
--
-- POSTURE: tenancy is now LIVE (runtime = customer_ops_app, NOBYPASSRLS, flipped
-- 2026-06-20). So unlike the earlier additive-but-inert migrations, this table's
-- RLS is enforced from the first write: AuditService.log() stamps workspaceId and
-- writes through the workspace GUC (PrismaService.withWorkspace), satisfying the
-- WITH CHECK. A bare (no-GUC) insert under the app role is REJECTED by WITH CHECK
-- — by design (audit is fail-closed, never silently mis-filed).
--
-- APPEND-ONLY: the runtime role gets SELECT + INSERT only (no UPDATE/DELETE), so
-- the trail is tamper-resistant even from a compromised app role.

-- ----------------------------------------------------------------------------
-- 1. ENUM
-- ----------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'READ', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'EXPORT', 'IMPORT', 'EXECUTE');

-- ----------------------------------------------------------------------------
-- 2. TABLE
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "userId" TEXT,
    "action" "AuditAction" NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_workspaceId_idx" ON "audit_logs"("workspaceId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_resource_resourceId_idx" ON "audit_logs"("resource", "resourceId");

-- CreateIndex
CREATE INDEX "audit_logs_timestamp_idx" ON "audit_logs"("timestamp");

-- ----------------------------------------------------------------------------
-- 3. GRANTS — APPEND-ONLY for the runtime role (SELECT + INSERT, no UPDATE/DELETE
--    -> tamper-resistant). The customer_ops_audit sink role (reserved in Phase 1)
--    gets the same append-only grant; read-only role gets SELECT. The Phase-1
--    ALTER DEFAULT PRIVILEGES only fires for tables created by customer_ops_owner;
--    this migration runs as the connection owner, so grant explicitly.
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT ON "audit_logs" TO customer_ops_app;
GRANT SELECT, INSERT ON "audit_logs" TO customer_ops_audit;
GRANT SELECT ON "audit_logs" TO customer_ops_ro;

-- ----------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY — identical ENABLE + FORCE + workspace_isolation policy
--    used for customers / customer_activities. USING gates reads; WITH CHECK
--    gates the post-image of inserts so an audit row can never be written into a
--    workspace other than the GUC's. A NULL workspaceId yields NULL (not TRUE)
--    under three-valued logic -> invisible + un-writable (fail-closed).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  scoped_tables text[] := ARRAY[
    'audit_logs'
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

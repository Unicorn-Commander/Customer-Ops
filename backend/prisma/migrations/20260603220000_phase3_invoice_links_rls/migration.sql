-- ============================================================================
-- Customer-Ops — Phase 3: the invoicing surface (Accounting-Ops AR seam)
-- ============================================================================
--
-- Normative contract: SUITE-IDENTITY.md (§5 isolation, §6 GUC `app.current_workspace`)
-- + README "Accounting-Ops AR" federation seam + AO `app/ar` (the ledger SoR).
--
-- Customer-Ops FEDERATES invoicing: it calls Accounting-Ops's native
-- create_invoice_from_draft / get_invoice (over MCP), idempotent on
-- (workspace_id, external_source='customer-ops', external_ref). AO owns the
-- ledger, the double-entry hash chain, and the authoritative balance. This
-- migration adds the ONE thin local artifact Customer-Ops keeps — a LINK from a
-- relationship to its AO invoice (so the cockpit can list a customer's invoices
-- and poll their live status) — and brings it under the SAME ENABLE + FORCE RLS
-- workspace-isolation policy as `customers` / `customer_activities`. It does NOT
-- create a second invoicing engine: no ledger row, no line detail, no posting.
--
-- ROLLOUT POSTURE (identical to Phase 1/2 — ADDITIVE / INERT for the running app):
--   * The new enum value INVOICE_CREATED is appended to CustomerActivityKind
--     (additive; existing rows unaffected).
--   * The new table is born with a NOT NULL workspaceId and is ENABLED + FORCED
--     for row security with the workspace_isolation policy. The running app
--     still connects as the BYPASSRLS object owner, so the fence is
--     created-but-inert until DATABASE_URL flips to the NOBYPASSRLS
--     `customer_ops_app` role (a later phase) — exactly like `customers`.
--   * Proven against the verify DB via a DIRECT `customer_ops_app` connection
--     (prisma/rls-phase3-acceptance.sql): no-GUC reads return 0 rows on the new
--     table, FORCE on, cross-workspace read/write/update/delete blocked.
--
-- NULL workspace_id handling (unchanged): the policy predicate is
-- `"workspaceId" = current_workspace_id()`; a NULL workspaceId yields NULL (not
-- TRUE) under three-valued logic, so such a row is invisible + un-writable —
-- fail-closed. `customer_invoice_links.workspaceId` is NOT NULL, so none exist.
--
-- Money columns (totalAmount, lastBalanceDue) are DECIMAL(20,4) — the suite
-- money shape, matching AO's own NUMERIC(20,4) invoice columns. Never float.

-- ----------------------------------------------------------------------------
-- 1. ENUM — append the Phase-3 activity kind (additive; ADD VALUE is the only
--    safe enum mutation and must run outside an explicit txn block on older PGs;
--    Prisma runs each statement autocommit so IF NOT EXISTS keeps it idempotent).
-- ----------------------------------------------------------------------------
ALTER TYPE "CustomerActivityKind" ADD VALUE IF NOT EXISTS 'INVOICE_CREATED';

-- ----------------------------------------------------------------------------
-- 2. The invoice federation link (new tenant-scoped table). Thin by design:
--    the idempotency tuple + the AO invoice id + a cached status/balance for
--    cheap list rendering. AO remains the system-of-record for the invoice.
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "customer_invoice_links" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "externalSource" TEXT NOT NULL DEFAULT 'customer-ops',
    "externalRef" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "aoInvoiceId" TEXT,
    "invoiceNumber" TEXT,
    "lastStatus" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "totalAmount" DECIMAL(20,4),
    "lastBalanceDue" DECIMAL(20,4),
    "lastPolledAt" TIMESTAMP(3),
    "createdByUcUid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_invoice_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — the idempotency tuple is unique per workspace (mirrors AO's
-- partial unique on (workspace_id, external_source, external_ref)).
CREATE UNIQUE INDEX "customer_invoice_links_workspaceId_externalSource_externalR_key" ON "customer_invoice_links"("workspaceId", "externalSource", "externalRef");

-- CreateIndex
CREATE INDEX "customer_invoice_links_workspaceId_idx" ON "customer_invoice_links"("workspaceId");

-- CreateIndex — the 360 invoice panel reads a customer's links newest-first.
CREATE INDEX "customer_invoice_links_workspaceId_customerId_createdAt_idx" ON "customer_invoice_links"("workspaceId", "customerId", "createdAt");

-- AddForeignKey
ALTER TABLE "customer_invoice_links" ADD CONSTRAINT "customer_invoice_links_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_invoice_links" ADD CONSTRAINT "customer_invoice_links_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 3. GRANTS — the new scoped table gets the same least-privilege DML grant the
--    runtime app role holds on `customers` (RLS fences the rows). The Phase-1
--    ALTER DEFAULT PRIVILEGES only fires for tables created by customer_ops_owner;
--    this migration runs as the connection owner (postgres/customer_ops_admin),
--    so grant explicitly to be safe + deterministic.
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_invoice_links" TO customer_ops_app;
GRANT SELECT ON "customer_invoice_links" TO customer_ops_ro;

-- ----------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY — bring `customer_invoice_links` under the identical
--    ENABLE + FORCE + workspace_isolation policy used for `customers` (Phase 1)
--    and `customer_activities` (Phase 2). USING gates reads/updates/deletes;
--    WITH CHECK gates the post-image of inserts/updates so a link can never be
--    written into a workspace other than the GUC's. The scoped-table set is now
--    { customers, customer_activities, customer_invoice_links }.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  scoped_tables text[] := ARRAY[
    'customer_invoice_links'
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

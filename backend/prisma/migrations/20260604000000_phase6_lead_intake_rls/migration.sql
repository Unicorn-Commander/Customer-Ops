-- ============================================================================
-- Customer-Ops — Phase 6: the lead-ingestion front door (leadgen → Customer-Ops)
-- ============================================================================
--
-- Normative contract: SUITE-IDENTITY.md (§5 isolation, §6 GUC `app.current_workspace`)
-- + CONTACT-OPS-INGEST-CONTRACT.md (identity centralizes in Contact-Ops; domain
-- apps federate + project a rollup) + README "The golden rule".
--
-- This migration adds the ONE new tenant-scoped artifact the `ingest_lead`
-- keystone needs: `lead_intakes` — the durable, idempotent ingestion BUFFER a
-- leadgen app (Northwind / Magic Unicorn Outreach / LoopNet / multistate / …) or an
-- agent pushes a graduated, enriched lead into. The buffer makes the
-- "build your trigger now, wire the Contact-Ops connector (P-00059) later"
-- timing safe: a lead lands PENDING and is NEVER lost; a reconciler promotes it
-- — resolving identity in Contact-Ops + projecting a Customer LEAD row — the
-- moment Contact-Ops is reachable. When P-00059 lands, NOTHING here changes; the
-- resolver simply starts succeeding.
--
-- It is NOT a second contact store. The relationship projection stays the thin
-- `customers` row (whose only contact field is the resolved `contactId`). This
-- buffer legitimately holds the RAW inbound identity because it is the ingestion
-- record (the thing that exists to be resolved into Contact-Ops), kept as the
-- audit/replay trail + the provisional-label fallback while Contact-Ops is
-- dormant — never as the system-of-record for the person.
--
-- ROLLOUT POSTURE (identical to Phases 1–5 — ADDITIVE / INERT for the running app):
--   * The new enum value INGESTED is appended to CustomerActivityKind (additive;
--     existing rows unaffected). A new enum LeadIntakeStatus is created.
--   * The new table is born with a NOT NULL workspaceId and is ENABLED + FORCED
--     for row security with the workspace_isolation policy. The running app
--     still connects as the BYPASSRLS object owner, so the fence is
--     created-but-inert until DATABASE_URL flips to the NOBYPASSRLS
--     `customer_ops_app` role (go-live) — exactly like the other scoped tables.
--
-- NULL workspace_id handling (unchanged): the policy predicate is
-- `"workspaceId" = current_workspace_id()`; a NULL workspaceId yields NULL (not
-- TRUE) under three-valued logic, so such a row is invisible + un-writable —
-- fail-closed. `lead_intakes.workspaceId` is NOT NULL, so none exist.
--
-- Money column (expectedValue) is DECIMAL(20,4) — the suite money shape. Never float.

-- ----------------------------------------------------------------------------
-- 1. ENUMS — append the Phase-6 activity kind (additive; ADD VALUE is the only
--    safe enum mutation and runs autocommit, so IF NOT EXISTS keeps it
--    idempotent) + create the intake lifecycle enum.
-- ----------------------------------------------------------------------------
ALTER TYPE "CustomerActivityKind" ADD VALUE IF NOT EXISTS 'INGESTED';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LeadIntakeStatus') THEN
    CREATE TYPE "LeadIntakeStatus" AS ENUM ('PENDING', 'RESOLVED', 'FAILED', 'DISCARDED');
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 2. The lead-ingestion buffer (new tenant-scoped table). Durable + idempotent
--    on (workspaceId, source, sourceDedupKey): a leadgen connector can retry a
--    push safely. Holds the raw inbound identity + the rollup + the resolution
--    outcome (resolvedContactId / provisional / customerId / status).
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "lead_intakes" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceDedupKey" TEXT NOT NULL,
    "status" "LeadIntakeStatus" NOT NULL DEFAULT 'PENDING',
    "displayName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "orgName" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "score" INTEGER,
    "rawPayload" JSONB,
    "expectedValue" DECIMAL(20,4),
    "currency" TEXT DEFAULT 'USD',
    "priority" "RelationshipPriority" NOT NULL DEFAULT 'MEDIUM',
    "ownerUserKey" TEXT,
    "notes" TEXT,
    "resolvedContactId" TEXT,
    "provisional" BOOLEAN NOT NULL DEFAULT false,
    "customerId" TEXT,
    "statusDetail" TEXT,
    "createdByUcUid" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_intakes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_intakes_workspaceId_idx" ON "lead_intakes"("workspaceId");

-- CreateIndex — the reconciler scans PENDING/FAILED oldest-first.
CREATE INDEX "lead_intakes_workspaceId_status_createdAt_idx" ON "lead_intakes"("workspaceId", "status", "createdAt");

-- CreateIndex — reconciliation + the provisional→canonical swap look up by the
-- resolved/provisional contactId.
CREATE INDEX "lead_intakes_workspaceId_resolvedContactId_idx" ON "lead_intakes"("workspaceId", "resolvedContactId");

-- CreateIndex — the cockpit's provisional-label fallback resolves by customerId.
CREATE INDEX "lead_intakes_workspaceId_customerId_idx" ON "lead_intakes"("workspaceId", "customerId");

-- CreateIndex — the idempotency tuple is unique per workspace.
CREATE UNIQUE INDEX "lead_intakes_workspaceId_source_sourceDedupKey_key" ON "lead_intakes"("workspaceId", "source", "sourceDedupKey");

-- AddForeignKey — the graduated projection; SET NULL so the audit row outlives a
-- later-deleted Customer.
ALTER TABLE "lead_intakes" ADD CONSTRAINT "lead_intakes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_intakes" ADD CONSTRAINT "lead_intakes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 3. GRANTS — the new scoped table gets the same least-privilege DML grant the
--    runtime app role holds on `customers` (RLS fences the rows). Granted
--    explicitly (this migration runs as the connection owner, not
--    customer_ops_owner, so the Phase-1 ALTER DEFAULT PRIVILEGES does not fire).
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "lead_intakes" TO customer_ops_app;
GRANT SELECT ON "lead_intakes" TO customer_ops_ro;

-- ----------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY — bring `lead_intakes` under the identical ENABLE +
--    FORCE + workspace_isolation policy used for every other scoped table.
--    USING gates reads/updates/deletes; WITH CHECK gates the post-image of
--    inserts/updates so an intake can never be written into a workspace other
--    than the GUC's. The scoped-table set is now { customers,
--    customer_activities, customer_invoice_links, customer_outreach_links,
--    customer_email_links, lead_intakes }.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  scoped_tables text[] := ARRAY[
    'lead_intakes'
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

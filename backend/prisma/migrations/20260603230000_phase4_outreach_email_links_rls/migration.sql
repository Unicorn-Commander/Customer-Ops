-- ============================================================================
-- Customer-Ops — Phase 4: the Outreach + Email surfaces (federation seams)
-- ============================================================================
--
-- Normative contract: SUITE-IDENTITY.md (§5 isolation, §6 GUC `app.current_workspace`)
-- + README "Outreach"/"Email-Ops" federation seams + SUITE-ARCHITECTURE-MAP §3/§7
-- (the engine layer + comms lanes: Listmonk/Postiz behind the Outreach app,
-- Stalwart behind the Email-Ops app).
--
-- Customer-Ops FEDERATES outreach + mailboxes: it calls the (future) Outreach
-- and Email-Ops APPS over MCP (by workspace_id), never the Listmonk/Postiz/
-- Stalwart engines directly. Those apps own the campaigns, sends, lists,
-- mailboxes, threads, and message bodies. This migration adds the TWO thin local
-- artifacts Customer-Ops keeps — a LINK from a relationship to an Outreach
-- enrollment/touch, and a LINK to an Email-Ops outbound message it initiated (so
-- the cockpit can render + de-dupe what it kicked off and cache a status) — and
-- brings BOTH under the SAME ENABLE + FORCE RLS workspace-isolation policy as
-- `customers` / `customer_activities` / `customer_invoice_links`. It does NOT
-- create a second campaign engine or mail store: no recipient list, no send
-- content, no message body.
--
-- ROLLOUT POSTURE (identical to Phase 1/2/3 — ADDITIVE / INERT for the running app):
--   * Three enum values are appended to CustomerActivityKind (CAMPAIGN_STARTED,
--     EMAIL_SENT, ENGAGEMENT_ADVANCED) — additive; existing rows unaffected.
--   * The two new tables are born with NOT NULL workspaceId and are ENABLED +
--     FORCED for row security with the workspace_isolation policy. The running
--     app still connects as the BYPASSRLS object owner, so the fence is
--     created-but-inert until DATABASE_URL flips to the NOBYPASSRLS
--     `customer_ops_app` role (a later phase) — exactly like the earlier tables.
--   * Proven against the verify DB via a DIRECT `customer_ops_app` connection
--     (prisma/rls-phase4-acceptance.sql): no-GUC reads return 0 rows on both new
--     tables, FORCE on, cross-workspace read/write/update/delete blocked.
--
-- NULL workspace_id handling (unchanged): the policy predicate is
-- `"workspaceId" = current_workspace_id()`; a NULL workspaceId yields NULL (not
-- TRUE) under three-valued logic, so such a row is invisible + un-writable —
-- fail-closed. Both new tables' workspaceId columns are NOT NULL, so none exist.

-- ----------------------------------------------------------------------------
-- 1. ENUM — append the Phase-4 activity kinds (additive; ADD VALUE is the only
--    safe enum mutation and must run outside an explicit txn block on older PGs;
--    Prisma runs each statement autocommit so IF NOT EXISTS keeps it idempotent).
-- ----------------------------------------------------------------------------
ALTER TYPE "CustomerActivityKind" ADD VALUE IF NOT EXISTS 'CAMPAIGN_STARTED';
ALTER TYPE "CustomerActivityKind" ADD VALUE IF NOT EXISTS 'EMAIL_SENT';
ALTER TYPE "CustomerActivityKind" ADD VALUE IF NOT EXISTS 'ENGAGEMENT_ADVANCED';

-- ----------------------------------------------------------------------------
-- 2. The outreach federation link (new tenant-scoped table). Thin by design:
--    the idempotency tuple + the Outreach enrollment id + a cached status. The
--    Outreach app remains the system-of-record for the campaign + every send.
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "customer_outreach_links" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "externalSource" TEXT NOT NULL DEFAULT 'customer-ops',
    "externalRef" TEXT NOT NULL,
    "campaignId" TEXT,
    "outreachId" TEXT,
    "campaignName" TEXT,
    "lastStatus" TEXT,
    "lastPolledAt" TIMESTAMP(3),
    "createdByUcUid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_outreach_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_email_links" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'send',
    "externalSource" TEXT NOT NULL DEFAULT 'customer-ops',
    "externalRef" TEXT NOT NULL,
    "threadId" TEXT,
    "messageId" TEXT,
    "subject" TEXT,
    "lastStatus" TEXT,
    "lastPolledAt" TIMESTAMP(3),
    "createdByUcUid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_email_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_outreach_links_workspaceId_idx" ON "customer_outreach_links"("workspaceId");

-- CreateIndex — the 360 outreach panel reads a customer's links newest-first.
CREATE INDEX "customer_outreach_links_workspaceId_customerId_createdAt_idx" ON "customer_outreach_links"("workspaceId", "customerId", "createdAt");

-- CreateIndex — the idempotency tuple is unique per workspace (mirrors the
-- Outreach app's own partial unique on (workspace_id, external_source, external_ref)).
CREATE UNIQUE INDEX "customer_outreach_links_workspaceId_externalSource_external_key" ON "customer_outreach_links"("workspaceId", "externalSource", "externalRef");

-- CreateIndex
CREATE INDEX "customer_email_links_workspaceId_idx" ON "customer_email_links"("workspaceId");

-- CreateIndex — the 360 email panel reads a customer's outbound links newest-first.
CREATE INDEX "customer_email_links_workspaceId_customerId_createdAt_idx" ON "customer_email_links"("workspaceId", "customerId", "createdAt");

-- CreateIndex — the idempotency tuple is unique per workspace.
CREATE UNIQUE INDEX "customer_email_links_workspaceId_externalSource_externalRef_key" ON "customer_email_links"("workspaceId", "externalSource", "externalRef");

-- AddForeignKey
ALTER TABLE "customer_outreach_links" ADD CONSTRAINT "customer_outreach_links_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_outreach_links" ADD CONSTRAINT "customer_outreach_links_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_email_links" ADD CONSTRAINT "customer_email_links_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_email_links" ADD CONSTRAINT "customer_email_links_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 3. GRANTS — the new scoped tables get the same least-privilege DML grant the
--    runtime app role holds on the earlier scoped tables (RLS fences the rows).
--    The Phase-1 ALTER DEFAULT PRIVILEGES only fires for tables created by
--    customer_ops_owner; this migration runs as the connection owner
--    (postgres/customer_ops_admin), so grant explicitly to be safe + deterministic.
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_outreach_links" TO customer_ops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_email_links" TO customer_ops_app;
GRANT SELECT ON "customer_outreach_links" TO customer_ops_ro;
GRANT SELECT ON "customer_email_links" TO customer_ops_ro;

-- ----------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY — bring both new tables under the identical ENABLE +
--    FORCE + workspace_isolation policy used for the earlier scoped tables.
--    USING gates reads/updates/deletes; WITH CHECK gates the post-image of
--    inserts/updates so a link can never be written into a workspace other than
--    the GUC's. The scoped-table set is now { customers, customer_activities,
--    customer_invoice_links, customer_outreach_links, customer_email_links }.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  scoped_tables text[] := ARRAY[
    'customer_outreach_links',
    'customer_email_links'
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

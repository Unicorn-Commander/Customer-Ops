-- ============================================================================
-- Customer-Ops Phase 3 — RLS acceptance proof (run AS customer_ops_app)
-- ============================================================================
-- Re-proves the tenant fence on the NEW Phase-3 scoped table
-- (customer_invoice_links — the Accounting-Ops invoice link), exactly as Phase 1
-- proved `customers` and Phase 2 proved `customer_activities`. Connect as the
-- NOBYPASSRLS runtime role:
--
--   PGPASSWORD=verify_app psql \
--     "postgresql://localhost:5432/customer_ops" \
--     -v ON_ERROR_STOP=0 -f prisma/rls-phase3-acceptance.sql
--
-- Expectations (asserted inline):
--   A. role posture: rolbypassrls = f  (NOBYPASSRLS — the fence is live for it)
--   B. FORCE + ENABLE on the scoped table = t/t
--   C. no-GUC read on the table = 0 rows (fail-closed)
--   D. seed two workspaces' link rows under their own GUC, then prove cross-read = 0
--   E. WITH CHECK blocks writing a link into a workspace other than the GUC's
--   F. UPDATE/DELETE across the fence are no-ops (0 rows)
--   G. money columns are NUMERIC(20,4) (scale preserved on round-trip)

\echo '==================================================================='
\echo 'A. Runtime role posture (MUST be customer_ops_app, rolbypassrls = f)'
\echo '==================================================================='
SELECT current_user, rolbypassrls
FROM pg_roles WHERE rolname = current_user;

\echo ''
\echo '==================================================================='
\echo 'B. ENABLE + FORCE row security on customer_invoice_links (t/t)'
\echo '==================================================================='
SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
FROM pg_class
WHERE relname = 'customer_invoice_links';

\echo ''
\echo '==================================================================='
\echo 'C. No-GUC read MUST return 0 rows (fail-closed; no workspace set)'
\echo '==================================================================='
SELECT 'customer_invoice_links' AS tbl, count(*) AS no_guc_rows FROM customer_invoice_links;

\echo ''
\echo '==================================================================='
\echo 'D. Seed two workspaces under their own GUC, then prove isolation.'
\echo '   (Workspaces + parent customers are inserted by the BYPASSRLS owner'
\echo '    in the harness; here as the app role we write the SCOPED link rows'
\echo '    under each GUC against the pre-seeded customers.)'
\echo '==================================================================='

-- --- Workspace AAAA -------------------------------------------------------
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
SELECT set_config('app.uc_uid', 'uc-uid-alice', true);
INSERT INTO customers (id, "workspaceId", "contactId", stage, priority, "isLost", "lastStageChangeAt", "createdAt", "updatedAt")
VALUES ('cust-aaaa-p3', '0190a000-7e57-7000-8000-0000000aaaaa', 'contact-aaaa-p3', 'CUSTOMER', 'MEDIUM', false, now(), now(), now());
INSERT INTO customer_invoice_links
  (id, "workspaceId", "customerId", "externalSource", "externalRef", "entityId",
   "aoInvoiceId", "invoiceNumber", "lastStatus", currency, "totalAmount", "lastBalanceDue", "createdAt", "updatedAt")
VALUES
  ('link-aaaa-1', '0190a000-7e57-7000-8000-0000000aaaaa', 'cust-aaaa-p3', 'customer-ops',
   'cust:cust-aaaa-p3:k1', 'entity-aaaa', 'inv-aaaa-1', 'INV-A-0001', 'sent', 'USD',
   2040.0000, 2040.0000, now(), now());
\echo '-- under GUC=AAAA, I can see only my own link rows:'
SELECT count(*) AS aaaa_links FROM customer_invoice_links;
COMMIT;

-- --- Workspace BBBB -------------------------------------------------------
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000bbbbb', true);
SELECT set_config('app.uc_uid', 'uc-uid-bob', true);
INSERT INTO customers (id, "workspaceId", "contactId", stage, priority, "isLost", "lastStageChangeAt", "createdAt", "updatedAt")
VALUES ('cust-bbbb-p3', '0190a000-7e57-7000-8000-0000000bbbbb', 'contact-bbbb-p3', 'CUSTOMER', 'HIGH', false, now(), now(), now());
INSERT INTO customer_invoice_links
  (id, "workspaceId", "customerId", "externalSource", "externalRef", "entityId",
   "lastStatus", currency, "totalAmount", "lastBalanceDue", "createdAt", "updatedAt")
VALUES
  ('link-bbbb-1', '0190a000-7e57-7000-8000-0000000bbbbb', 'cust-bbbb-p3', 'customer-ops',
   'cust:cust-bbbb-p3:k1', 'entity-bbbb', 'draft', 'EUR', 500.0000, 500.0000, now(), now());
\echo '-- under GUC=BBBB, I can see only BBBB links (AAAA invisible):'
SELECT count(*) AS bbbb_links FROM customer_invoice_links;
\echo '-- explicit cross-read: AAAA link from BBBB context MUST be 0:'
SELECT count(*) AS aaaa_link_visible_from_bbbb FROM customer_invoice_links WHERE id = 'link-aaaa-1';
\echo '-- by external_ref too (the idempotency tuple is not cross-visible):'
SELECT count(*) AS aaaa_ref_visible_from_bbbb FROM customer_invoice_links WHERE "externalRef" = 'cust:cust-aaaa-p3:k1';
COMMIT;

\echo ''
\echo '==================================================================='
\echo 'E. WITH CHECK blocks writing a link into another workspace than the'
\echo '   GUC. Bound to AAAA, try to INSERT a link tagged BBBB -> MUST error.'
\echo '==================================================================='
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
-- MUST raise: "new row violates row-level security policy for table customer_invoice_links"
INSERT INTO customer_invoice_links
  (id, "workspaceId", "customerId", "externalSource", "externalRef", "entityId", currency, "createdAt", "updatedAt")
VALUES
  ('link-evil', '0190a000-7e57-7000-8000-0000000bbbbb', 'cust-bbbb-p3', 'customer-ops',
   'cust:evil:k', 'entity-x', 'USD', now(), now());
ROLLBACK;

\echo ''
\echo '==================================================================='
\echo 'F. UPDATE/DELETE across the fence are no-ops (0 rows) from AAAA.'
\echo '==================================================================='
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
\echo '-- UPDATE BBBB link from AAAA (expect UPDATE 0):'
UPDATE customer_invoice_links SET "lastStatus" = 'paid' WHERE id = 'link-bbbb-1';
\echo '-- DELETE BBBB link from AAAA (expect DELETE 0):'
DELETE FROM customer_invoice_links WHERE id = 'link-bbbb-1';
ROLLBACK;

\echo ''
\echo '==================================================================='
\echo 'G. Money scale: NUMERIC(20,4) preserves 4dp on round-trip (AAAA).'
\echo '==================================================================='
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
SELECT "totalAmount"::text AS total_text, "lastBalanceDue"::text AS balance_text
FROM customer_invoice_links WHERE id = 'link-aaaa-1';
COMMIT;

\echo ''
\echo '==================================================================='
\echo 'CLEANUP — remove seeded scoped rows (each under its own GUC).'
\echo '==================================================================='
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
DELETE FROM customer_invoice_links WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000aaaaa';
DELETE FROM customers WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000aaaaa';
COMMIT;
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000bbbbb', true);
DELETE FROM customer_invoice_links WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000bbbbb';
DELETE FROM customers WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000bbbbb';
COMMIT;

\echo 'DONE.'

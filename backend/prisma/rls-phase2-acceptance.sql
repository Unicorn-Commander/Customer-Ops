-- ============================================================================
-- Customer-Ops Phase 2 — RLS acceptance proof (run AS customer_ops_app)
-- ============================================================================
-- Re-proves the tenant fence on the NEW Phase-2 scoped table
-- (customer_activities) and the pipeline-extended customers table, exactly as
-- Phase 1 proved `customers`. Connect as the NOBYPASSRLS runtime role:
--
--   PGPASSWORD=verify_app psql \
--     "postgresql://localhost:5432/customer_ops" \
--     -v ON_ERROR_STOP=0 -f prisma/rls-phase2-acceptance.sql
--
-- Expectations (asserted inline):
--   A. role posture: rolbypassrls = f  (NOBYPASSRLS — the fence is live for it)
--   B. FORCE + ENABLE on both scoped tables = t/t
--   C. no-GUC reads on both tables = 0 rows (fail-closed)
--   D. seed two workspaces' rows under their own GUC, then prove cross-read = 0
--   E. WITH CHECK blocks writing a row into a workspace other than the GUC's
--   F. a customer_activity is only visible under its own workspace GUC

\echo '==================================================================='
\echo 'A. Runtime role posture (MUST be customer_ops_app, rolbypassrls = f)'
\echo '==================================================================='
SELECT current_user, rolbypassrls
FROM pg_roles WHERE rolname = current_user;

\echo ''
\echo '==================================================================='
\echo 'B. ENABLE + FORCE row security on both Phase-2 scoped tables (t/t)'
\echo '==================================================================='
SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
FROM pg_class
WHERE relname IN ('customers', 'customer_activities')
ORDER BY relname;

\echo ''
\echo '==================================================================='
\echo 'C. No-GUC reads MUST return 0 rows (fail-closed; no workspace set)'
\echo '==================================================================='
SELECT 'customers' AS tbl, count(*) AS no_guc_rows FROM customers
UNION ALL
SELECT 'customer_activities', count(*) FROM customer_activities;

\echo ''
\echo '==================================================================='
\echo 'D. Seed two workspaces under their own GUC, then prove isolation.'
\echo '   (Workspaces are inserted by the BYPASSRLS owner in the harness;'
\echo '    here as the app role we write the SCOPED rows under each GUC.)'
\echo '==================================================================='

-- --- Workspace AAAA -------------------------------------------------------
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
SELECT set_config('app.uc_uid', 'uc-uid-alice', true);
INSERT INTO customers (id, "workspaceId", "contactId", stage, priority, "isLost", "lastStageChangeAt", "createdAt", "updatedAt")
VALUES ('cust-aaaa-1', '0190a000-7e57-7000-8000-0000000aaaaa', 'contact-aaaa-1', 'LEAD', 'MEDIUM', false, now(), now(), now());
INSERT INTO customer_activities (id, "workspaceId", "customerId", kind, "toStage", body, "actorUcUid", "createdAt")
VALUES ('act-aaaa-1', '0190a000-7e57-7000-8000-0000000aaaaa', 'cust-aaaa-1', 'CREATED', 'LEAD', 'seeded in AAAA', 'uc-uid-alice', now());
\echo '-- under GUC=AAAA, I can see only my own rows:'
SELECT count(*) AS aaaa_customers FROM customers;
SELECT count(*) AS aaaa_activities FROM customer_activities;
COMMIT;

-- --- Workspace BBBB -------------------------------------------------------
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000bbbbb', true);
SELECT set_config('app.uc_uid', 'uc-uid-bob', true);
INSERT INTO customers (id, "workspaceId", "contactId", stage, priority, "isLost", "lastStageChangeAt", "createdAt", "updatedAt")
VALUES ('cust-bbbb-1', '0190a000-7e57-7000-8000-0000000bbbbb', 'contact-bbbb-1', 'PROSPECT', 'HIGH', false, now(), now(), now());
INSERT INTO customer_activities (id, "workspaceId", "customerId", kind, "fromStage", "toStage", body, "actorUcUid", "createdAt")
VALUES ('act-bbbb-1', '0190a000-7e57-7000-8000-0000000bbbbb', 'cust-bbbb-1', 'STAGE_CHANGE', 'LEAD', 'PROSPECT', 'seeded in BBBB', 'uc-uid-bob', now());
\echo '-- under GUC=BBBB, I can see only BBBB rows (AAAA invisible):'
SELECT count(*) AS bbbb_customers FROM customers;
SELECT count(*) AS bbbb_activities FROM customer_activities;
\echo '-- explicit cross-read: AAAA contactId from BBBB context MUST be 0:'
SELECT count(*) AS aaaa_visible_from_bbbb FROM customers WHERE "contactId" = 'contact-aaaa-1';
SELECT count(*) AS aaaa_act_visible_from_bbbb FROM customer_activities WHERE id = 'act-aaaa-1';
COMMIT;

\echo ''
\echo '==================================================================='
\echo 'E. WITH CHECK blocks writing into another workspace than the GUC.'
\echo '   Bound to AAAA, try to INSERT a customer tagged BBBB -> MUST error'
\echo '   (new row violates row-level security policy).'
\echo '==================================================================='
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
-- This MUST raise: "new row violates row-level security policy for table customers"
INSERT INTO customers (id, "workspaceId", "contactId", stage, priority, "isLost", "lastStageChangeAt", "createdAt", "updatedAt")
VALUES ('cust-evil', '0190a000-7e57-7000-8000-0000000bbbbb', 'contact-evil', 'LEAD', 'MEDIUM', false, now(), now(), now());
ROLLBACK;

\echo ''
\echo '==================================================================='
\echo 'E2. Same cross-write attempt on customer_activities -> MUST error.'
\echo '==================================================================='
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
-- MUST raise: "new row violates row-level security policy for table customer_activities"
INSERT INTO customer_activities (id, "workspaceId", "customerId", kind, body, "createdAt")
VALUES ('act-evil', '0190a000-7e57-7000-8000-0000000bbbbb', 'cust-bbbb-1', 'NOTE', 'evil cross-write', now());
ROLLBACK;

\echo ''
\echo '==================================================================='
\echo 'F. UPDATE/DELETE across the fence are no-ops (0 rows) from AAAA.'
\echo '   Bound to AAAA, try to mutate BBBB rows -> 0 rows affected.'
\echo '==================================================================='
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
\echo '-- UPDATE BBBB customer from AAAA (expect UPDATE 0):'
UPDATE customers SET stage = 'CUSTOMER' WHERE id = 'cust-bbbb-1';
\echo '-- DELETE BBBB activity from AAAA (expect DELETE 0):'
DELETE FROM customer_activities WHERE id = 'act-bbbb-1';
ROLLBACK;

\echo ''
\echo '==================================================================='
\echo 'CLEANUP — remove seeded scoped rows (each under its own GUC).'
\echo '==================================================================='
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
DELETE FROM customer_activities WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000aaaaa';
DELETE FROM customers WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000aaaaa';
COMMIT;
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000bbbbb', true);
DELETE FROM customer_activities WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000bbbbb';
DELETE FROM customers WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000bbbbb';
COMMIT;

\echo 'DONE.'

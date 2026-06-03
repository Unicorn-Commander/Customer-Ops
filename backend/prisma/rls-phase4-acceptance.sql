-- ============================================================================
-- Customer-Ops Phase 4 — RLS acceptance proof (run AS customer_ops_app)
-- ============================================================================
-- Re-proves the tenant fence on the TWO NEW Phase-4 scoped tables
-- (customer_outreach_links + customer_email_links — the Outreach enrollment link
-- and the Email-Ops outbound-message link), exactly as Phase 1 proved
-- `customers`, Phase 2 proved `customer_activities`, and Phase 3 proved
-- `customer_invoice_links`. Connect as the NOBYPASSRLS runtime role:
--
--   PGPASSWORD=verify_app psql \
--     "postgresql://localhost:5432/customer_ops" \
--     -v ON_ERROR_STOP=0 -f prisma/rls-phase4-acceptance.sql
--
-- PREREQUISITE (same as the Phase-3 harness): the two test workspaces are the
-- non-RLS CONTROL table `workspaces`, which the app role is not seeded to manage
-- here, so seed them ONCE as the BYPASSRLS owner before running this script:
--
--   psql "postgresql://localhost:5432/customer_ops" -c "
--     INSERT INTO workspaces (id, slug, \"displayName\", \"isolationMode\",
--       \"isolationTier\", status, \"syncedAt\", \"createdAt\", \"updatedAt\")
--     VALUES
--       ('0190a000-7e57-7000-8000-0000000aaaaa','rls-p4-aaaa','RLS P4 AAAA',
--         'standard','shared','active', now(), now(), now()),
--       ('0190a000-7e57-7000-8000-0000000bbbbb','rls-p4-bbbb','RLS P4 BBBB',
--         'standard','shared','active', now(), now(), now())
--     ON CONFLICT (id) DO NOTHING;"
--
-- The CLEANUP block at the end removes the seeded link + customer rows; drop the
-- two control workspaces with the owner afterward if desired.
--
-- Expectations (asserted inline):
--   A. role posture: rolbypassrls = f  (NOBYPASSRLS — the fence is live for it)
--   B. FORCE + ENABLE on both scoped tables = t/t
--   C. no-GUC read on both tables = 0 rows (fail-closed)
--   D. seed two workspaces' link rows under their own GUC, then prove cross-read = 0
--   E. WITH CHECK blocks writing a link into a workspace other than the GUC's
--   F. UPDATE/DELETE across the fence are no-ops (0 rows)

\echo '==================================================================='
\echo 'A. Runtime role posture (MUST be customer_ops_app, rolbypassrls = f)'
\echo '==================================================================='
SELECT current_user, rolbypassrls
FROM pg_roles WHERE rolname = current_user;

\echo ''
\echo '==================================================================='
\echo 'B. ENABLE + FORCE row security on the two Phase-4 tables (t/t each)'
\echo '==================================================================='
SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
FROM pg_class
WHERE relname IN ('customer_outreach_links', 'customer_email_links')
ORDER BY relname;

\echo ''
\echo '==================================================================='
\echo 'C. No-GUC reads MUST return 0 rows (fail-closed; no workspace set)'
\echo '==================================================================='
SELECT 'customer_outreach_links' AS tbl, count(*) AS no_guc_rows FROM customer_outreach_links
UNION ALL
SELECT 'customer_email_links' AS tbl, count(*) AS no_guc_rows FROM customer_email_links;

\echo ''
\echo '==================================================================='
\echo 'D. Seed two workspaces under their own GUC, then prove isolation.'
\echo '   (Workspaces are pre-seeded by the BYPASSRLS owner — see header.'
\echo '    Here as the app role we write the SCOPED parent customer + the two'
\echo '    link rows under each GUC.)'
\echo '==================================================================='

-- --- Workspace AAAA -------------------------------------------------------
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
SELECT set_config('app.uc_uid', 'uc-uid-alice', true);
INSERT INTO customers (id, "workspaceId", "contactId", stage, priority, "isLost", "lastStageChangeAt", "createdAt", "updatedAt")
VALUES ('cust-aaaa-p4', '0190a000-7e57-7000-8000-0000000aaaaa', 'contact-aaaa-p4', 'PROSPECT', 'MEDIUM', false, now(), now(), now());
INSERT INTO customer_outreach_links
  (id, "workspaceId", "customerId", "contactId", channel, "externalSource", "externalRef",
   "campaignId", "outreachId", "campaignName", "lastStatus", "createdAt", "updatedAt")
VALUES
  ('orl-aaaa-1', '0190a000-7e57-7000-8000-0000000aaaaa', 'cust-aaaa-p4', 'contact-aaaa-p4', 'email',
   'customer-ops', 'cust:cust-aaaa-p4:enroll:k1', 'camp-aaaa', 'enr-aaaa-1', 'June Nurture', 'queued', now(), now());
INSERT INTO customer_email_links
  (id, "workspaceId", "customerId", "contactId", mode, "externalSource", "externalRef",
   "threadId", "messageId", subject, "lastStatus", "createdAt", "updatedAt")
VALUES
  ('eml-aaaa-1', '0190a000-7e57-7000-8000-0000000aaaaa', 'cust-aaaa-p4', 'contact-aaaa-p4', 'send',
   'customer-ops', 'cust:cust-aaaa-p4:email:k1', 'thread-aaaa', 'msg-aaaa-1', 'Following up', 'sent', now(), now());
\echo '-- under GUC=AAAA, I can see only my own link rows (1 outreach, 1 email):'
SELECT count(*) AS aaaa_outreach FROM customer_outreach_links;
SELECT count(*) AS aaaa_email FROM customer_email_links;
COMMIT;

-- --- Workspace BBBB -------------------------------------------------------
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000bbbbb', true);
SELECT set_config('app.uc_uid', 'uc-uid-bob', true);
INSERT INTO customers (id, "workspaceId", "contactId", stage, priority, "isLost", "lastStageChangeAt", "createdAt", "updatedAt")
VALUES ('cust-bbbb-p4', '0190a000-7e57-7000-8000-0000000bbbbb', 'contact-bbbb-p4', 'LEAD', 'HIGH', false, now(), now(), now());
INSERT INTO customer_outreach_links
  (id, "workspaceId", "customerId", "contactId", channel, "externalSource", "externalRef", "lastStatus", "createdAt", "updatedAt")
VALUES
  ('orl-bbbb-1', '0190a000-7e57-7000-8000-0000000bbbbb', 'cust-bbbb-p4', 'contact-bbbb-p4', 'social',
   'customer-ops', 'cust:cust-bbbb-p4:social:k1', 'scheduled', now(), now());
INSERT INTO customer_email_links
  (id, "workspaceId", "customerId", "contactId", mode, "externalSource", "externalRef", "lastStatus", "createdAt", "updatedAt")
VALUES
  ('eml-bbbb-1', '0190a000-7e57-7000-8000-0000000bbbbb', 'cust-bbbb-p4', 'contact-bbbb-p4', 'draft',
   'customer-ops', 'cust:cust-bbbb-p4:email:k1', 'pending_approval', now(), now());
\echo '-- under GUC=BBBB, I can see only BBBB links (AAAA invisible):'
SELECT count(*) AS bbbb_outreach FROM customer_outreach_links;
SELECT count(*) AS bbbb_email FROM customer_email_links;
\echo '-- explicit cross-read: AAAA links from BBBB context MUST be 0:'
SELECT count(*) AS aaaa_outreach_from_bbbb FROM customer_outreach_links WHERE id = 'orl-aaaa-1';
SELECT count(*) AS aaaa_email_from_bbbb FROM customer_email_links WHERE id = 'eml-aaaa-1';
\echo '-- by external_ref too (the idempotency tuple is not cross-visible):'
SELECT count(*) AS aaaa_orl_ref_from_bbbb FROM customer_outreach_links WHERE "externalRef" = 'cust:cust-aaaa-p4:enroll:k1';
SELECT count(*) AS aaaa_eml_ref_from_bbbb FROM customer_email_links WHERE "externalRef" = 'cust:cust-aaaa-p4:email:k1';
COMMIT;

\echo ''
\echo '==================================================================='
\echo 'E. WITH CHECK blocks writing a link into another workspace than the'
\echo '   GUC. Bound to AAAA, try to INSERT links tagged BBBB -> MUST error.'
\echo '==================================================================='
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
\echo '-- outreach link tagged BBBB from AAAA context MUST raise:'
-- MUST raise: "new row violates row-level security policy for table customer_outreach_links"
INSERT INTO customer_outreach_links
  (id, "workspaceId", "customerId", "contactId", channel, "externalSource", "externalRef", "createdAt", "updatedAt")
VALUES
  ('orl-evil', '0190a000-7e57-7000-8000-0000000bbbbb', 'cust-bbbb-p4', 'contact-bbbb-p4', 'email',
   'customer-ops', 'cust:evil:k', now(), now());
ROLLBACK;

BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
\echo '-- email link tagged BBBB from AAAA context MUST raise:'
-- MUST raise: "new row violates row-level security policy for table customer_email_links"
INSERT INTO customer_email_links
  (id, "workspaceId", "customerId", "contactId", mode, "externalSource", "externalRef", "createdAt", "updatedAt")
VALUES
  ('eml-evil', '0190a000-7e57-7000-8000-0000000bbbbb', 'cust-bbbb-p4', 'contact-bbbb-p4', 'send',
   'customer-ops', 'cust:evil:k', now(), now());
ROLLBACK;

\echo ''
\echo '==================================================================='
\echo 'F. UPDATE/DELETE across the fence are no-ops (0 rows) from AAAA.'
\echo '==================================================================='
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
\echo '-- UPDATE BBBB outreach link from AAAA (expect UPDATE 0):'
UPDATE customer_outreach_links SET "lastStatus" = 'clicked' WHERE id = 'orl-bbbb-1';
\echo '-- UPDATE BBBB email link from AAAA (expect UPDATE 0):'
UPDATE customer_email_links SET "lastStatus" = 'delivered' WHERE id = 'eml-bbbb-1';
\echo '-- DELETE BBBB links from AAAA (expect DELETE 0 each):'
DELETE FROM customer_outreach_links WHERE id = 'orl-bbbb-1';
DELETE FROM customer_email_links WHERE id = 'eml-bbbb-1';
ROLLBACK;

\echo ''
\echo '==================================================================='
\echo 'CLEANUP — remove seeded scoped rows (each under its own GUC).'
\echo '==================================================================='
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000aaaaa', true);
DELETE FROM customer_outreach_links WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000aaaaa';
DELETE FROM customer_email_links WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000aaaaa';
DELETE FROM customers WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000aaaaa';
COMMIT;
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000bbbbb', true);
DELETE FROM customer_outreach_links WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000bbbbb';
DELETE FROM customer_email_links WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000bbbbb';
DELETE FROM customers WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000bbbbb';
COMMIT;

\echo 'DONE.'

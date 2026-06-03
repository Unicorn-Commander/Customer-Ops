-- ============================================================================
-- Suite Tenancy Foundation — Phase 1: DB roles, GUC chokepoint, RLS, bootstrap
-- ============================================================================
--
-- Normative contract: SUITE-IDENTITY.md (§5 isolation columns, §6 GUC name
-- `app.current_workspace`, §7 roles, §8 D3/D5/D10). This implements it for
-- Customer-Ops, mirroring the proven Project-Ops pattern.
--
-- ROLLOUT POSTURE (Phase 1 — ADDITIVE / INERT for the running app):
--   * RLS is ENABLED + FORCED here, but the running app still connects as the
--     object owner (customer_ops_admin / customer_ops_owner), and a table owner
--     is exempt from its own RLS UNLESS FORCE is set. We FORCE row security so
--     that even the owner is subject to policy — EXCEPT we additionally grant
--     BYPASSRLS to customer_ops_owner so migrations / maintenance run by the
--     owner are never fenced. The runtime role `customer_ops_app` is explicitly
--     NOBYPASSRLS, so the moment the runtime DATABASE_URL flips to it (a later
--     phase) the fence becomes live. Until then Customer-Ops behaves as today.
--   * This migration is proven against the verify DB via a DIRECT
--     `customer_ops_app` connection (see the task acceptance SQL A–D).
--
-- NULL workspace_id handling:
--   The policy predicate is `workspace_id = current_workspace_id()`. SQL
--   three-valued logic means a row whose workspace_id IS NULL yields NULL (not
--   TRUE) for every GUC value, so such a row is INVISIBLE and UN-WRITABLE under
--   RLS regardless of the GUC — fail-closed. Customer-Ops' only scoped table
--   (`customers`) carries a NOT NULL workspace_id from the foundation migration,
--   so no NULL rows can exist.

-- ----------------------------------------------------------------------------
-- 0. Bootstrap workspace id (stable; uuidv7-shaped, minted once for dogfood).
--    Customer-Ops never mints in production — this is the single dev/dogfood
--    bootstrap workspace the access-list users are seeded into. uc-registry
--    owns real ids. Chosen constant: a valid lowercase RFC-4122 v7 UUID.
--    bootstrap workspace_id = 0190a000-7e57-7000-8000-00000000c007
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 1. ROLES (cluster-global; guarded so re-runs and shared clusters are safe).
--    customer_ops_owner  — object owner; DDL/migrations; BYPASSRLS.
--    customer_ops_app    — runtime role; LOGIN, NOSUPERUSER, NOBYPASSRLS.
--    customer_ops_audit  — INSERT-only sink role (reserved for the Phase-2
--                          audit_logs table; created now so the role set is
--                          complete from day one).
--    customer_ops_ro     — read-only reporting.
--
--    NOTE on passwords: dev/verify needs customer_ops_app to actually LOGIN, so
--    we set a deterministic dev password here, idempotently. In production the
--    password is rotated out-of-band via ADMIN_DATABASE_URL; the role
--    attributes (esp. NOBYPASSRLS) are what matter for the security property.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'customer_ops_owner') THEN
    CREATE ROLE customer_ops_owner NOLOGIN;
  END IF;
  -- Owner must never be fenced by its own FORCED RLS during migrations.
  ALTER ROLE customer_ops_owner BYPASSRLS;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'customer_ops_app') THEN
    CREATE ROLE customer_ops_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'verify_app';
  END IF;
  -- Idempotently pin the security-critical attributes + a known dev password.
  ALTER ROLE customer_ops_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'verify_app';

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'customer_ops_audit') THEN
    CREATE ROLE customer_ops_audit LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'verify_audit';
  END IF;
  ALTER ROLE customer_ops_audit LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'verify_audit';

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'customer_ops_ro') THEN
    CREATE ROLE customer_ops_ro LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'verify_ro';
  END IF;
  ALTER ROLE customer_ops_ro LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'verify_ro';

  -- The migration is applied by the connection owner (here: postgres /
  -- customer_ops_admin). Make that role a member of customer_ops_owner so the
  -- objects it creates are co-administrable, and so a later REASSIGN OWNED to
  -- customer_ops_owner is clean. Harmless if already a member.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user)
     AND current_user <> 'customer_ops_owner' THEN
    EXECUTE format('GRANT customer_ops_owner TO %I', current_user);
  END IF;
END
$$;

-- All four runtime roles need to enter the schema.
GRANT USAGE ON SCHEMA public TO customer_ops_app, customer_ops_audit, customer_ops_ro, customer_ops_owner;

-- ----------------------------------------------------------------------------
-- 2. current_workspace_id() — NULL-safe read of the per-request GUC.
--    `true` second arg => missing setting returns NULL instead of erroring.
--    No SECURITY DEFINER (it only reads a session GUC). Empty string is
--    normalized to NULL so an explicit `SET app.current_workspace = ''` cannot
--    accidentally match an empty key.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_workspace_id()
  RETURNS text
  LANGUAGE sql
  STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_workspace', true), '')
$$;

GRANT EXECUTE ON FUNCTION current_workspace_id() TO
  customer_ops_app, customer_ops_audit, customer_ops_ro, customer_ops_owner;

-- current_uc_uid() — companion attribution GUC (app.uc_uid). Not used by RLS
-- policies, but available to triggers / audit defaults that want the acting sub.
CREATE OR REPLACE FUNCTION current_uc_uid()
  RETURNS text
  LANGUAGE sql
  STABLE
AS $$
  SELECT NULLIF(current_setting('app.uc_uid', true), '')
$$;

GRANT EXECUTE ON FUNCTION current_uc_uid() TO
  customer_ops_app, customer_ops_audit, customer_ops_ro, customer_ops_owner;

-- ----------------------------------------------------------------------------
-- 3. Workspace mirror compliance ratchet (SUITE-IDENTITY §5 coupling rule):
--    hipaa_mode=true  ⇒  isolation_mode='strict', one-way at the DB.
--    The mirror is read-through from uc-registry; this trigger guarantees no
--    local UPDATE can weaken a HIPAA workspace below `strict`. Also pins the
--    two TEXT+CHECK domains (never a Postgres ENUM, per §5).
-- ----------------------------------------------------------------------------
ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_isolation_mode_check"
  CHECK ("isolationMode" IN ('strict', 'standard', 'open'));

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_isolation_tier_check"
  CHECK ("isolationTier" IN ('shared', 'premium', 'enterprise', 'dedicated'));

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_status_check"
  CHECK ("status" IN ('active', 'suspended', 'archived', 'deleting'));

-- Coupling: a HIPAA workspace must be strict (enforced on every write).
ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_hipaa_implies_strict_check"
  CHECK ("hipaaMode" = false OR "isolationMode" = 'strict');

CREATE OR REPLACE FUNCTION workspaces_hipaa_ratchet()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- One-way ratchet: once HIPAA is on, it cannot be turned off, and the mode
  -- cannot be weakened below strict, by any local UPDATE (registry re-sync
  -- included — registry promotes, never demotes, HIPAA).
  IF OLD."hipaaMode" = true THEN
    IF NEW."hipaaMode" = false THEN
      RAISE EXCEPTION 'workspace %: hipaa_mode is a one-way ratchet and cannot be disabled', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."isolationMode" <> 'strict' THEN
      RAISE EXCEPTION 'workspace %: hipaa_mode=true requires isolation_mode=strict (got %)', OLD.id, NEW."isolationMode"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Turning HIPAA on in this same UPDATE forces strict immediately.
  IF NEW."hipaaMode" = true AND NEW."isolationMode" <> 'strict' THEN
    NEW."isolationMode" := 'strict';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "workspaces_hipaa_ratchet_trg" ON "workspaces";
CREATE TRIGGER "workspaces_hipaa_ratchet_trg"
  BEFORE UPDATE ON "workspaces"
  FOR EACH ROW
  EXECUTE FUNCTION workspaces_hipaa_ratchet();

-- ----------------------------------------------------------------------------
-- 4. Seed the bootstrap workspace + access-list memberships (idempotent).
--    Phase-1 dogfood single tenant. The access-list owners (Aaron, Shafen) get
--    OWNER on the bootstrap workspace so the eventual membership gate admits
--    them. Real workspaces come from uc-registry.
-- ----------------------------------------------------------------------------
INSERT INTO "workspaces" (id, slug, "displayName", "isolationMode", "isolationTier", status, "syncedAt", "createdAt", "updatedAt")
VALUES ('0190a000-7e57-7000-8000-00000000c007', 'magic-unicorn', 'Magic Unicorn (bootstrap)', 'standard', 'shared', 'active', now(), now(), now())
ON CONFLICT (id) DO NOTHING;

-- Memberships keyed by userKey (== uchub sub == User.keycloakId). Seed the two
-- operator owners by the emails the access-list grants OWNER, when their user
-- row already exists + is SSO-linked (keycloakId not null). keycloakId may be
-- null pre-SSO-link, in which case the runtime seeder backfills on first login.
INSERT INTO "memberships" ("userKey", "workspaceId", role, status, "isDefault", "createdAt")
SELECT u."keycloakId", '0190a000-7e57-7000-8000-00000000c007', 'OWNER', 'ACTIVE', true, now()
FROM "users" u
WHERE u."keycloakId" IS NOT NULL
  AND lower(u.email) IN ('aaron@magicunicorn.tech', 'shafenkhan@users.noreply.github.com')
ON CONFLICT ("userKey", "workspaceId") DO NOTHING;

-- ----------------------------------------------------------------------------
-- 5. GRANTS — least privilege per runtime role. The owner already owns
--    everything (the migration runner is a member of customer_ops_owner). We
--    grant the *non-owner* runtime roles explicitly.
-- ----------------------------------------------------------------------------

-- 5a. Control/identity tables the app reads/writes but which are NOT
--     workspace-scoped (no RLS): users, plus the tenancy control tables
--     workspaces + memberships.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "users", "workspaces", "memberships"
  TO customer_ops_app;

-- 5b. Workspace-scoped tables: full DML for the app role (RLS fences the rows).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "customers"
  TO customer_ops_app;

-- 5c. Sequences (Prisma uses uuid PKs, but grant for safety on any serial).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO customer_ops_app;

-- 5d. Read-only reporting role: SELECT on everything (still RLS-fenced).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO customer_ops_ro;

-- 5e. Default privileges so future migrations' tables inherit these grants
--     when created by the owner role.
ALTER DEFAULT PRIVILEGES FOR ROLE customer_ops_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO customer_ops_app;
ALTER DEFAULT PRIVILEGES FOR ROLE customer_ops_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO customer_ops_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE customer_ops_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO customer_ops_app;

-- ----------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY — ENABLE + FORCE + workspace_isolation policy on every
--    workspace-scoped table. FORCE so the table owner is subject to policy too
--    (the runtime role is non-owner + NOBYPASSRLS regardless). The policy is
--    PERMISSIVE (the default) and complete: USING gates reads/updates/deletes,
--    WITH CHECK gates the post-image of inserts/updates so a row can never be
--    written into a workspace other than the GUC's.
--
--    Phase 1 has exactly ONE workspace-scoped table (`customers`, the thin
--    relationship projection). The Phase-2 cockpit tables join this list.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  scoped_tables text[] := ARRAY[
    'customers'
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

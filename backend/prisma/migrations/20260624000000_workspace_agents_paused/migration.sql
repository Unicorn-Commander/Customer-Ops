-- ============================================================================
-- Customer-Ops — workspace-scoped, runtime agent/outbound kill switch
-- ============================================================================
--
-- Adds `agentsPaused` to the workspace mirror. When true, agent runs + outbound
-- email sends for that workspace are halted at DISPATCH time (checked on every
-- call — no pod restart required, unlike the prior boot-snapshot env var). The
-- flag is owner-gated (toggle on the workspace settings surface) and mirrors the
-- suite pattern (Contact-Ops workspace kill-switch / Email-Ops agentsPaused).
--
-- `workspaces` is a CONTROL-PLANE mirror (NOT RLS-fenced): the runtime app role
-- already holds SELECT/INSERT/UPDATE/DELETE on it (see the suite-tenancy-rls-roles
-- migration), so this column inherits those table-level grants — no new GRANT is
-- needed. The BEFORE UPDATE hipaa ratchet trigger only inspects hipaaMode /
-- isolationMode, so a targeted `agentsPaused` UPDATE passes it untouched.

ALTER TABLE "workspaces" ADD COLUMN "agentsPaused" BOOLEAN NOT NULL DEFAULT false;

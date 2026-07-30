-- ----------------------------------------------------------------------------
-- workspace_entitlements — the SERVER-SIDE, per-workspace entitlement mirror.
--
-- ⚠️ THIS TABLE HAS NO PRODUCER. Additive and inert: creating it changes no
-- behaviour. The application only ever WRITES a row here after a 200 from the
-- suite entitlements endpoint, and that lookup is dormant unless BOTH
-- ENTITLEMENTS_ENDPOINT_URL and ENTITLEMENTS_SERVICE_TOKEN are set — which they
-- are not on any node today. There is no backfill, no sync worker, and no admin
-- write path. With zero rows the resolver reports "no server-side source" for
-- every workspace and the entitlement bind behaves exactly as it did before.
-- This is groundwork; the producer is a product decision tracked as
-- TODO(29817abc). See docs/runbooks/entitlement-enforce.md §1f.
--
-- WHY a new table instead of reusing Workspace.entitlementCache:
--   * `Workspace.entitlementCache` is documented as the OPERATOR pin
--     ("offline/dedicated only; null on shared SaaS"). A resolver that writes it
--     would silently clobber an operator-set value, so the two sources must not
--     share a column. entitlementCache keeps PRECEDENCE over this table.
--   * The bind we need is a BOUNDED one: a revoked SKU must stop working inside
--     a stated window. That needs freshness metadata (`refreshedAt`/`expiresAt`)
--     that a bare Json column cannot express.
--
-- SEMANTICS (mirrors parseWorkspaceEntitlements' null/[] distinction):
--   * NO ROW               -> "no server-side source" -> the caller TRUSTS the
--                             token claim / PAT snapshot (today's shared-SaaS
--                             default; nothing changes for a node that never
--                             writes this table).
--   * row, not expired     -> AUTHORITATIVE. skus = [] means "entitled to
--                             nothing" -> deny every SKU.
--   * row, PAST expiresAt  -> a source EXISTS but could not be refreshed =>
--                             INDETERMINATE => the resolver fails CLOSED
--                             (empty set) rather than serving a stale grant.
--
-- Control-plane table (like `workspaces` / `federation_workspace_map`): global
-- config, NOT RLS-fenced, no workspace_isolation policy. `workspaceId` is a bare
-- TEXT key on purpose — no FK to `workspaces`, because a node running with
-- CUSTOMER_OPS_TENANCY_ENABLED off has no mirror row for the default workspace
-- and an FK would make the entitlement mirror unwritable there.
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "workspace_entitlements" (
    "workspaceId" TEXT NOT NULL,
    "skus" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'endpoint',
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_entitlements_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateIndex
CREATE INDEX "workspace_entitlements_expiresAt_idx" ON "workspace_entitlements"("expiresAt");

-- ----------------------------------------------------------------------------
-- GRANTS — REQUIRED. The Phase-1 `ALTER DEFAULT PRIVILEGES FOR ROLE
-- customer_ops_owner` only fires for tables created BY customer_ops_owner, but
-- Prisma migrations connect as customer_ops_admin. A table created by a Prisma
-- migration therefore carries NO default grant, and the NOBYPASSRLS runtime role
-- (customer_ops_app) gets "permission denied" on its first query — AFTER a green
-- migration and a successful boot. Same fix as
-- 20260620010000_personal_access_tokens and
-- 20260719000001_federation_workspace_map_grants.
--
-- The runtime role needs full DML: the resolver UPSERTs a refreshed mirror row.
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_entitlements" TO customer_ops_app;
GRANT SELECT ON "workspace_entitlements" TO customer_ops_ro;

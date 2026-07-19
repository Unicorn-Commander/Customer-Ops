-- Grant the runtime + read roles access to the federation map. The Phase-1
-- ALTER DEFAULT PRIVILEGES only fires for tables created by customer_ops_owner;
-- Prisma migrations run as customer_ops_admin, so a table created by a Prisma
-- migration (federation_workspace_map) needs an explicit grant or the NOBYPASSRLS
-- runtime role (customer_ops_app) gets "permission denied". This table is global
-- config (no RLS): the app reads every workspace-s row at boot to resolve
-- per-tenant sibling workspace ids.
GRANT SELECT, INSERT, UPDATE, DELETE ON "federation_workspace_map" TO customer_ops_app;
GRANT SELECT ON "federation_workspace_map" TO customer_ops_ro;

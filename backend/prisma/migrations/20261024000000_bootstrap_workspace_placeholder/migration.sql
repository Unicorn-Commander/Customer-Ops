-- Neutral name for the bootstrap workspace on a fresh install.
--
-- 20260603202000_suite_tenancy_rls_roles is applied in production and dogfood,
-- so it stays byte-for-byte (Prisma records its checksum). That migration seeds
-- the bootstrap workspace under the original dogfood slug. On a fresh install
-- the workspace has no memberships yet, because the membership seed only
-- matches existing SSO-linked users. This migration renames it to the
-- placeholder that deploy/selfhost/configure-database.cjs then names "local".
--
-- Guard: a workspace that already has any membership (every live deployment)
-- is left exactly as it is.
UPDATE "workspaces" w
   SET slug = 'bootstrap-placeholder',
       "displayName" = 'Bootstrap placeholder',
       "updatedAt" = now()
 WHERE w.id = '0190a000-7e57-7000-8000-00000000c007'
   AND w.slug = 'magic-unicorn'
   AND NOT EXISTS (SELECT 1 FROM "memberships" m WHERE m."workspaceId" = w.id);

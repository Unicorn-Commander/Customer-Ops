-- Per-workspace federation target map (multi-tenant-safe replacement for the
-- global *_WORKSPACE_OVERRIDE envs). Global config table — deliberately NOT
-- row-level-security scoped: it is read across all workspaces at boot to resolve
-- each tenant's sibling-app workspace ids.
CREATE TABLE "federation_workspace_map" (
    "id" TEXT NOT NULL,
    "local_workspace_id" TEXT NOT NULL,
    "target_app" TEXT NOT NULL,
    "target_workspace_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "federation_workspace_map_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "federation_workspace_map_local_workspace_id_target_app_key"
    ON "federation_workspace_map"("local_workspace_id", "target_app");

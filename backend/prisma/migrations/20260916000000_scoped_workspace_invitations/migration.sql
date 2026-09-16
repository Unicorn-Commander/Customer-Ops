-- Control-plane table: only owner/session routes and verified-email admission read it.
-- No bootstrap, entitlement, membership or data backfill.
CREATE TABLE "workspace_invitations" (
 "id" TEXT PRIMARY KEY,
 "workspaceId" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
 "email" TEXT NOT NULL CHECK ("email" = lower(btrim("email"))),
 "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
 "tokenHash" TEXT NOT NULL UNIQUE,
 "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','ACCEPTED','REVOKED')),
 "invitedBy" TEXT NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL,
 "acceptedBy" TEXT,
 "acceptedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ("expiresAt" > "createdAt")
);
CREATE INDEX "workspace_invitations_email_status_expiresAt_idx" ON "workspace_invitations"("email","status","expiresAt");
CREATE INDEX "workspace_invitations_workspaceId_idx" ON "workspace_invitations"("workspaceId");
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_invitations" TO customer_ops_app;

-- The reservation survives a response loss or registry interruption; it is not
-- a workspace or membership and grants no tenant access.
CREATE TABLE "workspace_provision_requests" (
 "ownerKey" TEXT NOT NULL,
 "requestKey" TEXT NOT NULL,
 "sourceWorkspaceId" TEXT NOT NULL,
 "displayName" TEXT NOT NULL,
 "workspaceId" TEXT NOT NULL UNIQUE,
 "completed" BOOLEAN NOT NULL DEFAULT false,
 "registrySource" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("ownerKey","requestKey")
);
GRANT SELECT, INSERT, UPDATE ON "workspace_provision_requests" TO customer_ops_app;

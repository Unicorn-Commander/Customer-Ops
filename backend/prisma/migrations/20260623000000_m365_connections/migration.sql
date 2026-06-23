-- ============================================================================
-- Customer-Ops — Microsoft 365 connector (m365_connections)
-- ============================================================================
--
-- A signed-in user's delegated Microsoft 365 (Graph) account link. The connector
-- pulls the user's OWN Outlook contacts (v1) and funnels each through the
-- EXISTING lead-intake pipeline (source 'm365') — it never forks a second
-- phonebook. The whole connector is DORMANT until M365_CLIENT_ID is configured.
--
-- User-scoped, app-enforced. Deliberately NOT under RLS — exactly like
-- personal_access_tokens: the credential is resolved at the OAuth-callback (the
-- signed `state` re-establishes the user) BEFORE any workspace GUC exists, so a
-- `workspace_isolation` policy here would return zero rows and make the
-- connection unreadable at the only moment it must be written. Ownership is
-- enforced in M365ConnectionStore (`where: { userId }`). The `workspaceId` column
-- is the workspace the sync funnels leads into (a hint, NOT an RLS predicate).
--
-- SECRETS: refreshTokenEnc / accessTokenEnc are AES-256-GCM ciphertext
-- (iv:authTag:ciphertext, base64), never plaintext tokens. The runtime role gets
-- FULL DML (NOT append-only): re-consent updates the refresh token, a sync bumps
-- lastSyncAt / accessTokenEnc / deltaLinkContacts, and disconnect DELETEs the row.

-- CreateEnum
CREATE TYPE "M365ConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'ERROR');

-- CreateTable
CREATE TABLE "m365_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "m365UserId" TEXT NOT NULL,
    "m365UserPrincipal" TEXT,
    "scopes" TEXT[],
    "refreshTokenEnc" TEXT NOT NULL,
    "accessTokenEnc" TEXT,
    "accessTokenExpires" TIMESTAMP(3),
    "status" "M365ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "deltaLinkContacts" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "m365_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "m365_connections_userId_idx" ON "m365_connections"("userId");

-- CreateIndex
CREATE INDEX "m365_connections_workspaceId_idx" ON "m365_connections"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "m365_connections_userId_workspaceId_key" ON "m365_connections"("userId", "workspaceId");

-- AddForeignKey
ALTER TABLE "m365_connections" ADD CONSTRAINT "m365_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- GRANTS — full DML for the runtime app role (re-consent updates the token, a
-- sync bumps lastSyncAt / accessTokenEnc / deltaLinkContacts, disconnect DELETEs).
-- The Phase-1 ALTER DEFAULT PRIVILEGES only fires for tables created by
-- customer_ops_owner; this migration runs as the connection owner, so grant
-- explicitly. NO RLS / no workspace_isolation policy (see header).
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "m365_connections" TO customer_ops_app;
GRANT SELECT ON "m365_connections" TO customer_ops_ro;

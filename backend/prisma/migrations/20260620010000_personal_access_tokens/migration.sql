-- ============================================================================
-- Customer-Ops — Personal Access Tokens (co_pat_)
-- ============================================================================
--
-- User-scoped, app-enforced programmatic API credentials. Deliberately NOT
-- under RLS: the auth chokepoint (JwtAuthGuard) resolves a PAT to its user +
-- bound workspace BEFORE any workspace GUC exists, so a `workspace_isolation`
-- policy here would return zero rows and make every token unauthenticatable
-- (and `withWorkspace` throws on an empty workspaceId). Ownership is enforced
-- in PatService (`where: { userId }`). The runtime role gets FULL DML (NOT
-- append-only like audit_logs): `lastUsedAt` bump + revoke both need UPDATE.

-- CreateTable
CREATE TABLE "personal_access_tokens" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT 'co_pat_',
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "personal_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "personal_access_tokens_tokenHash_key" ON "personal_access_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "personal_access_tokens_userId_idx" ON "personal_access_tokens"("userId");

-- CreateIndex
CREATE INDEX "personal_access_tokens_tokenHash_idx" ON "personal_access_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "personal_access_tokens_revokedAt_idx" ON "personal_access_tokens"("revokedAt");

-- CreateIndex
CREATE INDEX "personal_access_tokens_workspaceId_idx" ON "personal_access_tokens"("workspaceId");

-- AddForeignKey
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- GRANTS — full DML for the runtime app role (lastUsedAt + revoke need UPDATE).
-- The Phase-1 ALTER DEFAULT PRIVILEGES only fires for tables created by
-- customer_ops_owner; this migration runs as the connection owner, so grant
-- explicitly. NO RLS / no workspace_isolation policy (see header).
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "personal_access_tokens" TO customer_ops_app;
GRANT SELECT ON "personal_access_tokens" TO customer_ops_ro;

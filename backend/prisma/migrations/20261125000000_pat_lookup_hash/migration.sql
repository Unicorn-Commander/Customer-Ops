-- CUO-PAT-1a: indexed PAT lookup. Nullable (legacy rows stay NULL and are
-- backfilled on first use); additive only, no data change.
ALTER TABLE "personal_access_tokens" ADD COLUMN "lookupHash" TEXT;

CREATE UNIQUE INDEX "personal_access_tokens_lookupHash_key" ON "personal_access_tokens"("lookupHash");

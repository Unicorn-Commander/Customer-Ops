-- CreateTable
CREATE TABLE "quote_versions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "disposition" TEXT NOT NULL DEFAULT 'current',
    "snapshot" JSONB NOT NULL,
    "render_hash" TEXT NOT NULL,
    "pdf_asset_ref" TEXT,
    "accepted_snapshot" JSONB,
    "accepted_at" TIMESTAMP(3),
    "accepted_by" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_share_tokens" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "last_viewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_share_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_pending_acceptances" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "title" TEXT,
    "selected_line_ids" JSONB NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "delivery_state" TEXT NOT NULL DEFAULT 'pending',
    "begin_key_hash" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "confirm_key_hash" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "voided_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "ua" TEXT,

    CONSTRAINT "quote_pending_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "version_id" TEXT,
    "kind" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "data" JSONB,
    "ip" TEXT,
    "ua" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quote_versions_workspace_id_quote_id_id_key" ON "quote_versions"("workspace_id", "quote_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_versions_workspace_id_quote_id_version_no_key" ON "quote_versions"("workspace_id", "quote_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "quote_share_tokens_token_hash_key" ON "quote_share_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "quote_share_tokens_workspace_id_expires_at_idx" ON "quote_share_tokens"("workspace_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "quote_share_tokens_workspace_id_quote_id_version_id_id_key" ON "quote_share_tokens"("workspace_id", "quote_id", "version_id", "id");

-- CreateIndex
CREATE INDEX "quote_pending_acceptances_workspace_id_expires_at_idx" ON "quote_pending_acceptances"("workspace_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "quote_pending_acceptances_workspace_id_token_id_begin_key_h_key" ON "quote_pending_acceptances"("workspace_id", "token_id", "begin_key_hash");

-- CreateIndex
CREATE INDEX "quote_events_workspace_id_quote_id_at_idx" ON "quote_events"("workspace_id", "quote_id", "at");

-- AddForeignKey
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_workspace_id_quote_id_fkey" FOREIGN KEY ("workspace_id", "quote_id") REFERENCES "quotes"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_share_tokens" ADD CONSTRAINT "quote_share_tokens_workspace_id_quote_id_fkey" FOREIGN KEY ("workspace_id", "quote_id") REFERENCES "quotes"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_share_tokens" ADD CONSTRAINT "quote_share_tokens_workspace_id_quote_id_version_id_fkey" FOREIGN KEY ("workspace_id", "quote_id", "version_id") REFERENCES "quote_versions"("workspace_id", "quote_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_pending_acceptances" ADD CONSTRAINT "quote_pending_acceptances_workspace_id_quote_id_fkey" FOREIGN KEY ("workspace_id", "quote_id") REFERENCES "quotes"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_pending_acceptances" ADD CONSTRAINT "quote_pending_acceptances_workspace_id_quote_id_version_id_fkey" FOREIGN KEY ("workspace_id", "quote_id", "version_id", "token_id") REFERENCES "quote_share_tokens"("workspace_id", "quote_id", "version_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_workspace_id_quote_id_fkey" FOREIGN KEY ("workspace_id", "quote_id") REFERENCES "quotes"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_workspace_id_quote_id_version_id_fkey" FOREIGN KEY ("workspace_id", "quote_id", "version_id") REFERENCES "quote_versions"("workspace_id", "quote_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE quote_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_versions_read ON quote_versions FOR SELECT USING (workspace_id=current_workspace_id());
CREATE POLICY quote_versions_insert ON quote_versions FOR INSERT WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_versions_update ON quote_versions FOR UPDATE USING (workspace_id=current_workspace_id()) WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_versions_delete ON quote_versions FOR DELETE USING (workspace_id=current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON quote_versions TO customer_ops_app;
GRANT SELECT ON quote_versions TO customer_ops_ro;

ALTER TABLE quote_share_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_share_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_share_tokens_read ON quote_share_tokens FOR SELECT USING (workspace_id=current_workspace_id());
CREATE POLICY quote_share_tokens_insert ON quote_share_tokens FOR INSERT WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_share_tokens_update ON quote_share_tokens FOR UPDATE USING (workspace_id=current_workspace_id()) WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_share_tokens_delete ON quote_share_tokens FOR DELETE USING (workspace_id=current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON quote_share_tokens TO customer_ops_app;
GRANT SELECT ON quote_share_tokens TO customer_ops_ro;

ALTER TABLE quote_pending_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_pending_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_pending_acceptances_read ON quote_pending_acceptances FOR SELECT USING (workspace_id=current_workspace_id());
CREATE POLICY quote_pending_acceptances_insert ON quote_pending_acceptances FOR INSERT WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_pending_acceptances_update ON quote_pending_acceptances FOR UPDATE USING (workspace_id=current_workspace_id()) WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_pending_acceptances_delete ON quote_pending_acceptances FOR DELETE USING (workspace_id=current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON quote_pending_acceptances TO customer_ops_app;
GRANT SELECT ON quote_pending_acceptances TO customer_ops_ro;

ALTER TABLE quote_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_events FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_events_read ON quote_events FOR SELECT USING (workspace_id=current_workspace_id());
CREATE POLICY quote_events_insert ON quote_events FOR INSERT WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_events_update ON quote_events FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY quote_events_delete ON quote_events FOR DELETE USING (false);
GRANT SELECT, INSERT ON quote_events TO customer_ops_app;
GRANT SELECT ON quote_events TO customer_ops_ro;

REVOKE UPDATE, DELETE, TRUNCATE ON quote_events FROM customer_ops_app;
REVOKE TRUNCATE ON quote_versions, quote_share_tokens, quote_pending_acceptances FROM customer_ops_app;
ALTER TABLE quote_versions ADD CONSTRAINT quote_version_disposition CHECK (disposition IN ('current','superseded','accepted') AND version_no>0 AND render_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX quote_one_current_version ON quote_versions(workspace_id,quote_id) WHERE disposition='current';
ALTER TABLE quote_share_tokens ADD CONSTRAINT quote_token_hash CHECK (token_hash ~ '^[0-9a-f]{64}$' AND view_count>=0);
ALTER TABLE quote_pending_acceptances ADD CONSTRAINT quote_pending_state CHECK (attempts BETWEEN 0 AND 5 AND delivery_state IN ('pending','sent','failed') AND code_hash ~ '^[0-9a-f]{64}$' AND begin_key_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE quote_pending_acceptances ADD CONSTRAINT quote_pending_ttl CHECK (expires_at<=created_at+interval '10 minutes');

CREATE FUNCTION quote_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.workspace_id,NEW.quote_id,NEW.version_no,NEW.snapshot,NEW.render_hash,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.quote_id,OLD.version_no,OLD.snapshot,OLD.render_hash,OLD.created_at)
    THEN RAISE EXCEPTION 'Published quote snapshot is immutable'; END IF;
  IF OLD.accepted_snapshot IS NOT NULL AND ROW(NEW.accepted_snapshot,NEW.accepted_at,NEW.accepted_by)
      IS DISTINCT FROM ROW(OLD.accepted_snapshot,OLD.accepted_at,OLD.accepted_by)
    THEN RAISE EXCEPTION 'Accepted quote evidence is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_version_immutable BEFORE UPDATE ON quote_versions FOR EACH ROW EXECUTE FUNCTION quote_version_immutable();

CREATE FUNCTION quote_token_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.expires_at IS DISTINCT FROM (SELECT (snapshot->>'valid_until')::timestamptz AT TIME ZONE 'UTC'
      FROM quote_versions WHERE id=NEW.version_id AND workspace_id=NEW.workspace_id AND quote_id=NEW.quote_id)
      THEN RAISE EXCEPTION 'Token expiry must match the published quote'; END IF;
  ELSE
    IF ROW(NEW.id,NEW.workspace_id,NEW.quote_id,NEW.version_id,NEW.token_hash,NEW.expires_at,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.quote_id,OLD.version_id,OLD.token_hash,OLD.expires_at,OLD.created_at)
      THEN RAISE EXCEPTION 'Quote token identity and expiry are immutable'; END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
      THEN RAISE EXCEPTION 'Quote token revocation is permanent'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_token_immutable BEFORE INSERT OR UPDATE ON quote_share_tokens FOR EACH ROW EXECUTE FUNCTION quote_token_immutable();

-- Capability bootstrap: reveal ONLY the workspace for one exact hashed token.
-- The runtime immediately enters that workspace's ordinary RLS transaction and
-- re-reads token/version state. No raw token, snapshot or identity is returned.
CREATE FUNCTION quote_token_workspace(p_hash text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT workspace_id FROM public.quote_share_tokens
  WHERE token_hash=p_hash AND p_hash ~ '^[0-9a-f]{64}$' LIMIT 1
$$;
REVOKE ALL ON FUNCTION quote_token_workspace(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quote_token_workspace(text) TO customer_ops_app;

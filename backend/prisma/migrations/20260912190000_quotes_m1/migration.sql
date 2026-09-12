-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "valid_until" TIMESTAMP(3) NOT NULL,
    "brand_slug" TEXT,
    "vendor_of_record" TEXT NOT NULL,
    "delivery_partner" TEXT,
    "split_rule" JSONB NOT NULL DEFAULT '{"kind":"none"}',
    "terms_md" TEXT NOT NULL DEFAULT '',
    "internal_notes_md" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT NOT NULL,
    "locked_for_send" BOOLEAN NOT NULL DEFAULT false,
    "parent_quote_id" TEXT,
    "tax_estimate_cents" INTEGER,
    "current_version_no" INTEGER NOT NULL DEFAULT 0,
    "federated" JSONB NOT NULL DEFAULT '{"status":"pending"}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_counters" (
    "workspace_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL,

    CONSTRAINT "quote_counters_pkey" PRIMARY KEY ("workspace_id","year")
);

-- CreateTable
CREATE TABLE "quote_sections" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL,
    "heading" TEXT NOT NULL,
    "body_md" TEXT NOT NULL DEFAULT '',
    "internal_basis_md" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "quote_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_lines" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "section_id" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description_md" TEXT NOT NULL DEFAULT '',
    "qty" DECIMAL(16,4) NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'item',
    "unit_price_cents" INTEGER NOT NULL,
    "discount_bps" INTEGER,
    "discount_cents" INTEGER,
    "status_tag" TEXT NOT NULL DEFAULT 'proposed',
    "recurring" JSONB,
    "hourly" JSONB,
    "milestone" JSONB,
    "payment_split" JSONB NOT NULL DEFAULT '[50,50]',
    "option_group" JSONB,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "price_book_item_id" TEXT,

    CONSTRAINT "quote_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_book_items" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "default_price_cents" INTEGER NOT NULL,
    "description_md" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "price_book_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_costs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "quote_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_recipients" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "added_by" TEXT NOT NULL,

    CONSTRAINT "quote_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_attachments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "quote_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotes_workspace_id_customer_id_status_idx" ON "quotes"("workspace_id", "customer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_workspace_id_id_key" ON "quotes"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_workspace_id_number_key" ON "quotes"("workspace_id", "number");

-- CreateIndex
CREATE INDEX "quote_sections_workspace_id_quote_id_position_idx" ON "quote_sections"("workspace_id", "quote_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "quote_sections_workspace_id_quote_id_id_key" ON "quote_sections"("workspace_id", "quote_id", "id");

-- CreateIndex
CREATE INDEX "quote_lines_workspace_id_quote_id_position_idx" ON "quote_lines"("workspace_id", "quote_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "price_book_items_workspace_id_id_key" ON "price_book_items"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "price_book_items_workspace_id_sku_key" ON "price_book_items"("workspace_id", "sku");

-- CreateIndex
CREATE INDEX "quote_costs_workspace_id_quote_id_idx" ON "quote_costs"("workspace_id", "quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_recipients_workspace_id_quote_id_email_key" ON "quote_recipients"("workspace_id", "quote_id", "email");

-- CreateIndex
CREATE INDEX "quote_attachments_workspace_id_quote_id_idx" ON "quote_attachments"("workspace_id", "quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_workspaceId_id_key" ON "customers"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_workspace_id_customer_id_fkey" FOREIGN KEY ("workspace_id", "customer_id") REFERENCES "customers"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_workspace_id_parent_quote_id_fkey" FOREIGN KEY ("workspace_id", "parent_quote_id") REFERENCES "quotes"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_counters" ADD CONSTRAINT "quote_counters_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_sections" ADD CONSTRAINT "quote_sections_workspace_id_quote_id_fkey" FOREIGN KEY ("workspace_id", "quote_id") REFERENCES "quotes"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_workspace_id_quote_id_fkey" FOREIGN KEY ("workspace_id", "quote_id") REFERENCES "quotes"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_workspace_id_quote_id_section_id_fkey" FOREIGN KEY ("workspace_id", "quote_id", "section_id") REFERENCES "quote_sections"("workspace_id", "quote_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_workspace_id_price_book_item_id_fkey" FOREIGN KEY ("workspace_id", "price_book_item_id") REFERENCES "price_book_items"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_items" ADD CONSTRAINT "price_book_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_costs" ADD CONSTRAINT "quote_costs_workspace_id_quote_id_fkey" FOREIGN KEY ("workspace_id", "quote_id") REFERENCES "quotes"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_recipients" ADD CONSTRAINT "quote_recipients_workspace_id_quote_id_fkey" FOREIGN KEY ("workspace_id", "quote_id") REFERENCES "quotes"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_attachments" ADD CONSTRAINT "quote_attachments_workspace_id_quote_id_fkey" FOREIGN KEY ("workspace_id", "quote_id") REFERENCES "quotes"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quotes" FORCE ROW LEVEL SECURITY;
CREATE POLICY quotes_read ON "quotes" FOR SELECT USING (workspace_id=current_workspace_id());
CREATE POLICY quotes_insert ON "quotes" FOR INSERT WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quotes_update ON "quotes" FOR UPDATE USING (workspace_id=current_workspace_id()) WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quotes_delete ON "quotes" FOR DELETE USING (workspace_id=current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "quotes" TO customer_ops_app;
GRANT SELECT ON "quotes" TO customer_ops_ro;

ALTER TABLE "quote_sections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quote_sections" FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_sections_read ON "quote_sections" FOR SELECT USING (workspace_id=current_workspace_id());
CREATE POLICY quote_sections_insert ON "quote_sections" FOR INSERT WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_sections_update ON "quote_sections" FOR UPDATE USING (workspace_id=current_workspace_id()) WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_sections_delete ON "quote_sections" FOR DELETE USING (workspace_id=current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "quote_sections" TO customer_ops_app;
GRANT SELECT ON "quote_sections" TO customer_ops_ro;

ALTER TABLE "quote_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quote_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_lines_read ON "quote_lines" FOR SELECT USING (workspace_id=current_workspace_id());
CREATE POLICY quote_lines_insert ON "quote_lines" FOR INSERT WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_lines_update ON "quote_lines" FOR UPDATE USING (workspace_id=current_workspace_id()) WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_lines_delete ON "quote_lines" FOR DELETE USING (workspace_id=current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "quote_lines" TO customer_ops_app;
GRANT SELECT ON "quote_lines" TO customer_ops_ro;

ALTER TABLE "price_book_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_book_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY price_book_items_read ON "price_book_items" FOR SELECT USING (workspace_id=current_workspace_id());
CREATE POLICY price_book_items_insert ON "price_book_items" FOR INSERT WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY price_book_items_update ON "price_book_items" FOR UPDATE USING (workspace_id=current_workspace_id()) WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY price_book_items_delete ON "price_book_items" FOR DELETE USING (workspace_id=current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "price_book_items" TO customer_ops_app;
GRANT SELECT ON "price_book_items" TO customer_ops_ro;

ALTER TABLE "quote_costs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quote_costs" FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_costs_read ON "quote_costs" FOR SELECT USING (workspace_id=current_workspace_id());
CREATE POLICY quote_costs_insert ON "quote_costs" FOR INSERT WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_costs_update ON "quote_costs" FOR UPDATE USING (workspace_id=current_workspace_id()) WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_costs_delete ON "quote_costs" FOR DELETE USING (workspace_id=current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "quote_costs" TO customer_ops_app;
GRANT SELECT ON "quote_costs" TO customer_ops_ro;

ALTER TABLE "quote_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quote_recipients" FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_recipients_read ON "quote_recipients" FOR SELECT USING (workspace_id=current_workspace_id());
CREATE POLICY quote_recipients_insert ON "quote_recipients" FOR INSERT WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_recipients_update ON "quote_recipients" FOR UPDATE USING (workspace_id=current_workspace_id()) WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_recipients_delete ON "quote_recipients" FOR DELETE USING (workspace_id=current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "quote_recipients" TO customer_ops_app;
GRANT SELECT ON "quote_recipients" TO customer_ops_ro;

ALTER TABLE "quote_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quote_attachments" FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_attachments_read ON "quote_attachments" FOR SELECT USING (workspace_id=current_workspace_id());
CREATE POLICY quote_attachments_insert ON "quote_attachments" FOR INSERT WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_attachments_update ON "quote_attachments" FOR UPDATE USING (workspace_id=current_workspace_id()) WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_attachments_delete ON "quote_attachments" FOR DELETE USING (workspace_id=current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "quote_attachments" TO customer_ops_app;
GRANT SELECT ON "quote_attachments" TO customer_ops_ro;

ALTER TABLE "quote_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quote_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_counters_read ON "quote_counters" FOR SELECT USING (workspace_id=current_workspace_id());
CREATE POLICY quote_counters_insert ON "quote_counters" FOR INSERT WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_counters_update ON "quote_counters" FOR UPDATE USING (workspace_id=current_workspace_id()) WITH CHECK (workspace_id=current_workspace_id());
CREATE POLICY quote_counters_delete ON "quote_counters" FOR DELETE USING (false);
GRANT SELECT, INSERT, UPDATE ON "quote_counters" TO customer_ops_app;
GRANT SELECT ON "quote_counters" TO customer_ops_ro;

ALTER TABLE quotes ADD CONSTRAINT quotes_status_check CHECK (status IN ('draft','sent','viewed','accepted','declined','expired','voided'));
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_money_check CHECK (qty>=0 AND unit_price_cents>=0 AND (discount_bps IS NULL OR discount_cents IS NULL) AND (discount_bps IS NULL OR discount_bps BETWEEN 0 AND 10000) AND (discount_cents IS NULL OR discount_cents>=0));
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_kind_check CHECK (kind IN ('one_time','milestone','recurring','hourly','option','included','excluded'));
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_status_check CHECK (status_tag IN ('agreed','proposed'));
ALTER TABLE quote_sections ADD CONSTRAINT quote_sections_kind_check CHECK (kind IN ('summary','scope','acceptance','terms','custom'));
ALTER TABLE quote_recipients ADD CONSTRAINT quote_recipients_role_check CHECK (role IN ('to','cc'));
ALTER TABLE quote_costs ADD CONSTRAINT quote_costs_kind_check CHECK (kind IN ('hosting','ai_usage','third_party','other') AND amount_cents>=0);
CREATE FUNCTION prevent_quote_counter_reuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.workspace_id<>OLD.workspace_id OR NEW.year<>OLD.year OR NEW.last_number<=OLD.last_number THEN RAISE EXCEPTION 'Quote numbers cannot be reused'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quote_counter_monotonic BEFORE UPDATE ON quote_counters FOR EACH ROW EXECUTE FUNCTION prevent_quote_counter_reuse();
INSERT INTO price_book_items(id,workspace_id,sku,label,kind,unit,default_price_cents,description_md,active) SELECT md5(id||':quotes:hosting')::uuid::text,id,'hosting','Hosting','recurring','month',35000,'Monthly hosting',true FROM workspaces WHERE slug='magic-unicorn' ON CONFLICT(workspace_id,sku) DO NOTHING;
INSERT INTO price_book_items(id,workspace_id,sku,label,kind,unit,default_price_cents,description_md,active) SELECT md5(id||':quotes:change-work')::uuid::text,id,'change-work','Change work','hourly','hour',15000,'Minimum two hours; same-day surcharge multiplier 1.5',true FROM workspaces WHERE slug='magic-unicorn' ON CONFLICT(workspace_id,sku) DO NOTHING;
INSERT INTO price_book_items(id,workspace_id,sku,label,kind,unit,default_price_cents,description_md,active) SELECT md5(id||':quotes:package-entry')::uuid::text,id,'package-entry','Entry package','option','package',60000,'',true FROM workspaces WHERE slug='magic-unicorn' ON CONFLICT(workspace_id,sku) DO NOTHING;
INSERT INTO price_book_items(id,workspace_id,sku,label,kind,unit,default_price_cents,description_md,active) SELECT md5(id||':quotes:package-standard')::uuid::text,id,'package-standard','Standard package','option','package',140000,'',true FROM workspaces WHERE slug='magic-unicorn' ON CONFLICT(workspace_id,sku) DO NOTHING;
INSERT INTO price_book_items(id,workspace_id,sku,label,kind,unit,default_price_cents,description_md,active) SELECT md5(id||':quotes:package-extended')::uuid::text,id,'package-extended','Extended package','option','package',290000,'',true FROM workspaces WHERE slug='magic-unicorn' ON CONFLICT(workspace_id,sku) DO NOTHING;
INSERT INTO price_book_items(id,workspace_id,sku,label,kind,unit,default_price_cents,description_md,active) SELECT md5(id||':quotes:ai-base')::uuid::text,id,'ai-base','AI allowance','recurring','month',5000,'',true FROM workspaces WHERE slug='magic-unicorn' ON CONFLICT(workspace_id,sku) DO NOTHING;
INSERT INTO price_book_items(id,workspace_id,sku,label,kind,unit,default_price_cents,description_md,active) SELECT md5(id||':quotes:ai-plus')::uuid::text,id,'ai-plus','AI allowance plus','recurring','month',10000,'',true FROM workspaces WHERE slug='magic-unicorn' ON CONFLICT(workspace_id,sku) DO NOTHING;

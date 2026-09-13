-- Run as customer_ops_app on a throwaway database, after all migrations.
-- Owner prerequisite: two workspaces with ids quotes-proof-a and quotes-proof-b.
-- docs/quotes/verify-isolated.cjs creates them and runs this script on a fresh DB.
-- The inner block deliberately rolls back fixtures after all assertions.
DO $proof$
DECLARE
  t text; n bigint; changed bigint; specimen jsonb;
  tables text[] := ARRAY['quotes','quote_sections','quote_lines','quote_costs','quote_recipients','quote_attachments','quote_counters','price_book_items','quote_versions','quote_share_tokens','quote_pending_acceptances','quote_events','workspace_letterheads'];
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) OR current_user<>'customer_ops_app' THEN RAISE EXCEPTION 'Use the NOBYPASSRLS app role'; END IF;
  PERFORM set_config('app.current_workspace','',true);
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=('public.'||t)::regclass AND relrowsecurity AND relforcerowsecurity) THEN RAISE EXCEPTION 'Missing FORCE RLS: %',t; END IF;
    SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename=t;
    IF n<>4 THEN RAISE EXCEPTION 'Expected four policies: %',t; END IF;
    EXECUTE format('SELECT count(*) FROM %I',t) INTO n;
    IF n<>0 THEN RAISE EXCEPTION 'No-GUC disclosure: %',t; END IF;
  END LOOP;
  BEGIN
    PERFORM set_config('app.current_workspace','quotes-proof-a',true);
    INSERT INTO customers(id,"workspaceId","contactId","updatedAt") VALUES('quotes-proof-c','quotes-proof-a','synthetic-contact',now());
    INSERT INTO quotes(id,workspace_id,customer_id,number,title,vendor_of_record,valid_until,created_by,updated_at) VALUES('proof-q','quotes-proof-a','quotes-proof-c','Q-proof','Synthetic proposal','Synthetic vendor','2099-01-01','fixture',now());
    INSERT INTO quote_sections(id,workspace_id,quote_id,kind,heading) VALUES('proof-s','quotes-proof-a','proof-q','scope','Synthetic scope');
    INSERT INTO quote_lines(id,workspace_id,quote_id,kind,label,unit_price_cents) VALUES('proof-l','quotes-proof-a','proof-q','included','Synthetic deliverable',0);
    INSERT INTO quote_costs(id,workspace_id,quote_id,label,kind,amount_cents) VALUES('proof-c','quotes-proof-a','proof-q','Synthetic cost','other',0);
    INSERT INTO quote_recipients(id,workspace_id,quote_id,name,email,role,added_by) VALUES('proof-r','quotes-proof-a','proof-q','Synthetic recipient','recipient@example.invalid','to','fixture');
    INSERT INTO quote_attachments(id,workspace_id,quote_id,label,asset_id) VALUES('proof-a','quotes-proof-a','proof-q','Synthetic attachment','https://example.invalid');
    INSERT INTO quote_counters(workspace_id,year,last_number) VALUES('quotes-proof-a',2099,1);
    INSERT INTO price_book_items(id,workspace_id,sku,label,kind,unit,default_price_cents) VALUES('proof-p','quotes-proof-a','synthetic','Synthetic','included','item',0);
    INSERT INTO quote_versions(id,workspace_id,quote_id,version_no,snapshot,render_hash) VALUES('proof-v','quotes-proof-a','proof-q',1,'{"valid_until":"2099-01-01T00:00:00.000Z"}',repeat('a',64));
    INSERT INTO quote_share_tokens(id,workspace_id,quote_id,version_id,token_hash,expires_at) VALUES('proof-t','quotes-proof-a','proof-q','proof-v',repeat('b',64),'2099-01-01');
    INSERT INTO quote_pending_acceptances(id,workspace_id,quote_id,version_id,token_id,name,email,selected_line_ids,code_hash,begin_key_hash,request_hash,expires_at) VALUES('proof-pa','quotes-proof-a','proof-q','proof-v','proof-t','Synthetic recipient','recipient@example.invalid','[]',repeat('c',64),repeat('d',64),repeat('e',64),now()+interval '5 minutes');
    INSERT INTO quote_events(id,workspace_id,quote_id,kind,actor) VALUES('proof-e','quotes-proof-a','proof-q','created','fixture');
    INSERT INTO workspace_letterheads(workspace_id,accounting_entity_id) VALUES('quotes-proof-a','synthetic-entity');
    FOREACH t IN ARRAY tables LOOP
      PERFORM set_config('app.current_workspace','quotes-proof-a',true);
      EXECUTE format('SELECT to_jsonb(x) FROM %I x WHERE workspace_id=$1 LIMIT 1',t) INTO specimen USING 'quotes-proof-a';
      IF specimen IS NULL THEN RAISE EXCEPTION 'Missing fixture: %',t; END IF;
      PERFORM set_config('app.current_workspace','quotes-proof-b',true);
      EXECUTE format('SELECT count(*) FROM %I WHERE workspace_id=$1',t) INTO n USING 'quotes-proof-a';
      IF n<>0 THEN RAISE EXCEPTION 'Cross-read: %',t; END IF;
      BEGIN
        EXECUTE format('INSERT INTO %I SELECT (jsonb_populate_record(NULL::%I,$1)).*',t,t) USING specimen;
        RAISE EXCEPTION 'Cross-insert accepted: %',t;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
        WHEN raise_exception THEN IF t<>'quote_share_tokens' OR SQLERRM<>'Token expiry must match the published quote' THEN RAISE; END IF; END;
      BEGIN
        EXECUTE format('UPDATE %I SET workspace_id=workspace_id WHERE workspace_id=$1',t) USING 'quotes-proof-a'; GET DIAGNOSTICS changed=ROW_COUNT;
        IF changed<>0 THEN RAISE EXCEPTION 'Cross-update: %',t; END IF;
      EXCEPTION WHEN insufficient_privilege THEN IF t<>'quote_events' THEN RAISE; END IF; END;
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE workspace_id=$1',t) USING 'quotes-proof-a'; GET DIAGNOSTICS changed=ROW_COUNT;
        IF changed<>0 THEN RAISE EXCEPTION 'Cross-delete: %',t; END IF;
      EXCEPTION WHEN insufficient_privilege THEN IF t NOT IN ('quote_events','quote_counters') THEN RAISE; END IF; END;
    END LOOP;
    RAISE EXCEPTION USING ERRCODE='ZQ001',MESSAGE='fixture rollback';
  EXCEPTION WHEN SQLSTATE 'ZQ001' THEN NULL; END;
END $proof$;

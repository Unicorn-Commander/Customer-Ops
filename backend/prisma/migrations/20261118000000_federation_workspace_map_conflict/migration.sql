-- R3-1 (GATE-175): a contact-ops row the Contact-Ops org lookup contradicts is
-- recorded as in conflict (the tenant the lookup names) and is not routable. The
-- row's own target is never changed; the column is cleared only when a later
-- lookup confirms the row. Nullable, no default: every existing row stays as is.
ALTER TABLE "federation_workspace_map" ADD COLUMN "conflict_tenant_id" TEXT;

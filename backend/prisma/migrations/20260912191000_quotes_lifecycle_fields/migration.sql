ALTER TABLE quotes ADD COLUMN sent_at TIMESTAMP(3), ADD COLUMN accepted_at TIMESTAMP(3), ADD COLUMN accepted_by JSONB, ADD COLUMN decline_reason TEXT;

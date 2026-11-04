ALTER TABLE facebook_posts ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE facebook_posts ADD COLUMN IF NOT EXISTS platform text;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS updated_posts integer NOT NULL DEFAULT 0 CHECK (updated_posts >= 0);

-- Customer-managed search profiles. Additive only: existing configs keep NULL description.
-- The description is what the customer wrote when saving that configuration version, so editing a profile
-- (a new scan_configs version) never rewrites what an older version was searching for.
ALTER TABLE scan_configs ADD COLUMN IF NOT EXISTS description text CHECK (description IS NULL OR length(description) <= 1000);
ALTER TABLE scan_configs ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

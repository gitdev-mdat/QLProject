-- One bounded complementary search after an initial scan. Existing recurring and first scan rows stay in place.
ALTER TABLE search_jobs DROP CONSTRAINT IF EXISTS search_jobs_kind_check;
ALTER TABLE search_jobs ADD CONSTRAINT search_jobs_kind_check
  CHECK (kind IN ('scheduled', 'initial', 'manual', 'followup'));

-- A profile/configuration version can have at most one follow-up job, including terminal jobs.
CREATE UNIQUE INDEX IF NOT EXISTS search_jobs_one_followup_per_version
  ON search_jobs(search_profile_id, configuration_version) WHERE kind = 'followup';

-- Null means the historical run predates this observable. New runs record the number of newly inserted,
-- lead-shaped posts with enough author/text evidence to qualify under the existing QLead lead criteria.
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS usable_new_posts integer
  CHECK (usable_new_posts IS NULL OR usable_new_posts >= 0);
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS keywords_used jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(keywords_used) = 'array');

CREATE INDEX IF NOT EXISTS search_jobs_initial_discovery_idx
  ON search_jobs(search_profile_id, configuration_version, kind, created_at)
  WHERE kind IN ('initial', 'followup');

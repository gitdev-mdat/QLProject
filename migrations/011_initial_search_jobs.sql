-- First scan for a newly activated search profile. Additive only: existing jobs become kind 'scheduled'.
-- An 'initial' job is created when a profile is saved enabled and has never been scanned; workers claim it ahead
-- of routine slots. At most one live initial job per profile (a cancelled one, e.g. paused, may be replaced).
ALTER TABLE search_jobs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'scheduled' CHECK (kind IN ('scheduled', 'initial'));
CREATE UNIQUE INDEX IF NOT EXISTS search_jobs_one_initial_per_profile ON search_jobs(search_profile_id) WHERE kind = 'initial' AND status <> 'cancelled';

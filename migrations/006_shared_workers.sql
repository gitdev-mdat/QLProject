-- Shared Muse workers. Forward-only and additive, with one relaxation: agent_connections.credential_hash becomes
-- nullable so a customer's search profile can own posts, configs and scan history without holding a Muse credential.
-- Existing rows become kind 'legacy_agent' and keep their credential, ownership and history unchanged.
ALTER TABLE agent_connections ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'legacy_agent'
  CHECK (kind IN ('legacy_agent', 'search_profile'));
ALTER TABLE agent_connections ALTER COLUMN credential_hash DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_connections_kind_credential_chk') THEN
    ALTER TABLE agent_connections ADD CONSTRAINT agent_connections_kind_credential_chk
      CHECK ((kind = 'legacy_agent') = (credential_hash IS NOT NULL));
  END IF;
END $$;

-- Admin-managed execution resources. A worker is never a customer identity and owns no data.
CREATE TABLE IF NOT EXISTS muse_workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 200),
  credential_hash char(64) NOT NULL UNIQUE,
  credential_status text NOT NULL DEFAULT 'active' CHECK (credential_status IN ('active', 'revoked')),
  status text NOT NULL DEFAULT 'paused' CHECK (status IN ('active', 'draining', 'paused', 'unavailable')),
  authorized_sources jsonb NOT NULL DEFAULT '["social.search"]'::jsonb CHECK (jsonb_typeof(authorized_sources) = 'array'),
  max_jobs_per_claim integer NOT NULL DEFAULT 2 CHECK (max_jobs_per_claim BETWEEN 1 AND 10),
  lease_minutes integer NOT NULL DEFAULT 20 CHECK (lease_minutes BETWEEN 1 AND 240),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  last_success_at timestamptz
);

-- One unit of work per search profile per schedule slot. scan_id is issued by the server, never by the worker.
CREATE TABLE IF NOT EXISTS search_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_profile_id uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  configuration_version integer NOT NULL,
  scan_id text NOT NULL UNIQUE,
  scheduled_for timestamptz NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'blocked', 'needs_reauthorization', 'cancelled')),
  required_sources jsonb NOT NULL CHECK (jsonb_typeof(required_sources) = 'array'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  claimed_by_worker_id uuid REFERENCES muse_workers(id) ON DELETE SET NULL,
  current_attempt_id uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (search_profile_id, scheduled_for),
  FOREIGN KEY (search_profile_id, configuration_version) REFERENCES scan_configs(agent_connection_id, version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS search_jobs_claimable_idx ON search_jobs(available_at, scheduled_for) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS search_jobs_worker_idx ON search_jobs(claimed_by_worker_id) WHERE status = 'claimed';
-- At most one open job per profile: a slow or blocked profile accumulates delay, not a backlog of duplicate jobs.
CREATE UNIQUE INDEX IF NOT EXISTS search_jobs_one_open_per_profile ON search_jobs(search_profile_id)
  WHERE status IN ('pending', 'claimed', 'blocked', 'needs_reauthorization');

-- Assignment history: which worker held which job, and how each attempt ended. Workers are retired, never deleted.
CREATE TABLE IF NOT EXISTS search_job_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES search_jobs(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES muse_workers(id) ON DELETE RESTRICT,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL,
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'running'
    CHECK (outcome IN ('running', 'completed', 'failed', 'needs_reauthorization', 'expired', 'released')),
  error jsonb,
  UNIQUE (job_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS search_job_attempts_worker_idx ON search_job_attempts(worker_id, claimed_at DESC);

-- Admin-only provenance on scan history. Customer-facing queries do not read these columns.
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS search_job_id uuid REFERENCES search_jobs(id) ON DELETE SET NULL;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS executed_by_worker_id uuid REFERENCES muse_workers(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS scan_runs_search_job_idx ON scan_runs(search_job_id) WHERE search_job_id IS NOT NULL;

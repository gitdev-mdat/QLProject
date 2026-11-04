-- Admin-controlled worker handoffs. Additive only.
-- Evidence columns on muse_workers let Admin judge standby readiness from history, without QLead ever contacting Muse.
ALTER TABLE muse_workers ADD COLUMN IF NOT EXISTS status_changed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE muse_workers ADD COLUMN IF NOT EXISTS connection_verified_at timestamptz;
ALTER TABLE muse_workers ADD COLUMN IF NOT EXISTS last_claim_at timestamptz;

-- One generalized record for every switch (01 -> 02 and back). Statuses:
--   preparing -> draining -> awaiting_worker_start -> verifying -> completed
--   any open status -> cancelled (before cutover) | failed (needs intervention)
CREATE TABLE IF NOT EXISTS worker_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_worker_id uuid NOT NULL REFERENCES muse_workers(id) ON DELETE RESTRICT,
  destination_worker_id uuid NOT NULL REFERENCES muse_workers(id) ON DELETE RESTRICT,
  mode text NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal', 'emergency')),
  status text NOT NULL DEFAULT 'preparing'
    CHECK (status IN ('preparing', 'draining', 'awaiting_worker_start', 'verifying', 'completed', 'cancelled', 'failed')),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  drain_started_at timestamptz,
  cutover_at timestamptz,
  destination_first_contact_at timestamptz,
  destination_first_claim_at timestamptz,
  destination_first_success_at timestamptz,
  finished_at timestamptz,
  released_jobs integer NOT NULL DEFAULT 0 CHECK (released_jobs >= 0),
  prepared_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  cutover_summary jsonb,
  failure_reason text,
  events jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(events) = 'array'),
  CHECK (source_worker_id <> destination_worker_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_handoffs_one_open ON worker_handoffs((true))
  WHERE status IN ('preparing', 'draining', 'awaiting_worker_start', 'verifying');
CREATE INDEX IF NOT EXISTS worker_handoffs_recent_idx ON worker_handoffs(created_at DESC);

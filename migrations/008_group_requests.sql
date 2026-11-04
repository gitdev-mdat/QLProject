-- Customer suggestions of Facebook groups for QLead's search sources. Additive only.
-- The URL is stored as submitted and as a normalized canonical form; QLead never fetches it automatically.
CREATE TABLE IF NOT EXISTS facebook_group_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_key text NOT NULL CHECK (length(group_key) BETWEEN 1 AND 100),
  group_url text NOT NULL CHECK (group_url LIKE 'https://www.facebook.com/groups/%'),
  submitted_url text NOT NULL CHECK (length(submitted_url) BETWEEN 1 AND 2048),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'approved', 'rejected', 'added')),
  admin_note text CHECK (admin_note IS NULL OR length(admin_note) <= 1000),
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, group_key)
);
CREATE INDEX IF NOT EXISTS facebook_group_requests_status_idx ON facebook_group_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS facebook_group_requests_group_idx ON facebook_group_requests(group_key);

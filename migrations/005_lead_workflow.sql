-- Per-user follow-up state and notes for leads. Additive: no existing table changes.
CREATE TABLE IF NOT EXISTS lead_states (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES facebook_posts(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('new', 'seen', 'contacted', 'interested', 'not_fit')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS lead_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES facebook_posts(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_notes_user_post_idx ON lead_notes(user_id, post_id, created_at DESC);

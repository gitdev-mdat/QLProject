-- Sessions for the QLead web app. Additive: no existing table changes.
-- Only a SHA-256 hash of the session token is stored; the raw token lives in an HttpOnly cookie.
CREATE TABLE IF NOT EXISTS web_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  created_via text NOT NULL CHECK (created_via IN ('dev_quick_login', 'password')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS web_sessions_user_id_idx ON web_sessions(user_id);

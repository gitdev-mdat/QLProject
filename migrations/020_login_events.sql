-- Successful sign-ins, for the Admin's per-customer login history. Additive only: one new table; no existing table,
-- column, constraint or row changes, and nothing reads it to authenticate.
--
-- What this is: one row per successful sign-in (email/password, registration, or DEV quick login), written in the same
-- statement that creates the web_sessions row, so a failed attempt never creates one. web_sessions stays the source of
-- truth for whether a session is active, expired or revoked; this table only adds the coarse device facts that
-- web_sessions never recorded.
--
-- What it is not: an activity log. It records nothing after sign-in (no page views, no last-seen time), and it stores no
-- token, token hash, cookie, password, IP address, location or raw User-Agent string: only coarse labels parsed from the
-- User-Agent at sign-in (device category, operating system family, browser family), each optional.
--
-- Retention: rows older than 180 days are deleted by every new sign-in (one indexed DELETE in the same statement, see
-- web/lib/server/session.ts). Sessions created before this migration have no row here: their device is shown as
-- unknown, never guessed.
CREATE TABLE IF NOT EXISTS web_login_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The session this sign-in created. SET NULL keeps the sign-in fact if a session row is ever removed.
  session_id uuid UNIQUE REFERENCES web_sessions(id) ON DELETE SET NULL,
  method text NOT NULL CHECK (method IN ('password', 'register', 'dev_quick_login')),
  device text CHECK (device IN ('desktop', 'mobile', 'tablet')),
  os text CHECK (os IS NULL OR length(os) BETWEEN 1 AND 40),
  browser text CHECK (browser IS NULL OR length(browser) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_login_events_user_idx ON web_login_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS web_login_events_created_idx ON web_login_events(created_at);

-- Admin history pages read one customer's sessions newest first.
CREATE INDEX IF NOT EXISTS web_sessions_user_created_idx ON web_sessions(user_id, created_at DESC);

-- Same protection as the other account tables: only the authenticated Next.js server (privileged connection) reads it.
ALTER TABLE web_login_events ENABLE ROW LEVEL SECURITY;

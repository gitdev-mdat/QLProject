-- Email + password sign-in for customers who register through the web app. Additive only.
-- Existing users (CLI-created, DEV test users) have no row here and are unaffected.
-- Only a salted scrypt hash of the password is stored.
CREATE TABLE IF NOT EXISTS user_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  password_hash text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  onboarding_completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS user_accounts_email_idx ON user_accounts(email);

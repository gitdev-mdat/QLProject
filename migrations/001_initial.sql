CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  credential_hash char(64) NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_connections_user_id_idx ON agent_connections(user_id);

CREATE TABLE IF NOT EXISTS scan_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_connection_id uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  enabled boolean NOT NULL DEFAULT true,
  keywords jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(keywords) = 'array'),
  location text NOT NULL,
  sources jsonb NOT NULL DEFAULT '["social.search"]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
  frequency_minutes integer NOT NULL CHECK (frequency_minutes BETWEEN 1 AND 10080),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_connection_id, version)
);
CREATE INDEX IF NOT EXISTS scan_configs_current_idx ON scan_configs(agent_connection_id, version DESC);

CREATE TABLE IF NOT EXISTS scan_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_connection_id uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  external_scan_id text NOT NULL CHECK (length(external_scan_id) BETWEEN 1 AND 200),
  configuration_version integer NOT NULL CHECK (configuration_version > 0),
  scanned_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  total_found integer NOT NULL CHECK (total_found >= 0),
  received_posts integer NOT NULL CHECK (received_posts >= 0),
  new_posts integer NOT NULL CHECK (new_posts >= 0),
  duplicates_skipped integer NOT NULL CHECK (duplicates_skipped >= 0),
  status text NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'partial', 'failed')),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (agent_connection_id, external_scan_id)
);
CREATE INDEX IF NOT EXISTS scan_runs_recent_idx ON scan_runs(agent_connection_id, received_at DESC);

CREATE TABLE IF NOT EXISTS facebook_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_connection_id uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  normalized_url text NOT NULL,
  original_url text NOT NULL,
  content text,
  author text,
  published_at timestamptz,
  source_type text,
  collected_via text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_connection_id, normalized_url)
);
CREATE INDEX IF NOT EXISTS facebook_posts_recent_idx ON facebook_posts(agent_connection_id, first_seen_at DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

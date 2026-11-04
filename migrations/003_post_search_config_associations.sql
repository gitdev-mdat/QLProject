CREATE TABLE IF NOT EXISTS facebook_post_search_configs (
  agent_connection_id uuid NOT NULL,
  normalized_url text NOT NULL,
  configuration_version integer NOT NULL CHECK (configuration_version > 0),
  associated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_connection_id, normalized_url, configuration_version),
  FOREIGN KEY (agent_connection_id, normalized_url)
    REFERENCES facebook_posts(agent_connection_id, normalized_url) ON DELETE CASCADE,
  FOREIGN KEY (agent_connection_id, configuration_version)
    REFERENCES scan_configs(agent_connection_id, version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS facebook_post_search_configs_version_idx
  ON facebook_post_search_configs(agent_connection_id, configuration_version);

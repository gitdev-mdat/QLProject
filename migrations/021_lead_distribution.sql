-- Per-profile delivery ledger. Search and post storage remain unbounded; this only limits what a customer receives.
CREATE TABLE IF NOT EXISTS lead_distribution_settings (
  search_profile_id uuid PRIMARY KEY REFERENCES agent_connections(id) ON DELETE CASCADE,
  max_leads_per_scan integer NOT NULL DEFAULT 10 CHECK (max_leads_per_scan BETWEEN 1 AND 1000),
  expiry_days integer NOT NULL DEFAULT 30 CHECK (expiry_days BETWEEN 1 AND 3650),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_distribution_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_profile_id uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  cycle_key text NOT NULL,
  max_leads integer NOT NULL CHECK (max_leads BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (search_profile_id, cycle_key),
  UNIQUE (id, search_profile_id)
);

CREATE TABLE IF NOT EXISTS profile_lead_deliveries (
  search_profile_id uuid NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES facebook_posts(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('queued', 'delivered', 'expired', 'rejected')),
  delivery_cycle_id uuid REFERENCES lead_distribution_cycles(id) ON DELETE SET NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  expired_at timestamptz,
  exclusion_reason text,
  PRIMARY KEY (search_profile_id, post_id),
  CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((state = 'expired') = (expired_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS profile_lead_deliveries_queue_idx
  ON profile_lead_deliveries(search_profile_id, queued_at, post_id) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS profile_lead_deliveries_cycle_idx
  ON profile_lead_deliveries(delivery_cycle_id) WHERE delivery_cycle_id IS NOT NULL;

-- Preserve every historical search-profile lead as already delivered; only future discoveries enter the queue.
INSERT INTO lead_distribution_settings (search_profile_id)
SELECT id FROM agent_connections WHERE kind = 'search_profile'
ON CONFLICT DO NOTHING;

INSERT INTO profile_lead_deliveries (search_profile_id, post_id, state, delivered_at)
SELECT fp.agent_connection_id, fp.id, 'delivered', fp.first_seen_at
FROM facebook_posts fp
JOIN agent_connections ac ON ac.id = fp.agent_connection_id AND ac.kind = 'search_profile'
WHERE EXISTS (SELECT 1 FROM facebook_post_search_configs psc
  JOIN scan_configs sc ON sc.agent_connection_id = psc.agent_connection_id AND sc.version = psc.configuration_version
  WHERE psc.agent_connection_id = fp.agent_connection_id AND psc.normalized_url = fp.normalized_url)
ON CONFLICT (search_profile_id, post_id) DO NOTHING;

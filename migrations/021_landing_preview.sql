-- Landing page "Thử tìm khách hàng": real-lead previews for visitors who are not signed in. Additive only: two new
-- tables; no existing table, column, constraint or row changes.
--
-- landing_previews: one row per landing search, whether it found anything or not. The row id is the only handle the
-- visitor's browser keeps (a random UUID, unguessable); after signing up, the same browser uses it to open the full
-- details of the posts it was shown, and nothing else. The visitor's own words are NOT stored: only a SHA-256 of the
-- normalised query (to count repeats), the post ids that were shown, and timings for the search-performance report.
--
-- landing_events: conversion funnel counters (search started, results shown, preview opened, signup clicked, ...).
-- No query text, IP address, User-Agent or cookie: a random per-browser id from localStorage, the preview id when the
-- event belongs to a search, and small numbers (latency, result count). Rows older than 180 days are deleted by the
-- event endpoint itself (one indexed DELETE now and then), so the table stays bounded.
CREATE TABLE IF NOT EXISTS landing_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_hash char(64) NOT NULL,
  post_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(post_ids) <= 2),
  result_count integer NOT NULL CHECK (result_count BETWEEN 0 AND 2),
  outcome text NOT NULL CHECK (outcome IN ('found', 'empty')),
  -- 'pool' = answered from the cached candidate pool; 'database' = the pool had to be (re)loaded for this request.
  served_from text NOT NULL CHECK (served_from IN ('pool', 'database', 'cache')),
  server_ms integer NOT NULL CHECK (server_ms >= 0),
  -- Signed-in visitors run the same search; their user id is kept so their own previews open without signing up.
  viewer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Set the first time a signed-in account opens this preview's full details (Signup-to-Value).
  claimed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS landing_previews_created_idx ON landing_previews(created_at);

CREATE TABLE IF NOT EXISTS landing_events (
  id bigserial PRIMARY KEY,
  event text NOT NULL CHECK (event IN (
    'landing_search_started', 'landing_search_results_shown', 'landing_search_empty', 'landing_search_failed',
    'landing_preview_opened', 'landing_signup_clicked', 'landing_signup_completed', 'landing_full_results_viewed')),
  visitor_id uuid,
  preview_id uuid REFERENCES landing_previews(id) ON DELETE SET NULL,
  -- 'auto' = the example search run when the section scrolls into view; 'user' = the visitor pressed Tìm / a suggestion.
  trigger text CHECK (trigger IS NULL OR trigger IN ('auto', 'user', 'suggestion')),
  result_count integer CHECK (result_count IS NULL OR result_count BETWEEN 0 AND 2),
  -- Click to first real lead on screen, measured in the browser (Search-to-Result Time).
  client_ms integer CHECK (client_ms IS NULL OR client_ms BETWEEN 0 AND 600000),
  reason text CHECK (reason IS NULL OR reason IN ('timeout', 'rate_limited', 'overloaded', 'network', 'server', 'expired')),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS landing_events_created_idx ON landing_events(created_at);
CREATE INDEX IF NOT EXISTS landing_events_event_idx ON landing_events(event, created_at DESC);

-- Same protection as every other table: only the Next.js server (privileged connection) reads or writes them.
ALTER TABLE landing_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE landing_events ENABLE ROW LEVEL SECURITY;

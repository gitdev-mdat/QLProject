-- Minimal acquisition attribution: coarse channel + validated campaign/content labels only.
-- Search text, full URLs, IP addresses and User-Agent values are never written here.
ALTER TABLE landing_events
  DROP CONSTRAINT IF EXISTS landing_events_event_check;
ALTER TABLE landing_events
  ADD CONSTRAINT landing_events_event_check CHECK (event IN (
    'landing_search_started', 'landing_search_results_shown', 'landing_search_empty', 'landing_search_failed',
    'landing_preview_opened', 'landing_signup_clicked', 'landing_signup_completed', 'landing_full_results_viewed',
    'blog_view', 'blog_cta_clicked'));

ALTER TABLE landing_events
  ADD COLUMN IF NOT EXISTS attribution_source text CHECK (attribution_source IS NULL OR attribution_source IN ('organic', 'blog', 'campaign', 'referral', 'direct', 'unknown')),
  ADD COLUMN IF NOT EXISTS attribution_campaign text CHECK (attribution_campaign IS NULL OR attribution_campaign ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  ADD COLUMN IF NOT EXISTS attribution_content text CHECK (attribution_content IS NULL OR attribution_content ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  ADD COLUMN IF NOT EXISTS page_path text CHECK (page_path IS NULL OR page_path ~ '^/blog(/[a-z0-9-]+)?$');

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_touch_source text CHECK (first_touch_source IS NULL OR first_touch_source IN ('organic', 'blog', 'campaign', 'referral', 'direct', 'unknown')),
  ADD COLUMN IF NOT EXISTS first_touch_campaign text CHECK (first_touch_campaign IS NULL OR first_touch_campaign ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  ADD COLUMN IF NOT EXISTS first_touch_content text CHECK (first_touch_content IS NULL OR first_touch_content ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  ADD COLUMN IF NOT EXISTS first_touch_at timestamptz;

CREATE INDEX IF NOT EXISTS users_first_touch_idx ON users(first_touch_source, first_touch_at DESC) WHERE first_touch_source IS NOT NULL;

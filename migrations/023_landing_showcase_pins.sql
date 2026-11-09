-- Landing page showcase: the two real leads QLead's own demo search found for the landing page's default request,
-- chosen once by the admin (ops/production-db.ts landing-showcase-pin) and kept until replaced. Additive only.
CREATE TABLE IF NOT EXISTS landing_showcase_pins (
  position smallint PRIMARY KEY CHECK (position BETWEEN 1 AND 2),
  post_id uuid NOT NULL REFERENCES facebook_posts(id) ON DELETE CASCADE,
  pinned_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE landing_showcase_pins ENABLE ROW LEVEL SECURITY;

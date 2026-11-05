-- Optional Vietnamese description, stored separately from verbatim source content.
ALTER TABLE facebook_posts ADD COLUMN IF NOT EXISTS summary_vi text;

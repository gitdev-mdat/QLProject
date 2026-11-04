-- Natural-language search profiles and customer-requested scans. Additive only.
--
-- keywords_source says where a configuration version's search phrases came from: 'description' means QLead
-- generated them from that version's description (the customer only wrote the description); 'manual' means the
-- customer maintained the phrases themselves. Every existing version had customer-reviewed phrases, so 'manual'.
ALTER TABLE scan_configs ADD COLUMN IF NOT EXISTS keywords_source text NOT NULL DEFAULT 'manual'
  CHECK (keywords_source IN ('description', 'manual'));

-- 'manual' jobs are scans a customer asked for ("Lưu và tìm lại", "Tìm lại ngay"). They use the same queue, leases
-- and one-open-job-per-profile rule as every other job; requested_by_user_id is kept for usage limits and audit.
ALTER TABLE search_jobs DROP CONSTRAINT IF EXISTS search_jobs_kind_check;
ALTER TABLE search_jobs ADD CONSTRAINT search_jobs_kind_check CHECK (kind IN ('scheduled', 'initial', 'manual'));
ALTER TABLE search_jobs ADD COLUMN IF NOT EXISTS requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS search_jobs_manual_requests_idx ON search_jobs(requested_by_user_id, created_at DESC) WHERE kind = 'manual';

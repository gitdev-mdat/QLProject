-- Registered users by first-touch channel who created a search profile and opened a lead within seven days.
-- Restrict to signup cohorts old enough to have completed the full seven-day window.
SELECT
  u.first_touch_source,
  count(DISTINCT u.id) AS activated_users
FROM users u
WHERE u.first_touch_source IS NOT NULL
  AND u.created_at < now() - interval '7 days'
  AND EXISTS (
    SELECT 1
    FROM agent_connections ac
    WHERE ac.user_id = u.id
      AND ac.kind = 'search_profile'
  )
  AND EXISTS (
    SELECT 1
    FROM lead_source_opens lso
    WHERE lso.user_id = u.id
      AND lso.first_opened_at >= u.created_at
      AND lso.first_opened_at < u.created_at + interval '7 days'
  )
GROUP BY u.first_touch_source
ORDER BY activated_users DESC, u.first_touch_source;

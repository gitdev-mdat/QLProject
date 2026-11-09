import pg from 'pg';

// ---- Landing showcase: one demo search for the landing page's default request, then two pinned leads, forever. ----
const DEMO_USER_NAME = 'QLead Demo (landing)';
const DEMO_PROFILE_NAME = 'Demo landing: quán F&B sắp khai trương';

async function demoProfile(db: pg.Client): Promise<{ user_id: string; profile_id: string } | undefined> {
  const { rows: [row] } = await db.query(`SELECT u.id AS user_id, ac.id AS profile_id FROM users u
    JOIN agent_connections ac ON ac.user_id = u.id AND ac.kind = 'search_profile' AND ac.name = $2
    WHERE u.display_name = $1 ORDER BY ac.created_at LIMIT 1`, [DEMO_USER_NAME, DEMO_PROFILE_NAME]);
  return row;
}

/** Creates the demo account (no login) + its search for DEFAULT_LANDING_REQUEST and queues the first search. */
export async function landingShowcaseStart(db: pg.Client) {
  const { DEFAULT_LANDING_REQUEST } = await import('../web/lib/landing-search.ts');
  const { planFromDescription } = await import('../src/search-plan.ts');
  const existing = await demoProfile(db);
  if (existing) { console.log(JSON.stringify({ already_exists: true, ...existing, next: 'npx tsx ops/production-db.ts landing-showcase-status' }, null, 2)); return; }
  const plan = planFromDescription(DEFAULT_LANDING_REQUEST);
  try {
    await db.query('BEGIN');
    const { rows: [user] } = await db.query<{ id: string }>('INSERT INTO users(display_name) VALUES ($1) RETURNING id', [DEMO_USER_NAME]);
    const { rows: [profile] } = await db.query<{ id: string }>("INSERT INTO agent_connections (user_id, name, kind) VALUES ($1, $2, 'search_profile') RETURNING id", [user!.id, DEMO_PROFILE_NAME]);
    await db.query(`INSERT INTO scan_configs (agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description, created_by_user_id)
      VALUES ($1, 1, true, $2, 'description', '', '["social.search"]', 360, $3, $4)`, [profile!.id, JSON.stringify(plan.queries), DEFAULT_LANDING_REQUEST, user!.id]);
    const job = await db.query(`INSERT INTO search_jobs (search_profile_id, configuration_version, scan_id, scheduled_for, required_sources, kind)
      VALUES ($1, 1, 'job-' || gen_random_uuid(), now(), '["social.search"]', 'initial') RETURNING id`, [profile!.id]);
    await db.query('COMMIT');
    console.log(JSON.stringify({ created: true, user_id: user!.id, profile_id: profile!.id, initial_job_id: job.rows[0].id, keywords: plan.queries,
      next: 'Wait for Muse (≈30 min), then: npx tsx ops/production-db.ts landing-showcase-status' }, null, 2));
  } catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error; }
}

export async function landingShowcaseStatus(db: pg.Client) {
  const demo = await demoProfile(db);
  if (!demo) { console.log('No demo search yet. Run: npx tsx ops/production-db.ts landing-showcase-start'); return; }
  const { rows: jobs } = await db.query(`SELECT kind, status, last_error, created_at, completed_at FROM search_jobs WHERE search_profile_id = $1 ORDER BY created_at DESC LIMIT 5`, [demo.profile_id]);
  const { rows: [posts] } = await db.query('SELECT count(*)::int AS posts FROM facebook_posts WHERE agent_connection_id = $1', [demo.profile_id]);
  const { rows: pins } = await db.query('SELECT sp.position, fp.original_url, sp.pinned_at FROM landing_showcase_pins sp JOIN facebook_posts fp ON fp.id = sp.post_id ORDER BY sp.position').catch(() => ({ rows: [] }));
  console.log(JSON.stringify({ ...demo, posts: posts.posts, jobs, pins }, null, 2));
  if (posts.posts) console.log('Posts are in. Pin the best two: npx tsx ops/production-db.ts landing-showcase-pin');
}

/** Picks the two best demo leads for the default request (or --post-ids=a,b), pins them, and pauses the demo search. */
export async function landingShowcasePin(db: pg.Client, argv: string[] = process.argv) {
  const { DEFAULT_LANDING_REQUEST, analyzeCandidates, rankLandingCandidates, nearestLandingCandidates } = await import('../web/lib/landing-search.ts');
  const { sourceLinkedPostSql } = await import('../src/lead-eligibility.ts');
  const demo = await demoProfile(db);
  if (!demo) throw new Error('No demo search. Run landing-showcase-start first.');
  const chosen = argv.find(a => a.startsWith('--post-ids='))?.split('=')[1]?.split(',').map(s => s.trim()).filter(Boolean);
  const { rows } = await db.query(`SELECT fp.id, fp.normalized_url, fp.original_url, fp.title, fp.content, fp.summary_vi, fp.published_at, fp.first_seen_at AS discovered_at
    FROM facebook_posts fp WHERE fp.agent_connection_id = $1 AND ${sourceLinkedPostSql('fp')}`, [demo.profile_id]);
  const pool = analyzeCandidates(rows);
  let picks = chosen?.length ? chosen.map(id => rows.find(row => row.id === id)).filter(Boolean)
    : rankLandingCandidates(DEFAULT_LANDING_REQUEST, pool).map(match => match.candidate);
  if (!chosen?.length && picks.length < 2) for (const match of nearestLandingCandidates(pool)) if (picks.length < 2 && !picks.some(p => p!.id === match.candidate.id)) picks.push(match.candidate);
  picks = picks.slice(0, 2);
  if (!picks.length) throw new Error(`No usable demo leads yet (${rows.length} source-linked posts). Check landing-showcase-status.`);
  try {
    await db.query('BEGIN');
    await db.query('DELETE FROM landing_showcase_pins');
    for (const [index, post] of picks.entries()) await db.query('INSERT INTO landing_showcase_pins(position, post_id) VALUES ($1, $2)', [index + 1, post!.id]);
    if (!argv.includes('--keep-scanning')) {
      // The showcase is fixed now: stop the demo search so it does not use Muse capacity. Re-enable to refresh.
      await db.query(`INSERT INTO scan_configs (agent_connection_id, version, enabled, keywords, keywords_source, location, sources, frequency_minutes, description, created_by_user_id)
        SELECT agent_connection_id, version + 1, false, keywords, keywords_source, location, sources, frequency_minutes, description, created_by_user_id
        FROM scan_configs WHERE agent_connection_id = $1 AND enabled ORDER BY version DESC LIMIT 1`, [demo.profile_id]);
      await db.query("UPDATE search_jobs SET status = 'cancelled', last_error = 'paused_by_customer', updated_at = now(), completed_at = now() WHERE search_profile_id = $1 AND status IN ('pending', 'blocked')", [demo.profile_id]);
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error; }
  console.log(JSON.stringify(picks.map((post, index) => ({ position: index + 1, post_id: post!.id, url: post!.original_url,
    text: String(post!.summary_vi ?? post!.content ?? post!.title ?? '').slice(0, 160) })), null, 2));
  console.log(`Pinned ${picks.length} showcase lead(s) from ${rows.length} demo posts. The landing page shows them within a minute.`);
}


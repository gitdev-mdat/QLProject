import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { pool } from './db.js';
import { resultSchema, type ScanPayload } from './validation.js';
import { toLeadRecord } from './lead-data.js';
import { associatePostsWithConfig, preparePosts, upsertPosts, type PreparedPost } from './ingest.js';
import { workerRoutes } from './worker-api.js';
import { wakeSignalRoutes } from './wake-signal.js';

// On Vercel the platform proxy overwrites X-Forwarded-For with the real client address; trust it there only, so the
// public wake endpoints rate-limit callers instead of the proxy. Local (ngrok) keeps the existing behaviour.
export const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] }, bodyLimit: 2 * 1024 * 1024, trustProxy: Boolean(process.env.VERCEL) });
await app.register(helmet);
await app.register(workerRoutes);
await app.register(wakeSignalRoutes);
type Agent = { id: string; user_id: string; status: string };
async function authenticate(req: any, reply: any): Promise<Agent | undefined> {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(header) : null;
  const token = match?.[1];
  if (!token) { reply.code(401).send({ error: 'unauthorized', message: 'A valid agent credential is required.' }); return; }
  const hash = createHash('sha256').update(token).digest('hex');
  const result = await pool.query<Agent>("UPDATE agent_connections SET last_seen_at = now() WHERE credential_hash = $1 AND status = 'active' RETURNING id, user_id, status", [hash]);
  if (!result.rows[0]) { reply.code(401).send({ error: 'unauthorized', message: 'A valid agent credential is required.' }); return; }
  return result.rows[0];
}
function errorResponse(error: string, message: string) { return { error, message }; }
app.get('/health', async (_req, reply) => {
  try { await pool.query('SELECT 1'); return { status: 'ok', database: 'connected' }; }
  catch { reply.code(503); return { status: 'degraded', database: 'unavailable' }; }
});
app.get('/api/agent/config', async (req, reply) => {
  const agent = await authenticate(req, reply); if (!agent) return;
  const { rows } = await pool.query(`SELECT sc.version, sc.enabled, sc.keywords, sc.location, sc.sources, sc.frequency_minutes
    FROM scan_configs sc JOIN agent_connections ac ON ac.id = sc.agent_connection_id JOIN users u ON u.id = ac.user_id
    WHERE sc.agent_connection_id = $1 AND u.lead_monitoring_status = 'active' ORDER BY sc.version DESC LIMIT 1`, [agent.id]);
  return rows[0] ?? (reply.code(404).send(errorResponse('config_not_found', 'No configuration is set for this agent.')));
});
app.get('/api/agent/posts', async (req, reply) => {
  const agent = await authenticate(req, reply); if (!agent) return;
  const query = req.query as { limit?: string; offset?: string };
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) {
    return reply.code(400).send(errorResponse('invalid_request', 'Use limit from 1 to 200 and a non-negative offset.'));
  }
  const [records, count] = await Promise.all([
    pool.query(`SELECT fp.id, fp.author, fp.title, fp.content, fp.published_at, fp.original_url, fp.normalized_url,
        fp.first_seen_at AS discovered_at, fp.source_type, fp.collected_via, fp.platform, ac.name AS agent_name,
        COALESCE(jsonb_agg(jsonb_build_object('version',sc.version,'enabled',sc.enabled,'keywords',sc.keywords,
          'location',sc.location,'sources',sc.sources,'frequency_minutes',sc.frequency_minutes)
          ORDER BY sc.version DESC) FILTER (WHERE sc.version IS NOT NULL), '[]'::jsonb) AS search_configurations
      FROM facebook_posts fp
      JOIN agent_connections ac ON ac.id = fp.agent_connection_id
      LEFT JOIN facebook_post_search_configs psc ON psc.agent_connection_id = fp.agent_connection_id AND psc.normalized_url = fp.normalized_url
      LEFT JOIN scan_configs sc ON sc.agent_connection_id = psc.agent_connection_id AND sc.version = psc.configuration_version
      WHERE fp.agent_connection_id = $1
      GROUP BY fp.id, ac.name
      ORDER BY fp.published_at DESC NULLS LAST, fp.id ASC
      LIMIT $2 OFFSET $3`, [agent.id, limit, offset]),
    pool.query('SELECT count(*)::int AS total FROM facebook_posts WHERE agent_connection_id = $1', [agent.id]),
  ]);
  return { records: records.rows.map(toLeadRecord), total: count.rows[0]?.total ?? 0, limit, offset };
});
app.get('/api/agent/status', async (req, reply) => {
  const agent = await authenticate(req, reply); if (!agent) return;
  const { rows: [data] } = await pool.query(`SELECT ac.status AS agent_status,
    (SELECT received_at FROM scan_runs WHERE agent_connection_id = ac.id AND status = 'success' ORDER BY received_at DESC LIMIT 1) AS last_successful_synchronization,
    (SELECT count(*)::int FROM facebook_posts WHERE agent_connection_id = ac.id) AS total_stored_posts,
    (SELECT jsonb_build_object('scan_id', external_scan_id, 'received_at', received_at, 'status', status) FROM scan_runs WHERE agent_connection_id = ac.id ORDER BY received_at DESC LIMIT 1) AS most_recent_scan,
    (SELECT version FROM scan_configs WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) AS configuration_version
    FROM agent_connections ac WHERE ac.id = $1`, [agent.id]);
  return data;
});
app.post('/api/agent/results', async (req, reply) => {
  const agent = await authenticate(req, reply); if (!agent) return;
  const parsed = resultSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Request body does not match the scan results schema.', details: parsed.error.issues.map(({ path, code, message }) => ({ path, code, message })) });
  const payload: ScanPayload = parsed.data;
  let posts: PreparedPost[];
  try { posts = preparePosts(payload.posts); }
  catch { return reply.code(400).send(errorResponse('invalid_request', 'Each post URL must use a supported Facebook host.')); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM agent_connections WHERE id = $1 FOR UPDATE', [agent.id]);
    const prior = await client.query('SELECT received_posts, new_posts, updated_posts, duplicates_skipped, received_at FROM scan_runs WHERE agent_connection_id = $1 AND external_scan_id = $2', [agent.id, payload.scan_id]);
    if (prior.rows[0]) {
      await associatePostsWithConfig(client, agent.id, payload.configuration_version, posts.map(post => post.normalized));
      await client.query('COMMIT');
      return { accepted: true, scan_id: payload.scan_id, received_posts: prior.rows[0].received_posts, inserted_posts: prior.rows[0].new_posts, updated_posts: prior.rows[0].updated_posts, duplicates: prior.rows[0].received_posts - prior.rows[0].new_posts, unchanged_posts: prior.rows[0].duplicates_skipped, server_received_at: prior.rows[0].received_at };
    }
    const { inserted, updated } = await upsertPosts(client, agent.id, payload.configuration_version, posts);
    const duplicateCount = payload.posts.length - inserted.size;
    const unchangedCount = Math.max(0, duplicateCount - updated.size);
    const status = payload.errors.length ? (payload.posts.length ? 'partial' : 'failed') : 'success';
    const { rows: [scanRun] } = await client.query(`INSERT INTO scan_runs (agent_connection_id, external_scan_id, configuration_version, scanned_at, total_found, received_posts, new_posts, updated_posts, duplicates_skipped, status, errors)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING received_at`, [agent.id, payload.scan_id, payload.configuration_version, payload.scanned_at, payload.stats.total_found, payload.posts.length, inserted.size, updated.size, unchangedCount, status, JSON.stringify(payload.errors)]);
    await client.query('COMMIT');
    return { accepted: true, scan_id: payload.scan_id, received_posts: payload.posts.length, inserted_posts: inserted.size, updated_posts: updated.size, duplicates: duplicateCount, unchanged_posts: unchangedCount, server_received_at: scanRun.received_at };
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error?.code === '23505') return reply.code(409).send(errorResponse('conflict', 'The scan could not be recorded; retry with the same scan_id.'));
    req.log.error({ err: { code: error?.code, message: error?.message } }, 'Result transaction failed');
    return reply.code(503).send(errorResponse('temporarily_unavailable', 'The scan was not acknowledged. Retry with the same scan_id.'));
  } finally { client.release(); }
});
app.setErrorHandler((error, _req, reply) => {
  if ((error as any).statusCode === 413) return reply.code(413).send(errorResponse('payload_too_large', 'Request body exceeds the 2 MiB limit.'));
  app.log.error({ err: { code: (error as any).code, message: error instanceof Error ? error.message : 'unknown' } }, 'Request failed');
  return reply.code(500).send(errorResponse('internal_error', 'The request could not be completed.'));
});

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const host = process.env.HOST ?? '127.0.0.1'; const port = Number(process.env.PORT ?? '8787');
  try { await app.listen({ host, port }); }
  catch (err) { app.log.error(err); process.exit(1); }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => { await app.close(); await pool.end(); process.exit(0); });
}

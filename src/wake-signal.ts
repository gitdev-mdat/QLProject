import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from './db.js';

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;
const requestsByIp = new Map<string, { startedAt: number; count: number }>();


type WakeSnapshot = {
  worker_id: string;
  worker_status_changed_at: Date | string;
  max_jobs_per_claim: number;
  active_leases: number;
  pending_fingerprint: string[];
  recurring_fingerprint: string[];
};

type WakeResult = { wake: false } | { wake: true; generation: string };
type Log = { error: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void };

/**
 * Process-local rate limit (per serverless instance on Vercel; add a platform firewall rule for a global limit).
 * Returns false when the caller exceeded the window.
 */
function allowRequest(ip: string): boolean {
  const now = Date.now();
  const prior = requestsByIp.get(ip);
  if (!prior || now - prior.startedAt >= WINDOW_MS) requestsByIp.set(ip, { startedAt: now, count: 1 });
  else if (++prior.count > MAX_REQUESTS_PER_WINDOW) return false;
  // Bound memory for callers that change source IPs. These endpoints deliberately have no query parameters or secrets.
  if (requestsByIp.size > 10_000) {
    for (const [key, value] of requestsByIp) if (now - value.startedAt >= WINDOW_MS) requestsByIp.delete(key);
  }
  return true;
}

const GENERATION = /^[0-9a-f]{64}$/;
const DISPATCH_TIMEOUT_MS = 3000;

/**
 * Reads another environment's PUBLIC wake signal (no credentials, no data). Any error, timeout, non-200 or malformed
 * body means "no work there" — an offline development machine never breaks or delays production beyond the timeout.
 */
async function readSecondaryWake(url: string, log: Log): Promise<WakeResult> {
  try {
    const response = await fetch(url, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      headers: { accept: 'application/json', 'ngrok-skip-browser-warning': 'true', 'user-agent': 'qlead-dispatcher' },
    });
    if (response.status !== 200) return { wake: false };
    const body = await response.json() as { wake?: unknown; generation?: unknown };
    if (body?.wake === true && typeof body.generation === 'string' && GENERATION.test(body.generation)) return { wake: true, generation: body.generation };
    return { wake: false };
  } catch (error) {
    log.warn({ err: { name: (error as any)?.name } }, 'Secondary wake signal unavailable');
    return { wake: false };
  }
}

/** The secondary (development) wake URL, only honoured by production and only over HTTPS. */
export function secondaryWakeUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.QLEAD_DISPATCH_SECONDARY_WAKE_URL?.trim();
  if (!raw || env.QLEAD_ENVIRONMENT !== 'production') return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || !url.pathname.endsWith('/api/public/worker-wake')) return undefined;
    return url.toString();
  } catch { return undefined; }
}

/** A public, read-only signal for the one active, credentialed worker. It never inserts or claims jobs. */
export async function wakeSignalRoutes(app: FastifyInstance): Promise<void> {
  const noStore = (reply: any) => reply.header('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate').header('Pragma', 'no-cache');

  app.get('/api/public/worker-wake', async (request, reply) => {
    noStore(reply);
    if (!allowRequest(request.ip)) return reply.code(429).send({ wake: false });
    return readWakeSignal(request.log);
  });

  /**
   * Environment-aware dispatcher for ONE Muse Hook serving two independent QLead environments. Production work always
   * wins; only when production has nothing eligible does it relay the development environment's public wake signal.
   * The response names the environment so the woken agent uses that environment's own connector and credential;
   * generations are namespaced so the Hook's persisted dedup state can never confuse the two queues.
   * No credentials, identifiers or data cross environments: the relay reads only a public boolean + opaque marker.
   */
  app.get('/api/public/worker-dispatch', async (request, reply) => {
    noStore(reply);
    if (!allowRequest(request.ip)) return reply.code(429).send({ wake: false });
    const environment = process.env.QLEAD_ENVIRONMENT === 'production' ? 'production' : 'local';
    const own = await readWakeSignal(request.log);
    if (own.wake) return { wake: true, environment, generation: `${environment}:${own.generation}` };
    const secondary = secondaryWakeUrl();
    if (!secondary) return { wake: false };
    const other = await readSecondaryWake(secondary, request.log);
    return other.wake ? { wake: true, environment: 'local', generation: `local:${other.generation}` } : { wake: false };
  });
}

async function readWakeSignal(log: Log): Promise<WakeResult> {
    try {
      const { rows: [snapshot] } = await pool.query<WakeSnapshot>(`WITH active_workers AS (
          SELECT id, authorized_sources, max_jobs_per_claim FROM muse_workers WHERE status = 'active' AND credential_status = 'active'
        ), sole_worker AS (
          SELECT w.id, w.authorized_sources, w.max_jobs_per_claim, w.status_changed_at, w.last_success_at
          FROM muse_workers w JOIN active_workers a ON a.id = w.id
          WHERE (SELECT count(*) FROM active_workers) = 1
        ), pending AS (
          SELECT j.id, j.attempts, j.updated_at,
            CASE WHEN now() < eligible.since + interval '5 minutes' THEN 0
              WHEN now() < eligible.since + interval '15 minutes' THEN 1 ELSE 2 END AS recovery_phase
          FROM search_jobs j CROSS JOIN sole_worker w
          JOIN agent_connections ac ON ac.id = j.search_profile_id
          JOIN users u ON u.id = ac.user_id AND u.lead_monitoring_status = 'active'
          CROSS JOIN LATERAL (SELECT CASE WHEN j.status = 'claimed' THEN greatest(j.lease_expires_at, w.status_changed_at)
            ELSE greatest(j.updated_at, j.available_at, j.scheduled_for, w.status_changed_at) END AS since) eligible
          WHERE ((j.status = 'pending' AND j.scheduled_for <= now() AND j.available_at <= now())
            OR (j.status = 'claimed' AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= now()) AND j.attempts < j.max_attempts))
            AND w.authorized_sources @> j.required_sources
        ), recurring AS (
          SELECT ac.id AS profile_id, sc.version, slot.start AS scheduled_for,
            CASE WHEN now() < greatest(slot.start, sc.updated_at, w.status_changed_at) + interval '5 minutes' THEN 0
              WHEN now() < greatest(slot.start, sc.updated_at, w.status_changed_at) + interval '15 minutes' THEN 1 ELSE 2 END AS recovery_phase
          FROM agent_connections ac
          JOIN users u ON u.id = ac.user_id AND u.lead_monitoring_status = 'active'
          JOIN LATERAL (SELECT version, enabled, sources, frequency_minutes, updated_at FROM scan_configs
            WHERE agent_connection_id = ac.id ORDER BY version DESC LIMIT 1) sc ON true
          CROSS JOIN LATERAL (SELECT to_timestamp(floor(extract(epoch FROM now()) / (sc.frequency_minutes * 60))
            * sc.frequency_minutes * 60) AS start) slot
          CROSS JOIN sole_worker w
          WHERE ac.kind = 'search_profile' AND ac.status = 'active' AND sc.enabled
            AND w.authorized_sources @> sc.sources
            AND NOT EXISTS (SELECT 1 FROM search_jobs j WHERE j.search_profile_id = ac.id AND j.status <> 'cancelled'
              AND (j.scheduled_for >= slot.start OR (j.kind IN ('initial', 'manual')
                AND j.scheduled_for > now() - make_interval(secs => sc.frequency_minutes * 30))))
            AND NOT EXISTS (SELECT 1 FROM search_jobs j WHERE j.search_profile_id = ac.id
              AND j.status IN ('pending', 'claimed', 'blocked', 'needs_reauthorization'))
        )
        SELECT w.id AS worker_id, w.status_changed_at AS worker_status_changed_at,
          w.max_jobs_per_claim,
          (SELECT count(*)::int FROM search_jobs j WHERE j.status = 'claimed' AND j.claimed_by_worker_id = w.id
            AND j.lease_expires_at > now()) AS active_leases,
          coalesce((SELECT array_agg(p.id::text || ':' || p.attempts::text || ':' || p.updated_at::text || ':' || p.recovery_phase::text ORDER BY p.id) FROM pending p), ARRAY[]::text[]) AS pending_fingerprint,
          coalesce((SELECT array_agg(r.profile_id::text || ':' || r.version::text || ':' || r.scheduled_for::text || ':' || r.recovery_phase::text ORDER BY r.profile_id) FROM recurring r), ARRAY[]::text[]) AS recurring_fingerprint
        FROM sole_worker w`);

      // Match claimJobs: only unexpired leases consume configured worker capacity.
      if (!snapshot || snapshot.active_leases >= snapshot.max_jobs_per_claim) return { wake: false };
      const eligible = [...snapshot.pending_fingerprint, ...snapshot.recurring_fingerprint];
      if (!eligible.length) return { wake: false };

      // The deterministic marker lets a Hook persistently deduplicate each state/recovery phase. It contains no raw identifiers.
      const generation = createHash('sha256').update(JSON.stringify([
        snapshot.worker_id, snapshot.worker_status_changed_at, snapshot.active_leases, snapshot.max_jobs_per_claim, eligible,
      ])).digest('hex');
      return { wake: true, generation };
    } catch (error) {
      log.error({ err: { code: (error as any)?.code, message: (error as any)?.message } }, 'Public worker wake signal query failed');
      return { wake: false };
    }
}

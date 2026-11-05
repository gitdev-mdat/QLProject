import 'server-only';
import type { NextRequest } from 'next/server';
import { after } from 'next/server';
import { workerRoutes } from '../../../src/worker-api';
import { wakeSignalRoutes } from '../../../src/wake-signal';
import { drainPushNotifications } from '../../../src/push-notifications';

/**
 * Runs the EXISTING Fastify route handlers for the Muse worker API and the public wake/dispatch signals inside Next.js
 * Route Handlers, so production needs no separate Fastify deployment. Nothing is reimplemented: src/worker-api.ts and
 * src/wake-signal.ts register their handlers on this minimal router exactly as they do on Fastify locally, and every
 * claim, lease, ingest and recovery rule stays in ../src (same code the backend tests cover).
 *
 * Only the request/reply surface those handlers use is provided: headers, body, params, query, ip, log; code/header/send.
 */
type Handler = (req: any, reply: any) => Promise<unknown>;
type Route = { method: 'GET' | 'POST'; pattern: RegExp; keys: string[]; handler: Handler };

const BODY_LIMIT = 2 * 1024 * 1024; // same as the Fastify app
const routes: Route[] = [];

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path.split('/').map(part => part.startsWith(':') ? (keys.push(part.slice(1)), '([^/]+)') : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
  return { pattern: new RegExp(`^${source}$`), keys };
}
const router = {
  get: (path: string, handler: Handler) => { routes.push({ method: 'GET', ...compile(path), handler }); },
  post: (path: string, handler: Handler) => { routes.push({ method: 'POST', ...compile(path), handler }); },
};
/**
 * Retry pass for the push outbox. The Vercel Hobby plan only allows a daily Cron, so due retries are also drained
 * after Muse's own frequent requests (dispatch/wake polls, claims, results): at most once a minute per instance, after
 * the response is sent, and never affecting the worker reply. The daily Cron stays as a backstop.
 */
let lastOpportunisticDrain = 0;
function scheduleOpportunisticDrain() {
  const now = Date.now();
  if (now - lastOpportunisticDrain < 60_000) return;
  lastOpportunisticDrain = now;
  try { after(() => drainPushNotifications({ limit: 5 }).catch(() => undefined)); } catch { /* outside a request scope */ }
}

const registered = Promise.all([
  workerRoutes(router as any, { onPushNotificationQueued: (outboxId) => { after(() => drainPushNotifications({ outboxId, limit: 25 })); } }),
  wakeSignalRoutes(router as any),
]);

function logger(path: string) {
  const write = (level: 'info' | 'warn' | 'error') => (obj: unknown, msg?: string) => {
    const line = JSON.stringify({ level, path, msg, ...(typeof obj === 'object' && obj ? obj : { detail: obj }) });
    if (level === 'error') console.error(line); else if (level === 'warn') console.warn(line); else console.log(line);
  };
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: () => undefined };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const err = (error: string, message: string) => ({ error, message });

/** Client address as Vercel reports it (the platform overwrites X-Forwarded-For); used only by the wake rate limit. */
function clientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
}

export async function handleWorkerRoute(request: NextRequest): Promise<Response> {
  await registered;
  scheduleOpportunisticDrain();
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  const candidates = routes.filter(r => r.pattern.test(path));
  const route = candidates.find(r => r.method === method);
  if (!route) return candidates.length ? json(405, err('method_not_allowed', 'Method not allowed.')) : json(404, err('not_found', 'Route not found.'));

  let body: unknown;
  if (method === 'POST') {
    const text = await request.text();
    if (Buffer.byteLength(text) > BODY_LIMIT) return json(413, err('payload_too_large', 'Request body exceeds the 2 MiB limit.'));
    if (text.trim()) {
      try { body = JSON.parse(text); } catch { return json(400, err('invalid_request', 'Request body must be valid JSON.')); }
    }
  }
  const match = route.pattern.exec(path)!;
  const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1]!)]));
  const headers = Object.fromEntries(request.headers.entries());
  const log = logger(path);
  const req = { headers, body, params, query: Object.fromEntries(new URL(request.url).searchParams), ip: clientIp(request), log };

  let status = 200;
  const outHeaders: Record<string, string> = {};
  let sent: { body: unknown } | undefined;
  const reply = {
    code(code: number) { status = code; return reply; },
    status(code: number) { status = code; return reply; },
    header(name: string, value: string) { outHeaders[name.toLowerCase()] = String(value); return reply; },
    send(payload: unknown) { sent = { body: payload }; return reply; },
  };
  try {
    const result = await route.handler(req, reply);
    const payload = sent ? sent.body : result;
    return json(status, payload === undefined ? null : payload, outHeaders);
  } catch (error) {
    log.error({ err: { code: (error as any)?.code, message: error instanceof Error ? error.message : 'unknown' } }, 'Request failed');
    return json(500, err('internal_error', 'The request could not be completed.'));
  }
}

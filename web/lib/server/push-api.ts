import 'server-only';
import { z } from 'zod';
import { getSession } from './session';
import { isSameOrigin } from './request-guard';
import {
  getPushPreference,
  getVapidPublicKey,
  isAllowedPushEndpoint,
  isPushConfigured,
  registerPushSubscription,
  removePushSubscription,
  sendTestPush,
  setPushPreference,
  subscriptionStatus,
} from '../../../src/push-notifications';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
const endpointSchema = z.string().min(1).max(2048).refine(isAllowedPushEndpoint);
// Some browsers pad base64url keys with "="; the stored form never has padding.
const keySchema = z.string().max(110).transform(value => value.replace(/=+$/, '')).pipe(z.string().regex(/^[A-Za-z0-9_-]{16,100}$/));
const endpointOnlySchema = z.object({ endpoint: endpointSchema }).strict();

const subscriptionSchema = z.object({
  endpoint: endpointSchema,
  // Safari omits expirationTime and older builds send 0 for "never"; both mean no expiry.
  expirationTime: z.number().finite().nonnegative().max(8_640_000_000_000_000).nullish().transform(value => value ? value : null),
  keys: z.object({ p256dh: keySchema, auth: keySchema }),
}).superRefine((subscription, ctx) => {
  if (Buffer.from(subscription.keys.p256dh, 'base64url').length !== 65 || Buffer.from(subscription.keys.auth, 'base64url').length !== 16) {
    ctx.addIssue({ code: 'custom', message: 'Invalid subscription keys.' });
  }
});

const registerSchema = z.object({
  subscription: subscriptionSchema,
  platform: z.enum(['ios', 'android', 'desktop', 'other']),
  standalone: z.boolean(),
  origin: z.string().min(1).max(500),
}).strict();

async function authenticated() {
  const session = await getSession();
  return session;
}

async function readBody<T>(request: Request, schema: z.ZodType<T, any>): Promise<{ data: T } | { error: Response; issues?: string }> {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 4096) return { error: json(400, { error: 'invalid_request' }) };
  if (!request.body) return { error: json(400, { error: 'invalid_request' }) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let bodyText: string;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > 4096) { await reader.cancel(); return { error: json(400, { error: 'invalid_request' }) }; }
      chunks.push(next.value);
    }
    bodyText = Buffer.concat(chunks).toString('utf8');
  } catch { return { error: json(400, { error: 'invalid_request' }) }; }
  let value: unknown;
  try { value = JSON.parse(bodyText); } catch { return { error: json(400, { error: 'invalid_request' }) }; }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { data: parsed.data };
  return { error: json(400, { error: 'invalid_request' }), issues: issueSummary(parsed.error) };
}

/** Field paths and issue codes only (e.g. "subscription.keys.auth:invalid_format"), never the submitted values. */
function issueSummary(error: z.ZodError): string {
  return error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || '(root)'}:${issue.code}`).join(',').slice(0, 300);
}

function normalizeOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function originAllowed(request: Request, expectedFromBody?: string): boolean {
  if (!isSameOrigin(request as any)) return false;
  const origin = normalizeOrigin(request.headers.get('origin'));
  if (!origin || (expectedFromBody !== undefined && normalizeOrigin(expectedFromBody) !== origin)) return false;
  const configured = (process.env.QLEAD_PUSH_ALLOWED_ORIGINS ?? 'https://qlead.vercel.app,https://qlead.vn')
    .split(',').map(item => item.trim()).filter(Boolean);
  const isProductionOrigin = configured.includes(origin) && origin.startsWith('https://');
  const isLocalTest = process.env.NODE_ENV !== 'production' && process.env.QLEAD_ENVIRONMENT === 'local'
    && process.env.VERCEL !== '1' && process.env.QLEAD_PUSH_ALLOW_LOCAL_ENDPOINTS === 'true'
    && ['http://localhost:3000', 'http://127.0.0.1:3000'].includes(origin);
  return isProductionOrigin || isLocalTest;
}

export async function getPushConfig(request: Request): Promise<Response> {
  if (!(await authenticated())) return json(401, { error: 'unauthorized' });
  const vapidPublicKey = getVapidPublicKey();
  return json(200, vapidPublicKey ? { enabled: true, vapidPublicKey } : { enabled: false });
}

/** One line per refused registration, so a failure on a real phone can be traced. No endpoint, key or user data. */
function logRefused(reason: string, request: Request, issues?: string) {
  console.warn(JSON.stringify({ level: 'warn', path: '/api/push/subscription', msg: 'Push subscription refused', reason, issues,
    origin: normalizeOrigin(request.headers.get('origin')) ?? (request.headers.get('origin') ? 'invalid' : 'missing') }));
}

export async function putPushSubscription(request: Request): Promise<Response> {
  const session = await authenticated();
  if (!session) return json(401, { error: 'unauthorized' });
  if (!originAllowed(request)) { logRefused('origin', request); return json(403, { error: 'forbidden' }); }
  if (!isPushConfigured()) return json(503, { error: 'push_not_configured' });
  const parsed = await readBody(request, registerSchema);
  if ('error' in parsed) { logRefused('invalid_body', request, parsed.issues); return parsed.error; }
  if (normalizeOrigin(parsed.data.origin) !== normalizeOrigin(request.headers.get('origin'))) { logRefused('origin_mismatch', request); return json(403, { error: 'forbidden' }); }
  const registered = await registerPushSubscription({
    userId: session.userId,
    sessionId: session.sessionId,
    subscription: parsed.data.subscription,
    platform: parsed.data.platform,
    standalone: parsed.data.standalone,
    origin: parsed.data.origin,
  });
  return registered ? json(200, { subscribed: true }) : json(401, { error: 'unauthorized' });
}

export async function postPushSubscriptionStatus(request: Request): Promise<Response> {
  const session = await authenticated();
  if (!session) return json(401, { error: 'unauthorized' });
  if (!originAllowed(request)) return json(403, { error: 'forbidden' });
  const parsed = await readBody(request, endpointOnlySchema);
  if ('error' in parsed) return parsed.error;
  const subscribed = await subscriptionStatus({ userId: session.userId, sessionId: session.sessionId, endpoint: parsed.data.endpoint });
  return json(200, { subscribed });
}

export async function deletePushSubscription(request: Request): Promise<Response> {
  const session = await authenticated();
  if (!session) return json(401, { error: 'unauthorized' });
  if (!originAllowed(request)) return json(403, { error: 'forbidden' });
  const parsed = await readBody(request, endpointOnlySchema);
  if ('error' in parsed) return parsed.error;
  await removePushSubscription({ userId: session.userId, sessionId: session.sessionId, endpoint: parsed.data.endpoint });
  return json(200, { subscribed: false });
}

export async function postPushTest(request: Request): Promise<Response> {
  const session = await authenticated();
  if (!session) return json(401, { error: 'unauthorized' });
  if (!originAllowed(request)) return json(403, { error: 'forbidden' });
  if (!isPushConfigured()) return json(503, { error: 'push_not_configured' });
  const parsed = await readBody(request, endpointOnlySchema);
  if ('error' in parsed) return parsed.error;
  const result = await sendTestPush({ userId: session.userId, sessionId: session.sessionId, endpoint: parsed.data.endpoint });
  if (result === 'not_subscribed') return json(404, { error: 'not_subscribed' });
  if (result === 'rate_limited') return json(429, { error: 'too_many_requests', retryAfterSeconds: 30 }, { 'Retry-After': '30' });
  if (result === 'failed') return json(502, { error: 'push_failed' });
  return json(202, { sent: true });
}

/** Optional account-wide control retained for Phase 2; F03's Phase 1 UI opts in/out per device. */
export async function getPushPreferences(request: Request): Promise<Response> {
  const session = await authenticated();
  if (!session) return json(401, { error: 'unauthorized' });
  return json(200, { newLeads: await getPushPreference(session.userId) });
}

export async function putPushPreferences(request: Request): Promise<Response> {
  const session = await authenticated();
  if (!session) return json(401, { error: 'unauthorized' });
  if (!originAllowed(request)) return json(403, { error: 'forbidden' });
  const parsed = await readBody(request, z.object({ newLeads: z.boolean() }).strict());
  if ('error' in parsed) return parsed.error;
  await setPushPreference(session.userId, parsed.data.newLeads);
  return json(200, { newLeads: parsed.data.newLeads });
}

const diagnosticSchema = z.object({
  stage: z.enum(['permission', 'service_worker', 'subscribe', 'save', 'unknown']),
  code: z.string().regex(/^[a-z_]{1,20}$/),
  detail: z.string().regex(/^[A-Za-z0-9]{1,40}$/).nullable(),
  platform: z.enum(['ios', 'android', 'desktop', 'other']),
  standalone: z.boolean(),
  permission: z.enum(['default', 'granted', 'denied', 'unsupported']),
}).strict();

/**
 * A browser reports which step of turning notifications on failed. Signed-in, same-origin only; the fields are fixed
 * enums or short identifiers, so nothing personal or secret can be logged. It only writes one log line.
 */
export async function postPushDiagnostic(request: Request): Promise<Response> {
  const session = await authenticated();
  if (!session) return json(401, { error: 'unauthorized' });
  if (!isSameOrigin(request as any)) return json(403, { error: 'forbidden' });
  const parsed = await readBody(request, diagnosticSchema);
  if ('error' in parsed) return parsed.error;
  console.warn(JSON.stringify({ level: 'warn', path: '/api/push/diagnostic', msg: 'Push enable failed on device', ...parsed.data,
    origin: normalizeOrigin(request.headers.get('origin')) }));
  return new Response(null, { status: 204, headers: NO_STORE });
}

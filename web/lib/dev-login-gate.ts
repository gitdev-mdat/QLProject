/**
 * Decides whether DEV quick login may run for one request. Pure, so it can be unit tested.
 * Every condition must hold; any doubt fails closed.
 */
export type DevLoginContext = {
  nodeEnv: string | undefined;
  flag: string | undefined;
  host: string | null;
  origin?: string | null;
  /** Lower-cased request header names and values. */
  headers: Record<string, string | undefined>;
  /** True when the check guards a state-changing request (requires a same-origin Origin and the custom header). */
  mutating?: boolean;
};

const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;
const LOOPBACK_IP = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
/** Headers that only a proxy or tunnel adds. Next's own dev server sets x-forwarded-for to the socket address; it is checked separately. */
const PROXY_HEADERS = ['forwarded', 'x-forwarded-server', 'x-real-ip', 'x-original-forwarded-for', 'cf-connecting-ip', 'ngrok-trace-id', 'x-ngrok-trace-id', 'true-client-ip', 'via'];

export const DEV_LOGIN_HEADER = 'x-qlead-dev-login';

export function evaluateDevLogin(context: DevLoginContext): { allowed: boolean; reason: string } {
  if (context.nodeEnv !== 'development') return { allowed: false, reason: 'not_development' };
  if (context.flag !== 'true') return { allowed: false, reason: 'flag_off' };
  if (!context.host || !LOOPBACK_HOST.test(context.host)) return { allowed: false, reason: 'non_loopback_host' };
  for (const name of PROXY_HEADERS) if (context.headers[name]) return { allowed: false, reason: 'proxied_request' };
  // Every hop listed in x-forwarded-for must be loopback; a tunnel or proxy would add a public address.
  const forwardedFor = context.headers['x-forwarded-for'];
  if (forwardedFor && !forwardedFor.split(',').map(value => value.trim()).every(value => LOOPBACK_IP.test(value))) return { allowed: false, reason: 'non_loopback_client' };
  const forwardedHost = context.headers['x-forwarded-host'];
  if (forwardedHost && !LOOPBACK_HOST.test(forwardedHost)) return { allowed: false, reason: 'non_loopback_host' };
  if (context.mutating) {
    let originHost: string | null = null;
    try { originHost = context.origin ? new URL(context.origin).host : null; } catch { originHost = null; }
    if (!originHost || originHost !== context.host) return { allowed: false, reason: 'cross_origin' };
    if (context.headers[DEV_LOGIN_HEADER] !== '1') return { allowed: false, reason: 'missing_csrf_header' };
  }
  return { allowed: true, reason: 'ok' };
}

export function headersToRecord(headers: Headers): Record<string, string | undefined> {
  const record: Record<string, string | undefined> = {};
  headers.forEach((value, key) => { record[key.toLowerCase()] = value; });
  return record;
}

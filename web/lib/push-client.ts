/**
 * Browser side of QLead Web Push. Talks only to the backend contract in docs/pwa-push/PUSH_API_CONTRACT.md
 * (/api/push/*); it never holds a private key and never decides on its own that notifications are on.
 */
import { detectPlatform, isStandalone, pushSupported, urlBase64ToUint8Array } from './pwa';

export const SW_URL = '/sw.js';

/**
 * The server ties a device subscription to the sign-in session that created it, so it ends with that session (logout,
 * a new sign-in, or the 7-day expiry). This marker remembers which account turned notifications on here, so the same
 * account signing in again keeps its notifications without another tap, while a different account never inherits them.
 */
const OWNER_KEY = 'qlead.push.owner';
const ownerFlag = {
  get(): string | null { try { return window.localStorage.getItem(OWNER_KEY); } catch { return null; } },
  set(owner: string): void { try { window.localStorage.setItem(OWNER_KEY, owner); } catch { /* ignore */ } },
  clear(): void { try { window.localStorage.removeItem(OWNER_KEY); } catch { /* ignore */ } },
};

/**
 * Reconciles this browser's subscription with the server for the signed-in account. Returns true when notifications
 * are on for this account on this device. Throws PushError when the server cannot answer (nothing is changed then).
 */
export async function syncSubscription(owner: string | null): Promise<boolean> {
  // Register first (idempotent): on a fresh page load the worker may not be registered yet, and an unregistered worker
  // must not be read as "no subscription".
  if (!pushSupported() || !await registerServiceWorker()) return false;
  const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (!subscription) { ownerFlag.clear(); return false; }
  if (await serverHasSubscription(subscription)) { if (owner) ownerFlag.set(owner); return true; }
  if (owner && ownerFlag.get() === owner) { await saveSubscription(subscription); return true; }
  // Left over from another account (or turned off elsewhere): release it so it stops receiving anyone's leads.
  await subscription.unsubscribe().catch(() => false);
  ownerFlag.clear();
  return false;
}

export type PushApiError = 'unauthorized' | 'not_configured' | 'rate_limited' | 'not_subscribed' | 'network' | 'server' | 'forbidden' | 'invalid' | 'device';

/** Where enabling failed. Shown to the person as a short code and reported to the server so a failure can be traced. */
export type PushStage = 'permission' | 'service_worker' | 'subscribe' | 'save' | 'test';

export class PushError extends Error {
  constructor(
    public readonly code: PushApiError,
    public readonly retryAfterSeconds?: number,
    public readonly stage?: PushStage,
    /** DOMException name or HTTP status: never a message, endpoint or key. */
    public readonly detail?: string,
  ) { super(code); }
}

const errorName = (error: unknown) => (error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error');

/** Runs one browser step of enabling; a browser error becomes a PushError that says which step failed and how. */
async function step<T>(stage: PushStage, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof PushError) throw error.stage ? error : new PushError(error.code, error.retryAfterSeconds, stage, error.detail);
    throw new PushError('device', undefined, stage, errorName(error));
  }
}

/**
 * Tells the server which step of enabling failed (stage, error name or HTTP status, platform), so a failure on a real
 * phone shows up in the server logs. Best effort and fire-and-forget; carries no endpoint, key or message text.
 */
export function reportPushFailure(error: unknown): void {
  const failure = error instanceof PushError ? error : new PushError('device', undefined, undefined, errorName(error));
  try {
    void fetch('/api/push/diagnostic', {
      method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: failure.stage ?? 'unknown', code: failure.code, detail: failure.detail ?? null, platform: detectPlatform(), standalone: isStandalone(), permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission }),
    }).catch(() => undefined);
  } catch { /* ignore */ }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  } catch {
    throw new PushError('network');
  }
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.ok) return data as T;
  if (response.status === 401) throw new PushError('unauthorized');
  if (response.status === 403) throw new PushError('forbidden', undefined, undefined, '403');
  if (response.status === 400) throw new PushError('invalid', undefined, undefined, '400');
  if (response.status === 404 && data.error === 'not_subscribed') throw new PushError('not_subscribed');
  if (response.status === 404 || response.status === 503) throw new PushError('not_configured');
  if (response.status === 429) throw new PushError('rate_limited', typeof data.retryAfterSeconds === 'number' ? data.retryAfterSeconds : undefined);
  throw new PushError('server', undefined, undefined, String(response.status));
}

export async function fetchPushConfig(): Promise<{ enabled: boolean; vapidPublicKey?: string }> {
  return call('/api/push/config');
}

/**
 * Registers the push-only worker. No fetch handler and no caches, so it never changes how pages load.
 * updateViaCache 'none' makes the browser always re-check sw.js itself instead of trusting the HTTP cache.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: '/', updateViaCache: 'none' });
  } catch {
    return null;
  }
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await registerServiceWorker();
  if (!registration) throw new PushError('device', undefined, 'service_worker', 'RegisterFailed');
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return registration ? registration.pushManager.getSubscription() : null;
}

function base64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Builds the subscription from its parts instead of toJSON(): browsers disagree on toJSON() (Safari leaves out
 * expirationTime, some encode keys with padding), and the server only accepts the exact shape.
 */
export function subscriptionPayload(subscription: PushSubscription) {
  const expirationTime = typeof subscription.expirationTime === 'number' && subscription.expirationTime > 0 ? subscription.expirationTime : null;
  return {
    endpoint: subscription.endpoint,
    expirationTime,
    keys: { p256dh: base64Url(subscription.getKey('p256dh')), auth: base64Url(subscription.getKey('auth')) },
  };
}

function describe(subscription: PushSubscription) {
  return { subscription: subscriptionPayload(subscription), platform: detectPlatform(), standalone: isStandalone(), origin: window.location.origin };
}

export async function saveSubscription(subscription: PushSubscription): Promise<void> {
  await call('/api/push/subscription', { method: 'PUT', body: JSON.stringify(describe(subscription)) });
}

/** True when the server holds this browser's subscription for the signed-in account. */
export async function serverHasSubscription(subscription: PushSubscription): Promise<boolean> {
  const data = await call<{ subscribed?: boolean }>('/api/push/subscription/status', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) });
  return data.subscribed === true;
}

/**
 * Must run inside the click handler that the person pressed: browsers only show the permission prompt for a user
 * gesture, and Safari refuses it after an await that loses the gesture, so requestPermission() is the first await.
 */
export async function enablePush(vapidPublicKey: string, owner: string | null): Promise<'granted' | 'denied' | 'default'> {
  // The key is fetched before the click (see the settings card), so nothing slow sits between the tap and the prompts.
  const permission = await step('permission', async () => Notification.permission === 'granted' ? 'granted' : Notification.requestPermission());
  if (permission !== 'granted') return permission;
  const registration = await step('service_worker', readyRegistration);
  const subscription = await step('subscribe', async () => {
    const key = urlBase64ToUint8Array(vapidPublicKey);
    let current = await registration.pushManager.getSubscription();
    // A subscription made with another server key (key rotation, domain move) cannot receive our pushes.
    if (current && !sameKey(current, key)) { await current.unsubscribe().catch(() => false); current = null; }
    return current ?? registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  });
  try {
    await step('save', () => saveSubscription(subscription));
  } catch (error) {
    // Do not leave a browser subscription the server never stored: it would look enabled but never receive anything.
    await subscription.unsubscribe().catch(() => false);
    throw error;
  }
  if (owner) ownerFlag.set(owner);
  return 'granted';
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((value, index) => value === key[index]);
}

/** Removes this device on the server first (so pushes stop even if the browser call fails), then in the browser. */
export async function disablePush(): Promise<void> {
  ownerFlag.clear();
  const subscription = await currentSubscription();
  if (!subscription) return;
  await call('/api/push/subscription', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) });
  await subscription.unsubscribe().catch(() => false);
}

export async function sendTestPush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) throw new PushError('not_subscribed');
  await step('test', () => call('/api/push/test', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) }));
}

/**
 * Before signing out: this device stops receiving the account's leads. Bounded so a slow network never holds logout;
 * the server also hands the endpoint to whoever subscribes from this browser next.
 */
export async function releaseSubscriptionOnLogout(timeoutMs = 1500): Promise<void> {
  ownerFlag.clear();
  const work = (async () => {
    const subscription = await currentSubscription();
    if (!subscription) return;
    await fetch('/api/push/subscription', { method: 'DELETE', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: subscription.endpoint }), keepalive: true }).catch(() => undefined);
    await subscription.unsubscribe().catch(() => false);
  })().catch(() => undefined);
  await Promise.race([work, new Promise(resolve => setTimeout(resolve, timeoutMs))]);
}

import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import webpush, { type PushSubscription as WebPushSubscription } from 'web-push';
import { pool } from './db.js';

export type PushSubscriptionInput = {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
};

export type PushPlatform = 'ios' | 'android' | 'desktop' | 'other';

export type PushPayload = {
  v: 1;
  kind: 'new_leads' | 'test';
  title: string;
  body: string;
  url: string;
  tag: 'new-leads' | 'push-test';
  count?: number;
};

type VapidConfig = { publicKey: string; privateKey: string; subject: string };
export type PushSender = (subscription: PushSubscriptionInput, payload: PushPayload, topic: 'new-leads' | 'push-test') => Promise<{ statusCode: number }>;
type DeliveryRow = {
  delivery_id: string;
  outbox_id: string;
  subscription_id: string | null;
  session_id: string | null;
  status: 'pending' | 'processing';
  attempts: number;
  lead_count: number;
  preference_revision: string;
  monitoring_changed_at: Date;
  lead_id: string | null;
  subscription_ciphertext: string | null;
  subscription_user_id: string | null;
  subscription_session_id: string | null;
  subscription_expiration_time: Date | null;
  subscription_origin: string | null;
  session_valid: boolean;
  user_active: boolean;
  preference_enabled: boolean;
  current_revision: string | null;
  monitoring_matches: boolean;
  origin_is_current: boolean;
};

const MAX_PAYLOAD_BYTES = 4096;
const LEAD_COOLDOWN_MS = 15 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;
const DELIVERY_LEASE_SECONDS = 90;

function base64urlBytes(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length ? decoded : null;
  } catch { return null; }
}

export function getVapidConfig(): VapidConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? process.env.QLEAD_WEB_PUSH_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY ?? process.env.QLEAD_WEB_PUSH_VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? process.env.QLEAD_WEB_PUSH_VAPID_SUBJECT ?? 'https://qlead.vercel.app/';
  if (!publicKey || !privateKey) return null;
  const publicBytes = base64urlBytes(publicKey);
  const privateBytes = base64urlBytes(privateKey);
  if (!publicBytes || publicBytes.length !== 65 || publicBytes[0] !== 4 || !privateBytes || privateBytes.length !== 32) return null;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateBytes);
    if (!timingSafeEqual(ecdh.getPublicKey(undefined, 'uncompressed'), publicBytes)) return null;
  } catch { return null; }
  if (!(subject.startsWith('mailto:') || (() => { try { return new URL(subject).protocol === 'https:'; } catch { return false; } })())) return null;
  return { publicKey, privateKey, subject };
}

function encryptionKey(): Buffer | null {
  const encoded = process.env.QLEAD_WEB_PUSH_ENCRYPTION_KEY;
  if (!encoded) return null;
  const key = Buffer.from(encoded, 'base64');
  return key.length === 32 ? key : null;
}

export function isPushConfigured(): boolean {
  return Boolean(getVapidConfig() && encryptionKey());
}

export function getVapidPublicKey(): string | null {
  return isPushConfigured() ? getVapidConfig()?.publicKey ?? null : null;
}

export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

export function isAllowedPushEndpoint(rawEndpoint: string): boolean {
  if (rawEndpoint.length > 2048) return false;
  let endpoint: URL;
  try { endpoint = new URL(rawEndpoint); } catch { return false; }
  if (endpoint.username || endpoint.password || endpoint.hash || !['https:', 'http:'].includes(endpoint.protocol)) return false;
  if (endpoint.protocol === 'https:' && (!['', '443'].includes(endpoint.port) || !allowedPushHost(endpoint.hostname))) return false;
  const localTest = process.env.NODE_ENV !== 'production' && process.env.QLEAD_ENVIRONMENT === 'local'
    && process.env.QLEAD_PUSH_ALLOW_LOCAL_ENDPOINTS === 'true' && process.env.VERCEL !== '1';
  if (endpoint.protocol === 'http:' && !(localTest && ['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname))) return false;
  return true;
}

function allowedPushHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'fcm.googleapis.com'
    || host === 'web.push.apple.com'
    || host.endsWith('.push.apple.com')
    || host === 'push.services.mozilla.com'
    || host.endsWith('.push.services.mozilla.com')
    || host === 'push.opera.com'
    || host.endsWith('.push.opera.com')
    // Microsoft Edge on Windows subscribes through WNS (e.g. wns2-par02p.notify.windows.com).
    || host.endsWith('.notify.windows.com');
}

export function encryptPushSubscription(subscription: PushSubscriptionInput): string {
  const key = encryptionKey();
  if (!key) throw new Error('Push encryption is not configured.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(subscription), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptPushSubscription(ciphertext: string): PushSubscriptionInput {
  const key = encryptionKey();
  if (!key) throw new Error('Push encryption is not configured.');
  const [version, ivText, tagText, dataText, extra] = ciphertext.split('.');
  if (version !== 'v1' || !ivText || !tagText || !dataText || extra !== undefined) throw new Error('Invalid encrypted subscription.');
  const iv = base64urlBytes(ivText);
  const tag = base64urlBytes(tagText);
  const data = base64urlBytes(dataText);
  if (!iv || iv.length !== 12 || !tag || tag.length !== 16 || !data) throw new Error('Invalid encrypted subscription.');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decoded = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  const value = JSON.parse(decoded) as PushSubscriptionInput;
  if (!value || typeof value.endpoint !== 'string' || typeof value.keys?.p256dh !== 'string' || typeof value.keys?.auth !== 'string') throw new Error('Invalid encrypted subscription.');
  return value;
}

export function newLeadsPayload(count: number, leadId?: string | null): PushPayload {
  const amount = Math.max(1, Math.trunc(count));
  const safeLeadUrl = amount === 1 && leadId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadId)
    ? `/app/bai-viet/${leadId}` : '/app/bai-viet';
  const payload: PushPayload = {
    v: 1,
    kind: 'new_leads',
    title: `QLead tìm thấy ${amount} cơ hội mới`,
    body: 'Có bài viết Facebook mới trong hồ sơ tìm kiếm của bạn. Nhấn để xem.',
    url: safeLeadUrl,
    tag: 'new-leads',
    count: amount,
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) throw new Error('Push payload exceeds the Web Push limit.');
  return payload;
}

export function testPushPayload(): PushPayload {
  return { v: 1, kind: 'test', title: 'QLead', body: 'Thông báo đã bật trên thiết bị này.', url: '/app', tag: 'push-test' };
}

function sendPush(subscription: PushSubscriptionInput, payload: PushPayload, topic: 'new-leads' | 'push-test') {
  const config = getVapidConfig();
  if (!config) throw new Error('Web Push is not configured.');
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return webpush.sendNotification(subscription as WebPushSubscription, JSON.stringify(payload), {
    TTL: 43_200,
    urgency: 'normal',
    topic,
    contentEncoding: 'aes128gcm',
    timeout: 8_000,
  });
}

export async function enqueueNewLeadNotification(client: PoolClient, input: { scanRunId: string; profileId: string; leadCount: number; leadId?: string | null }): Promise<string | null> {
  if (!Number.isInteger(input.leadCount) || input.leadCount <= 0) return null;
  const { rows: [event] } = await client.query<{ id: string }>(`
    WITH inserted_event AS (
      INSERT INTO push_notification_outbox (scan_run_id, user_id, search_profile_id, lead_count, lead_id, preference_revision, monitoring_changed_at)
      SELECT $1, ac.user_id, ac.id, $3, $4, pref.revision, u.lead_monitoring_changed_at
      FROM agent_connections ac
      JOIN users u ON u.id = ac.user_id AND u.lead_monitoring_status = 'active'
      JOIN push_notification_preferences pref ON pref.user_id = u.id AND pref.enabled = true
      WHERE ac.id = $2
        AND EXISTS (
          SELECT 1 FROM push_subscriptions ps
          JOIN web_sessions ws ON ws.id = ps.session_id AND ws.user_id = ps.user_id
          WHERE ps.user_id = u.id AND (ps.expiration_time IS NULL OR ps.expiration_time > now())
            AND ws.revoked_at IS NULL AND ws.expires_at > now()
            AND ps.origin = (
              SELECT candidate.origin FROM push_subscriptions candidate
              JOIN web_sessions cws ON cws.id = candidate.session_id AND cws.user_id = candidate.user_id
              WHERE candidate.user_id = ps.user_id
                AND (candidate.expiration_time IS NULL OR candidate.expiration_time > now())
                AND cws.revoked_at IS NULL AND cws.expires_at > now()
              ORDER BY CASE WHEN candidate.origin = 'https://qlead.vn' THEN 0 ELSE 1 END,
                candidate.created_at DESC, candidate.id DESC
              LIMIT 1
            )
        )
      ON CONFLICT (scan_run_id) DO NOTHING
      RETURNING id, user_id
    ), created_deliveries AS (
      INSERT INTO push_notification_deliveries (outbox_id, subscription_id, session_id)
      SELECT e.id, ps.id, ps.session_id
      FROM inserted_event e
      JOIN push_subscriptions ps ON ps.user_id = e.user_id
      JOIN web_sessions ws ON ws.id = ps.session_id AND ws.user_id = ps.user_id
      WHERE (ps.expiration_time IS NULL OR ps.expiration_time > now())
        AND ws.revoked_at IS NULL AND ws.expires_at > now()
        AND ps.origin = (
          SELECT candidate.origin FROM push_subscriptions candidate
          JOIN web_sessions cws ON cws.id = candidate.session_id AND cws.user_id = candidate.user_id
          WHERE candidate.user_id = ps.user_id
            AND (candidate.expiration_time IS NULL OR candidate.expiration_time > now())
            AND cws.revoked_at IS NULL AND cws.expires_at > now()
          ORDER BY CASE WHEN candidate.origin = 'https://qlead.vn' THEN 0 ELSE 1 END,
            candidate.created_at DESC, candidate.id DESC
          LIMIT 1
        )
      ON CONFLICT (outbox_id, subscription_id) DO NOTHING
      RETURNING outbox_id
    )
    SELECT e.id FROM inserted_event e WHERE EXISTS (SELECT 1 FROM created_deliveries) LIMIT 1
  `, [input.scanRunId, input.profileId, input.leadCount, input.leadCount === 1 ? input.leadId ?? null : null]);
  return event?.id ?? null;
}

type ClaimedUser = { user_id: string; last_new_lead_push_at: Date | null; lease_token: string };

/** Bounded durable outbox drain; external push calls happen after the claim transaction commits. */
export async function drainPushNotifications(options: { outboxId?: string; limit?: number; sender?: PushSender } = {}): Promise<{ sent: number; retried: number; suppressed: number; expired: number }> {
  if (!isPushConfigured()) return { sent: 0, retried: 0, suppressed: 0, expired: 0 };
  const limit = Math.max(1, Math.min(25, Math.trunc(options.limit ?? 25)));
  const client = await pool.connect();
  const batches: Array<{ userId: string; leaseToken: string; lastPushAt: Date | null; deliveries: DeliveryRow[] }> = [];
  try {
    await client.query('BEGIN');
    const { rows: users } = await client.query<{ user_id: string; last_new_lead_push_at: Date | null }>(`
      SELECT pref.user_id, pref.last_new_lead_push_at
      FROM push_notification_preferences pref
      WHERE pref.enabled = true AND (pref.dispatch_lease_until IS NULL OR pref.dispatch_lease_until <= now())
        AND EXISTS (
          SELECT 1 FROM push_notification_deliveries d
          JOIN push_notification_outbox o ON o.id = d.outbox_id
          WHERE o.user_id = pref.user_id
            AND (($1::uuid IS NULL) OR o.id = $1)
            AND ((d.status = 'pending' AND d.available_at <= now()) OR (d.status = 'processing' AND d.lease_expires_at <= now()))
        )
      ORDER BY pref.last_new_lead_push_at NULLS FIRST, pref.user_id
      FOR UPDATE OF pref SKIP LOCKED LIMIT $2
    `, [options.outboxId ?? null, limit]);

    for (const user of users) {
      const leaseToken = randomUUID();
      await client.query(`UPDATE push_notification_preferences SET dispatch_lease_token=$2, dispatch_lease_until=now()+($3::int * interval '1 second'), updated_at=now() WHERE user_id=$1`, [user.user_id, leaseToken, DELIVERY_LEASE_SECONDS]);
      const { rows: deliveryRows } = await client.query<DeliveryRow>(`
        SELECT d.id AS delivery_id, d.outbox_id, d.subscription_id, d.session_id, d.status, d.attempts,
          o.lead_count, o.lead_id, o.preference_revision, o.monitoring_changed_at,
          ps.subscription_ciphertext, ps.user_id AS subscription_user_id, ps.session_id AS subscription_session_id,
          ps.expiration_time AS subscription_expiration_time, ps.origin AS subscription_origin,
          (ws.id IS NOT NULL AND ws.revoked_at IS NULL AND ws.expires_at > now()) AS session_valid,
          (u.lead_monitoring_status = 'active') AS user_active,
          pref.enabled AS preference_enabled, pref.revision AS current_revision,
          (u.lead_monitoring_changed_at = o.monitoring_changed_at) AS monitoring_matches,
          (ps.origin = latest.origin) AS origin_is_current
        FROM push_notification_deliveries d
        JOIN push_notification_outbox o ON o.id = d.outbox_id
        JOIN users u ON u.id = o.user_id
        JOIN push_notification_preferences pref ON pref.user_id = o.user_id
        LEFT JOIN push_subscriptions ps ON ps.id = d.subscription_id
        LEFT JOIN web_sessions ws ON ws.id = d.session_id AND ws.user_id = o.user_id
        LEFT JOIN LATERAL (
          SELECT p2.origin FROM push_subscriptions p2
          JOIN web_sessions w2 ON w2.id=p2.session_id AND w2.user_id=p2.user_id
          WHERE p2.user_id=o.user_id AND (p2.expiration_time IS NULL OR p2.expiration_time > now())
            AND w2.revoked_at IS NULL AND w2.expires_at > now()
          ORDER BY CASE WHEN p2.origin = 'https://qlead.vn' THEN 0 ELSE 1 END,
            p2.created_at DESC, p2.id DESC LIMIT 1
        ) latest ON true
        WHERE o.user_id=$1
          AND ((d.status='pending' AND d.available_at <= now()) OR (d.status='processing' AND d.lease_expires_at <= now()))
        ORDER BY d.created_at, d.id
        FOR UPDATE OF d SKIP LOCKED
      `, [user.user_id]);

      const cooldownUntil = user.last_new_lead_push_at ? new Date(user.last_new_lead_push_at.getTime() + LEAD_COOLDOWN_MS) : null;
      const hasCooldown = Boolean(cooldownUntil && cooldownUntil > new Date());
      const stale: DeliveryRow[] = [];
      const dead: DeliveryRow[] = [];
      const expired: DeliveryRow[] = [];
      const freshDeferred: DeliveryRow[] = [];
      const eligible: DeliveryRow[] = [];
      for (const row of deliveryRows) {
        if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
          dead.push(row);
        } else if (row.subscription_id && row.subscription_expiration_time && row.subscription_expiration_time <= new Date()) {
          expired.push(row);
        } else if (!row.subscription_id || !row.session_id || !row.subscription_ciphertext || row.subscription_user_id !== user.user_id
          || row.subscription_session_id !== row.session_id || !row.session_valid
          || !row.user_active || !row.monitoring_matches || !row.preference_enabled || row.current_revision !== row.preference_revision || !row.origin_is_current) {
          stale.push(row);
        } else if (hasCooldown && row.attempts === 0) {
          freshDeferred.push(row);
        } else {
          eligible.push(row);
        }
      }
      if (stale.length) await client.query(`UPDATE push_notification_deliveries SET status='suppressed', lease_expires_at=NULL, updated_at=now() WHERE id=ANY($1::uuid[])`, [stale.map(row => row.delivery_id)]);
      if (dead.length) await client.query(`UPDATE push_notification_deliveries SET status='dead', lease_expires_at=NULL, last_error_code='attempt_limit', updated_at=now() WHERE id=ANY($1::uuid[])`, [dead.map(row => row.delivery_id)]);
      if (expired.length) {
        await client.query(`UPDATE push_notification_deliveries SET status='expired', lease_expires_at=NULL, last_error_code='subscription_expired', updated_at=now() WHERE id=ANY($1::uuid[])`, [expired.map(row => row.delivery_id)]);
        await client.query(`DELETE FROM push_subscriptions WHERE id=ANY($1::uuid[])`, [expired.map(row => row.subscription_id)]);
      }
      if (freshDeferred.length && cooldownUntil) {
        await client.query(`UPDATE push_notification_deliveries SET status='pending', available_at=$2, lease_expires_at=NULL, updated_at=now() WHERE id=ANY($1::uuid[])`, [freshDeferred.map(row => row.delivery_id), cooldownUntil]);
      }
      if (eligible.length) {
        await client.query(`UPDATE push_notification_deliveries SET status='processing', attempts=attempts+1, lease_expires_at=now()+($2::int * interval '1 second'), updated_at=now() WHERE id=ANY($1::uuid[])`, [eligible.map(row => row.delivery_id), DELIVERY_LEASE_SECONDS]);
        if (!hasCooldown) await client.query(`UPDATE push_notification_preferences SET last_new_lead_push_at=now(), updated_at=now() WHERE user_id=$1`, [user.user_id]);
        batches.push({ userId: user.user_id, leaseToken, lastPushAt: user.last_new_lead_push_at, deliveries: eligible });
      } else {
        await client.query(`UPDATE push_notification_preferences SET dispatch_lease_token=NULL, dispatch_lease_until=NULL WHERE user_id=$1 AND dispatch_lease_token=$2`, [user.user_id, leaseToken]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }

  const totals = { sent: 0, retried: 0, suppressed: 0, expired: 0 };
  for (const batch of batches) {
    const bySubscription = new Map<string, DeliveryRow[]>();
    for (const row of batch.deliveries) {
      if (!row.subscription_id) continue;
      const current = bySubscription.get(row.subscription_id) ?? [];
      current.push(row);
      bySubscription.set(row.subscription_id, current);
    }
    const deviceBatches = [...bySubscription.values()];
    let nextDevice = 0;
    const sendDeviceBatch = async (rows: DeliveryRow[]) => {
      const ids = rows.map(row => row.delivery_id);
      try {
        const subscription = decryptPushSubscription(rows[0]!.subscription_ciphertext!);
        const count = rows.reduce((sum, row) => sum + row.lead_count, 0);
        const leadId = rows.length === 1 && count === 1 ? rows[0]!.lead_id : null;
        const result = await (options.sender ?? sendPush)(subscription, newLeadsPayload(count, leadId), 'new-leads');
        await pool.query(`UPDATE push_notification_deliveries SET status='sent', push_status_code=$2, delivered_at=now(), lease_expires_at=NULL, updated_at=now() WHERE id=ANY($1::uuid[])`, [ids, result.statusCode]);
        await pool.query(`UPDATE push_subscriptions SET last_success_at=now(), last_failure_at=NULL, failure_count=0, updated_at=now() WHERE id=$1`, [rows[0]!.subscription_id]);
        totals.sent++;
      } catch (error) {
        const statusCode = Number((error as { statusCode?: number })?.statusCode) || null;
        if (statusCode === 404 || statusCode === 410) {
          await pool.query(`UPDATE push_notification_deliveries SET status='expired', push_status_code=$2, last_error_code='endpoint_gone', lease_expires_at=NULL, updated_at=now() WHERE id=ANY($1::uuid[])`, [ids, statusCode]);
          await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [rows[0]!.subscription_id]);
          totals.expired++;
        } else {
          const maxAttempts = Math.max(...rows.map(row => row.attempts + 1));
          const canRetry = maxAttempts < MAX_DELIVERY_ATTEMPTS && (!statusCode || statusCode === 408 || statusCode === 429 || statusCode >= 500);
          const delaySeconds = Math.min(120, 30 * (2 ** Math.max(0, maxAttempts - 1)));
          const code = statusCode ? `push_${statusCode}` : 'push_network_error';
          await pool.query(`UPDATE push_notification_deliveries SET status=$2, available_at=now()+($3::int * interval '1 second'), push_status_code=$4, last_error_code=$5, lease_expires_at=NULL, updated_at=now() WHERE id=ANY($1::uuid[])`, [ids, canRetry ? 'pending' : 'dead', delaySeconds, statusCode, code]);
          await pool.query(`UPDATE push_subscriptions SET last_failure_at=now(), failure_count=failure_count+1, updated_at=now() WHERE id=$1`, [rows[0]!.subscription_id]);
          if (canRetry) totals.retried++; else totals.suppressed++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, deviceBatches.length) }, async () => {
      while (nextDevice < deviceBatches.length) {
        const index = nextDevice++;
        await sendDeviceBatch(deviceBatches[index]!);
      }
    }));
    await pool.query(`UPDATE push_notification_preferences SET dispatch_lease_token=NULL, dispatch_lease_until=NULL, updated_at=now() WHERE user_id=$1 AND dispatch_lease_token=$2`, [batch.userId, batch.leaseToken]);
  }
  return totals;
}

export async function registerPushSubscription(input: {
  userId: string; sessionId: string; subscription: PushSubscriptionInput;
  platform: PushPlatform; standalone: boolean; origin: string;
}): Promise<boolean> {
  const ciphertext = encryptPushSubscription(input.subscription);
  const hash = endpointHash(input.subscription.endpoint);
  const expiration = input.subscription.expirationTime === null ? null : new Date(input.subscription.expirationTime);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: sessionRows } = await client.query(`SELECT id FROM web_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`, [input.sessionId, input.userId]);
    if (!sessionRows[0]) { await client.query('ROLLBACK'); return false; }
    await client.query(`INSERT INTO push_subscriptions (user_id, session_id, endpoint_hash, subscription_ciphertext, platform, standalone, origin, expiration_time)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (endpoint_hash) DO UPDATE SET user_id=EXCLUDED.user_id, session_id=EXCLUDED.session_id,
        subscription_ciphertext=EXCLUDED.subscription_ciphertext, platform=EXCLUDED.platform,
        standalone=EXCLUDED.standalone, origin=EXCLUDED.origin, expiration_time=EXCLUDED.expiration_time,
        updated_at=now()`, [input.userId, input.sessionId, hash, ciphertext, input.platform, input.standalone, input.origin, expiration]);
    await client.query(`INSERT INTO push_notification_preferences (user_id, enabled) VALUES ($1,true) ON CONFLICT (user_id) DO NOTHING`, [input.userId]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function subscriptionStatus(input: { userId: string; sessionId: string; endpoint: string }): Promise<boolean> {
  const { rowCount } = await pool.query(`SELECT 1 FROM push_subscriptions ps JOIN web_sessions ws ON ws.id=ps.session_id AND ws.user_id=ps.user_id
    WHERE ps.endpoint_hash=$1 AND ps.user_id=$2 AND ps.session_id=$3 AND ws.revoked_at IS NULL AND ws.expires_at>now()
      AND (ps.expiration_time IS NULL OR ps.expiration_time>now())`, [endpointHash(input.endpoint), input.userId, input.sessionId]);
  return Boolean(rowCount);
}

export async function removePushSubscription(input: { userId: string; sessionId: string; endpoint: string }): Promise<void> {
  await pool.query(`DELETE FROM push_subscriptions WHERE user_id=$1 AND session_id=$2 AND endpoint_hash=$3`, [input.userId, input.sessionId, endpointHash(input.endpoint)]);
}

export async function setPushPreference(userId: string, enabled: boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO push_notification_preferences (user_id, enabled) VALUES ($1,$2)
      ON CONFLICT (user_id) DO UPDATE SET enabled=EXCLUDED.enabled,
        revision=CASE WHEN push_notification_preferences.enabled IS DISTINCT FROM EXCLUDED.enabled THEN push_notification_preferences.revision+1 ELSE push_notification_preferences.revision END,
        updated_at=CASE WHEN push_notification_preferences.enabled IS DISTINCT FROM EXCLUDED.enabled THEN now() ELSE push_notification_preferences.updated_at END`, [userId, enabled]);
    if (!enabled) await client.query(`UPDATE push_notification_deliveries d SET status='suppressed', lease_expires_at=NULL, updated_at=now()
      FROM push_notification_outbox o WHERE o.id=d.outbox_id AND o.user_id=$1 AND d.status IN ('pending','processing')`, [userId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function getPushPreference(userId: string): Promise<boolean> {
  const { rows: [row] } = await pool.query<{ enabled: boolean }>('SELECT enabled FROM push_notification_preferences WHERE user_id=$1', [userId]);
  return row?.enabled ?? false;
}

export async function sendTestPush(input: { userId: string; sessionId: string; endpoint: string }, sender: PushSender = sendPush): Promise<'sent' | 'not_subscribed' | 'rate_limited' | 'failed'> {
  const hash = endpointHash(input.endpoint);
  const client = await pool.connect();
  let ciphertext: string | undefined;
  try {
    await client.query('BEGIN');
    const { rows: subscriptionRows } = await client.query<{ subscription_ciphertext: string }>(`SELECT ps.subscription_ciphertext FROM push_subscriptions ps
      JOIN web_sessions ws ON ws.id=ps.session_id AND ws.user_id=ps.user_id
      WHERE ps.user_id=$1 AND ps.session_id=$2 AND ps.endpoint_hash=$3 AND ws.revoked_at IS NULL AND ws.expires_at>now()
        AND (ps.expiration_time IS NULL OR ps.expiration_time>now()) FOR UPDATE OF ps`, [input.userId, input.sessionId, hash]);
    if (!subscriptionRows[0]) { await client.query('ROLLBACK'); return 'not_subscribed'; }
    ciphertext = subscriptionRows[0].subscription_ciphertext;
    const { rowCount } = await client.query(`INSERT INTO push_notification_preferences (user_id, enabled, test_last_sent_at) VALUES ($1,true,now())
      ON CONFLICT (user_id) DO UPDATE SET test_last_sent_at=now(), updated_at=now()
      WHERE push_notification_preferences.test_last_sent_at IS NULL OR push_notification_preferences.test_last_sent_at <= now()-interval '30 seconds'
      RETURNING user_id`, [input.userId]);
    if (!rowCount) { await client.query('ROLLBACK'); return 'rate_limited'; }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
  try {
    await sender(decryptPushSubscription(ciphertext!), testPushPayload(), 'push-test');
    await pool.query(`UPDATE push_subscriptions SET last_success_at=now(), last_failure_at=NULL, failure_count=0, updated_at=now() WHERE user_id=$1 AND session_id=$2 AND endpoint_hash=$3`, [input.userId, input.sessionId, hash]);
    return 'sent';
  } catch (error) {
    const statusCode = Number((error as { statusCode?: number })?.statusCode) || null;
    if (statusCode === 404 || statusCode === 410) {
      await pool.query(`DELETE FROM push_subscriptions WHERE user_id=$1 AND session_id=$2 AND endpoint_hash=$3`, [input.userId, input.sessionId, hash]);
      return 'not_subscribed';
    } else {
      await pool.query(`UPDATE push_subscriptions SET last_failure_at=now(), failure_count=failure_count+1, updated_at=now() WHERE user_id=$1 AND session_id=$2 AND endpoint_hash=$3`, [input.userId, input.sessionId, hash]);
    }
    return 'failed';
  }
}

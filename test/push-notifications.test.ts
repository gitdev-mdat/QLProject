import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import {
  decryptPushSubscription,
  encryptPushSubscription,
  endpointHash,
  isAllowedPushEndpoint,
  isPushConfigured,
  newLeadsPayload,
  testPushPayload,
  type PushSubscriptionInput,
} from '../src/push-notifications.js';

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { run(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const fixtureSubscription: PushSubscriptionInput = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-endpoint',
  expirationTime: null,
  keys: { p256dh: randomBytes(65).toString('base64url'), auth: randomBytes(16).toString('base64url') },
};

test('subscription encryption authenticates ciphertext and keeps secrets out of the stored hash', () => {
  const key = randomBytes(32);
  withEnv({ QLEAD_WEB_PUSH_ENCRYPTION_KEY: key.toString('base64') }, () => {
    const ciphertext = encryptPushSubscription(fixtureSubscription);
    assert.notEqual(ciphertext.includes(fixtureSubscription.endpoint), true);
    assert.notEqual(ciphertext.includes(fixtureSubscription.keys.p256dh), true);
    assert.deepEqual(decryptPushSubscription(ciphertext), fixtureSubscription);
    const parts = ciphertext.split('.');
    parts[3] = `${parts[3]!.slice(0, 1) === 'A' ? 'B' : 'A'}${parts[3]!.slice(1)}`;
    assert.throws(() => decryptPushSubscription(parts.join('.')));
    assert.match(endpointHash(fixtureSubscription.endpoint), /^[a-f0-9]{64}$/);
  });
});

test('push endpoint validation allows known HTTPS push services and rejects arbitrary hosts', () => {
  withEnv({ NODE_ENV: 'production', VERCEL: '1', QLEAD_ENVIRONMENT: 'production', QLEAD_PUSH_ALLOW_LOCAL_ENDPOINTS: undefined }, () => {
    assert.equal(isAllowedPushEndpoint(fixtureSubscription.endpoint), true);
    assert.equal(isAllowedPushEndpoint('https://web.push.apple.com/synthetic'), true);
    assert.equal(isAllowedPushEndpoint('https://attacker.example/push'), false);
    assert.equal(isAllowedPushEndpoint('http://127.0.0.1:8888/push'), false);
    assert.equal(isAllowedPushEndpoint('https://user:pass@fcm.googleapis.com/push'), false);
    assert.equal(isAllowedPushEndpoint(`https://fcm.googleapis.com/${'x'.repeat(2050)}`), false);
  });
});

test('notification payloads carry real count, safe authenticated destination and no lead content', () => {
  const id = '4b3c3d94-a073-4fd4-9aa4-16d27545ec0b';
  assert.deepEqual(newLeadsPayload(1, id), {
    v: 1, kind: 'new_leads', title: 'QLead tìm thấy 1 cơ hội mới',
    body: 'Có bài viết Facebook mới trong hồ sơ tìm kiếm của bạn. Nhấn để xem.',
    url: `/app/bai-viet/${id}`, tag: 'new-leads', count: 1,
  });
  assert.equal(newLeadsPayload(5, id).url, '/app/bai-viet');
  assert.equal(newLeadsPayload(5, id).count, 5);
  assert.deepEqual(testPushPayload(), { v: 1, kind: 'test', title: 'QLead', body: 'Thông báo đã bật trên thiết bị này.', url: '/app', tag: 'push-test' });
  assert.equal(JSON.stringify(newLeadsPayload(1, id)).includes('synthetic lead body'), false);
});

test('web-push builds RFC 8291 aes128gcm ciphertext and VAPID authorization', () => {
  const vapid = webpush.generateVAPIDKeys();
  const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  const subscription = {
    endpoint: fixtureSubscription.endpoint,
    keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.from(p256.x!, 'base64url'), Buffer.from(p256.y!, 'base64url')]).toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
  const request = webpush.generateRequestDetails(subscription, JSON.stringify(newLeadsPayload(5)), {
    TTL: 43_200, urgency: 'normal', topic: 'new-leads', contentEncoding: 'aes128gcm',
    vapidDetails: { subject: 'https://qlead.vercel.app/', ...vapid },
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(request.headers.TTL, 43_200);
  assert.equal(request.headers.Urgency, 'normal');
  assert.equal(request.headers.Topic, 'new-leads');
  assert.match(request.headers.Authorization!, /^vapid /);
  assert.ok(Buffer.isBuffer(request.body));
  assert.notEqual(request.body!.toString('utf8'), JSON.stringify(newLeadsPayload(5)));
});

test('server reports push configured only for a matching VAPID pair and 32-byte encryption key', () => {
  const vapid = webpush.generateVAPIDKeys();
  const other = webpush.generateVAPIDKeys();
  const env = {
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'https://qlead.vercel.app/',
    QLEAD_WEB_PUSH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };
  withEnv(env, () => assert.equal(isPushConfigured(), true));
  withEnv({ ...env, VAPID_PRIVATE_KEY: other.privateKey }, () => assert.equal(isPushConfigured(), false));
  withEnv({ ...env, QLEAD_WEB_PUSH_ENCRYPTION_KEY: randomBytes(31).toString('base64') }, () => assert.equal(isPushConfigured(), false));
});

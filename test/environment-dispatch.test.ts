import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDatabaseEnvironment, connectionOptions, qleadEnvironment } from '../src/environment.js';
import { secondaryWakeUrl } from '../src/wake-signal.js';
import { app } from '../src/server.js';

const LOCAL = 'postgres://muse:x@127.0.0.1:55432/muse_bridge';
const PROD = 'postgresql://postgres.abc:x@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';

test('environment guard: local only reaches loopback, production never reaches loopback', () => {
  assert.equal(assertDatabaseEnvironment(LOCAL, {}), 'local');
  assert.throws(() => assertDatabaseEnvironment(PROD, {}), /loopback/);
  assert.throws(() => assertDatabaseEnvironment(PROD, { QLEAD_ENVIRONMENT: 'local' }), /loopback/);
  assert.equal(assertDatabaseEnvironment(PROD, { QLEAD_ENVIRONMENT: 'production' }), 'production');
  assert.throws(() => assertDatabaseEnvironment(LOCAL, { QLEAD_ENVIRONMENT: 'production' }), /loopback/);
  assert.throws(() => assertDatabaseEnvironment(undefined, {}), /not configured/);
  assert.throws(() => qleadEnvironment({ QLEAD_ENVIRONMENT: 'staging' }), /must be/);
});

test('environment guard: on Vercel only the Production deployment may use the production database', () => {
  assert.throws(() => qleadEnvironment({ VERCEL: '1' }), /explicitly/);
  assert.equal(assertDatabaseEnvironment(PROD, { VERCEL: '1', VERCEL_ENV: 'production', QLEAD_ENVIRONMENT: 'production' }), 'production');
  assert.throws(() => assertDatabaseEnvironment(PROD, { VERCEL: '1', VERCEL_ENV: 'preview', QLEAD_ENVIRONMENT: 'production' }), /Production deployment/);
  assert.throws(() => assertDatabaseEnvironment(PROD, { VERCEL: '1', VERCEL_ENV: 'development', QLEAD_ENVIRONMENT: 'production' }), /Production deployment/);
});

test('TLS: a configured CA is enforced and overrides any sslmode in the URL; local stays plain', () => {
  assert.deepEqual(connectionOptions(LOCAL, {}), { connectionString: LOCAL });
  const pem = '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----';
  const opts = connectionOptions(`${PROD}?sslmode=require`, { DATABASE_CA_CERT: pem });
  assert.equal(opts.connectionString, PROD);
  assert.deepEqual(opts.ssl, { ca: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----', rejectUnauthorized: true });
  assert.throws(() => connectionOptions(PROD, { DATABASE_CA_CERT: 'not a cert' }), /PEM/);
});

test('dispatcher secondary URL: production only, https only, no credentials or query', () => {
  const ok = 'https://dev.example.ngrok-free.dev/api/public/worker-wake';
  assert.equal(secondaryWakeUrl({ QLEAD_ENVIRONMENT: 'production', QLEAD_DISPATCH_SECONDARY_WAKE_URL: ok }), ok);
  assert.equal(secondaryWakeUrl({ QLEAD_ENVIRONMENT: 'local', QLEAD_DISPATCH_SECONDARY_WAKE_URL: ok }), undefined);
  assert.equal(secondaryWakeUrl({ QLEAD_ENVIRONMENT: 'production', QLEAD_DISPATCH_SECONDARY_WAKE_URL: ok.replace('https', 'http') }), undefined);
  assert.equal(secondaryWakeUrl({ QLEAD_ENVIRONMENT: 'production', QLEAD_DISPATCH_SECONDARY_WAKE_URL: `${ok}?token=x` }), undefined);
  assert.equal(secondaryWakeUrl({ QLEAD_ENVIRONMENT: 'production', QLEAD_DISPATCH_SECONDARY_WAKE_URL: 'https://u:p@dev.example/api/public/worker-wake' }), undefined);
  assert.equal(secondaryWakeUrl({ QLEAD_ENVIRONMENT: 'production', QLEAD_DISPATCH_SECONDARY_WAKE_URL: 'https://dev.example/api/worker/jobs/claim' }), undefined);
});

test('dispatcher: production first, then namespaced development wake, offline development is silent', async () => {
  const saved = { env: process.env.QLEAD_ENVIRONMENT, url: process.env.QLEAD_DISPATCH_SECONDARY_WAKE_URL, fetch: globalThis.fetch };
  const LOCAL_GEN = 'a'.repeat(64);
  let calls = 0;
  let behaviour: 'wake' | 'offline' | 'malformed' | 'idle' = 'wake';
  globalThis.fetch = (async (input: any, init: any) => {
    calls++;
    assert.equal(String(input), 'https://dev.example.ngrok-free.dev/api/public/worker-wake');
    assert.equal(init?.headers?.authorization, undefined);
    if (behaviour === 'offline') throw new TypeError('fetch failed');
    const body = behaviour === 'wake' ? { wake: true, generation: LOCAL_GEN } : behaviour === 'malformed' ? { wake: true, generation: 'x' } : { wake: false };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  process.env.QLEAD_ENVIRONMENT = 'production';
  process.env.QLEAD_DISPATCH_SECONDARY_WAKE_URL = 'https://dev.example.ngrok-free.dev/api/public/worker-wake';
  try {
    const own = (await app.inject({ method: 'GET', url: '/api/public/worker-wake', remoteAddress: '10.9.0.1' })).json();
    const first = await app.inject({ method: 'GET', url: '/api/public/worker-dispatch', remoteAddress: '10.9.0.2' });
    assert.equal(first.statusCode, 200);
    assert.match(String(first.headers['cache-control']), /no-store/);
    if (own.wake) {
      // This database has eligible work: production wins and development is not even asked.
      assert.deepEqual(first.json(), { wake: true, environment: 'production', generation: `production:${own.generation}` });
      assert.equal(calls, 0);
    } else {
      assert.deepEqual(first.json(), { wake: true, environment: 'local', generation: `local:${LOCAL_GEN}` });
      for (const b of ['offline', 'malformed', 'idle'] as const) {
        behaviour = b;
        assert.deepEqual((await app.inject({ method: 'GET', url: '/api/public/worker-dispatch', remoteAddress: '10.9.0.2' })).json(), { wake: false }, b);
      }
      delete process.env.QLEAD_DISPATCH_SECONDARY_WAKE_URL;
      behaviour = 'wake';
      const before = calls;
      assert.deepEqual((await app.inject({ method: 'GET', url: '/api/public/worker-dispatch', remoteAddress: '10.9.0.2' })).json(), { wake: false });
      assert.equal(calls, before, 'no secondary configured: no outbound request');
    }
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.env === undefined) delete process.env.QLEAD_ENVIRONMENT; else process.env.QLEAD_ENVIRONMENT = saved.env;
    if (saved.url === undefined) delete process.env.QLEAD_DISPATCH_SECONDARY_WAKE_URL; else process.env.QLEAD_DISPATCH_SECONDARY_WAKE_URL = saved.url;
  }
});

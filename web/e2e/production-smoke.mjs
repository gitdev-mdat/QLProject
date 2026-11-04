// Read-only production smoke check. Creates no rows, claims no jobs, runs no searches.
//   node web/e2e/production-smoke.mjs https://qlead.vercel.app
import assert from 'node:assert/strict';

const base = (process.argv[2] ?? 'https://qlead.vercel.app').replace(/\/$/, '');
let passed = 0;
async function step(name, fn) { await fn(); passed++; console.log(`ok  ${name}`); }
const get = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });

await step('landing page is public', async () => { const r = await get('/'); assert.equal(r.status, 200); assert.match(await r.text(), /QLead/); });
await step('health: database connected', async () => { const r = await get('/health'); assert.equal(r.status, 200, await r.clone().text()); assert.deepEqual(await r.json(), { status: 'ok', database: 'connected' }); });
await step('worker API requires a credential', async () => {
  assert.equal((await get('/api/worker/status')).status, 401);
  assert.equal((await get('/api/worker/jobs/claim', { method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(43)}` } })).status, 401);
});
await step('wake + dispatch are quiet (no active production worker yet)', async () => {
  const w = await get('/api/public/worker-wake'); assert.equal(w.status, 200); assert.match(w.headers.get('cache-control') ?? '', /no-store/); assert.deepEqual(await w.json(), { wake: false });
  assert.deepEqual(await (await get('/api/public/worker-dispatch')).json(), { wake: false });
});
await step('app and admin require a session', async () => {
  for (const p of ['/app', '/admin/workers']) { const r = await get(p); assert.ok([307, 308, 302, 303].includes(r.status), `${p} ${r.status}`); assert.match(r.headers.get('location') ?? '', /dang-nhap/); }
});
await step('login: cross-origin refused, wrong password generic 401, no cookie', async () => {
  const body = JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password' });
  assert.equal((await get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body })).status, 403);
  const r = await get('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body });
  assert.equal(r.status, 401); assert.deepEqual(await r.json(), { error: 'invalid_credentials' }); assert.equal(r.headers.get('set-cookie'), null);
});
await step('dev quick login is off', async () => { const r = await get('/api/dev-login', { method: 'POST', headers: { origin: base } }); assert.ok(r.status >= 400, String(r.status)); });
console.log(`\n${passed}/${passed} passed`);

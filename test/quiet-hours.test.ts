import test from 'node:test';
import assert from 'node:assert/strict';
import { isSearchQuietHours, nextAllowedScanAt, quietHoursState } from '../src/quiet-hours.js';
import { claimJobs, enqueueDueJobs, enqueueInitialJob, requestManualJob, type Worker } from '../src/jobs.js';

test('quiet hours boundaries are 00:30 inclusive and 06:30 exclusive in Vietnam', () => {
  assert.equal(isSearchQuietHours(new Date('2026-11-10T17:29:00.000Z')), false); // 00:29
  assert.equal(isSearchQuietHours(new Date('2026-11-10T17:30:00.000Z')), true); // 00:30
  assert.equal(isSearchQuietHours(new Date('2026-11-10T23:29:00.000Z')), true); // 06:29
  assert.equal(isSearchQuietHours(new Date('2026-11-10T23:30:00.000Z')), false); // 06:30
});

test('quiet-hours state exposes the next Vietnam scan time and does not invent one outside the window', () => {
  const at = new Date('2026-11-10T17:30:00.000Z');
  assert.equal(nextAllowedScanAt(at)?.toISOString(), '2026-11-10T23:30:00.000Z');
  assert.deepEqual(quietHoursState(at), { active: true, timeZone: 'Asia/Ho_Chi_Minh', nextAllowedScanAt: '2026-11-10T23:30:00.000Z' });
  assert.equal(nextAllowedScanAt(new Date('2026-11-10T23:30:00.000Z')), null);
});

test('the atomic worker claim path does no work during quiet hours', async () => {
  let queries = 0;
  const client = { query: async () => { queries++; throw new Error('quiet-hours guard should run before any SQL'); } } as any;
  const worker: Worker = { id: 'worker', name: 'fixture', status: 'active', authorized_sources: ['social.search'], max_jobs_per_claim: 1, lease_minutes: 30 };
  assert.deepEqual(await claimJobs(client, worker, 1, undefined, new Date('2026-11-10T17:30:00.000Z')), []);
  assert.equal(queries, 0);
  assert.equal(await enqueueDueJobs(client, undefined, new Date('2026-11-10T23:29:00.000Z')), 0);
  assert.equal(queries, 0);
});

test('initial and manual requests created during quiet hours are held until 06:30', async () => {
  const at = new Date('2026-11-10T17:30:00.000Z');
  const expected = new Date('2026-11-10T23:30:00.000Z');
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes('SELECT sc.version, sc.enabled, u.lead_monitoring_status')) return { rows: [{ version: 1, enabled: true, monitoring_status: 'active' }] };
    if (sql.includes('SELECT id FROM search_jobs WHERE search_profile_id')) return { rows: [] };
    if (sql.includes('SELECT completed_at AS finished_at')) return { rows: [] };
    if (sql.includes('SELECT count(*)::int AS n FROM search_jobs')) return { rows: [{ n: 0 }] };
    if (sql.includes('RETURNING id')) return { rows: [{ id: 'synthetic-job' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } } as any;
  assert.equal(await enqueueInitialJob(client, 'profile', at), true);
  const initial = calls.find(call => call.sql.includes("'initial'"));
  assert.equal((initial?.values[1] as Date).toISOString(), expected.toISOString());
  const manual = await requestManualJob(client, 'profile', 'user', at);
  assert.deepEqual(manual, { outcome: 'queued', jobId: 'synthetic-job', nextAllowedScanAt: expected.toISOString() });
  const manualInsert = calls.find(call => call.sql.includes('requested_by_user_id') && call.sql.includes('INSERT INTO search_jobs'));
  assert.ok(manualInsert);
  assert.equal((manualInsert?.values[2] as Date).toISOString(), expected.toISOString());
});

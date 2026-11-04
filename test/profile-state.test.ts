import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveProfileState, PROFILE_STATE_HINT, PROFILE_STATE_LABEL } from '../web/lib/profile-state.js';

const now = Date.parse('2026-11-02T12:00:00.000Z');
const input = { enabled: true, everEnabled: true, frequencyMinutes: 30, enabledSince: '2026-11-02T10:00:00.000Z', lastScan: null, lastSuccessAt: '2026-11-02T11:30:00.000Z', blocked: false };

test('profile status differentiates next schedule, due-but-unclaimed and overdue recurring work', () => {
  assert.equal(deriveProfileState({ ...input, recurringDueAt: null }, now), 'active');
  assert.equal(deriveProfileState({ ...input, recurringDueAt: new Date(now - 5 * 60_000).toISOString() }, now), 'waiting_worker');
  assert.equal(deriveProfileState({ ...input, recurringDueAt: new Date(now - 21 * 60_000).toISOString() }, now), 'delayed');
  assert.equal(deriveProfileState({ ...input, lastSuccessAt: new Date(now - 61 * 60_000).toISOString(), recurringDueAt: new Date(now - 1 * 60_000).toISOString() }, now), 'delayed');
  assert.equal(PROFILE_STATE_LABEL.waiting_worker, 'Đến lịch · chờ xử lý');
  assert.match(PROFILE_STATE_HINT.waiting_worker, /đang chờ hệ thống nhận việc/);
  assert.match(PROFILE_STATE_HINT.delayed, /quá lịch dự kiến/);
});

test('paused and blocked profile states take precedence over schedule signals', () => {
  assert.equal(deriveProfileState({ ...input, enabled: false, recurringDueAt: new Date(now).toISOString() }, now), 'paused');
  assert.equal(deriveProfileState({ ...input, blocked: true, recurringDueAt: new Date(now).toISOString() }, now), 'attention');
});

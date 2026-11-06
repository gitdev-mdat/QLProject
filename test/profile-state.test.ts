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

test('an Admin account hold is never shown as a late or failing scan, and the delay clock restarts on reactivation', () => {
  const longAgo = { ...input, lastSuccessAt: '2026-10-30T08:00:00.000Z' };
  assert.equal(deriveProfileState(longAgo, now), 'delayed', 'without a hold an old last success is late');
  assert.equal(deriveProfileState({ ...longAgo, accountSuspended: true }, now), 'on_hold');
  assert.equal(deriveProfileState({ ...longAgo, accountSuspended: true, blocked: true }, now), 'on_hold');
  assert.equal(deriveProfileState({ ...longAgo, enabled: false, accountSuspended: true }, now), 'paused', "the customer's own pause still shows");
  assert.equal(deriveProfileState({ ...longAgo, monitoringSince: new Date(now - 5 * 60_000).toISOString() }, now), 'active', 'just reactivated: not late');
  assert.equal(deriveProfileState({ ...longAgo, monitoringSince: new Date(now - 5 * 60_000).toISOString(), recurringDueAt: new Date(now - 5 * 60_000).toISOString() }, now), 'waiting_worker');
  assert.doesNotMatch(PROFILE_STATE_LABEL.on_hold, /chậm|lỗi/);
});

test('a schedule slot that started during the suspension is not late right after reactivation', () => {
  const resumedAt = new Date(now - 2 * 60_000).toISOString();
  const slotStart = new Date(now - 28 * 60_000).toISOString();
  assert.equal(deriveProfileState({ ...input, lastSuccessAt: '2026-10-30T08:00:00.000Z', monitoringSince: resumedAt, recurringDueAt: slotStart }, now), 'waiting_worker');
  assert.equal(deriveProfileState({ ...input, lastSuccessAt: '2026-10-30T08:00:00.000Z', recurringDueAt: slotStart }, now), 'delayed');
});

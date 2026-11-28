import test from 'node:test';
import assert from 'node:assert/strict';
import { allowLoginAttempt, allowPasswordResetAttempt, allowPasswordResetRequest, allowRegistrationAttempt, createAttemptLimiter, requestAddress } from '../web/lib/auth-rate-limit.js';

test('registration is capped by email and by source address', () => {
  const now = 1_000_000;
  assert.equal(allowRegistrationAttempt('family@example.test', '192.0.2.10', now), true);
  assert.equal(allowRegistrationAttempt('FAMILY@example.test', '192.0.2.11', now + 1), true);
  assert.equal(allowRegistrationAttempt('family@example.test', '192.0.2.12', now + 2), true);
  assert.equal(allowRegistrationAttempt('family@example.test', '192.0.2.13', now + 3), false);
  for (let i = 0; i < 10; i++) assert.equal(allowRegistrationAttempt(`another${i}@example.test`, '198.51.100.7', now + i), true);
  assert.equal(allowRegistrationAttempt('last@example.test', '198.51.100.7', now + 20), false);
});

test('login cap expires after its fixed window', () => {
  const now = 2_000_000;
  for (let i = 0; i < 10; i++) assert.equal(allowLoginAttempt('test@example.test|192.0.2.3', now + i), true);
  assert.equal(allowLoginAttempt('test@example.test|192.0.2.3', now + 20), false);
  assert.equal(allowLoginAttempt('test@example.test|192.0.2.3', now + 15 * 60_000 + 1), true);
});

test('limiter starts a new fixed window after expiry', () => {
  const limiter = createAttemptLimiter();
  assert.equal(limiter.allow('subject', 1, 100, 0), true);
  assert.equal(limiter.allow('subject', 1, 100, 1), false);
  assert.equal(limiter.allow('subject', 1, 100, 100), true);
  assert.equal(limiter.allow('subject', 1, 100, 201), true);
});

test('Cloudflare address takes precedence over forwarded address', () => {
  const headers = new Headers({ 'cf-connecting-ip': '203.0.113.4', 'x-forwarded-for': '198.51.100.9, 10.0.0.1' });
  assert.equal(requestAddress(headers), '203.0.113.4');
  assert.equal(requestAddress(new Headers({ 'x-forwarded-for': '198.51.100.9, 10.0.0.1' })), '198.51.100.9');
  assert.equal(requestAddress(new Headers()), 'unknown');
});

test('forgot-password requests are capped per email and per address, independent of accounts', () => {
  const now = Date.parse('2026-11-22T00:00:00Z');
  for (let i = 0; i < 5; i++) assert.equal(allowPasswordResetRequest('Reset-Cap@Example.com', `10.9.0.${i}`, now), true);
  assert.equal(allowPasswordResetRequest(' reset-cap@example.com ', '10.9.0.99', now), false);
  assert.equal(allowPasswordResetRequest('reset-cap@example.com', '10.9.0.99', now + 61 * 60_000), true);
  for (let i = 0; i < 10; i++) assert.equal(allowPasswordResetRequest(`reset-ip-${i}@example.com`, '10.9.1.1', now), true);
  assert.equal(allowPasswordResetRequest('reset-ip-new@example.com', '10.9.1.1', now), false);
  for (let i = 0; i < 20; i++) assert.equal(allowPasswordResetAttempt('10.9.2.2', now), true);
  assert.equal(allowPasswordResetAttempt('10.9.2.2', now), false);
});

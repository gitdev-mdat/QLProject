import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDevLogin } from '../web/lib/dev-login-gate.ts';

const valid = {
  nodeEnv: 'development', flag: 'true', host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001',
  headers: { 'x-qlead-dev-login': '1', 'x-forwarded-for': '127.0.0.1' }, mutating: true,
};

test('allows a same-origin loopback request in development with the flag on', () => {
  assert.equal(evaluateDevLogin(valid).allowed, true);
});

test('production always fails closed, even with the opt-in flag set', () => {
  for (const nodeEnv of ['production', 'test', undefined]) assert.deepEqual(evaluateDevLogin({ ...valid, nodeEnv }), { allowed: false, reason: 'not_development' });
});

test('requires the explicit opt-in flag', () => {
  for (const flag of [undefined, '', 'false', '1', 'TRUE']) assert.equal(evaluateDevLogin({ ...valid, flag }).allowed, false);
});

test('rejects non-loopback hosts such as the ngrok tunnel', () => {
  for (const host of ['thrill-snowdrop-primer.ngrok-free.dev', '192.168.1.5:3001', 'localhost.evil.com', null]) {
    assert.equal(evaluateDevLogin({ ...valid, host, origin: host ? `http://${host}` : null }).allowed, false);
  }
});

test('rejects proxied or forwarded requests', () => {
  assert.equal(evaluateDevLogin({ ...valid, headers: { ...valid.headers, 'x-forwarded-for': '203.0.113.7' } }).allowed, false);
  assert.equal(evaluateDevLogin({ ...valid, headers: { ...valid.headers, 'x-forwarded-for': '127.0.0.1, 203.0.113.7' } }).allowed, false);
  assert.equal(evaluateDevLogin({ ...valid, headers: { ...valid.headers, 'ngrok-trace-id': 'abc' } }).allowed, false);
  assert.equal(evaluateDevLogin({ ...valid, headers: { ...valid.headers, forwarded: 'for=203.0.113.7' } }).allowed, false);
});

test('mutating requests need a same-origin Origin and the custom header (CSRF)', () => {
  assert.equal(evaluateDevLogin({ ...valid, origin: 'https://evil.example' }).allowed, false);
  assert.equal(evaluateDevLogin({ ...valid, origin: null }).allowed, false);
  assert.equal(evaluateDevLogin({ ...valid, headers: { 'x-forwarded-for': '127.0.0.1' } }).allowed, false);
});

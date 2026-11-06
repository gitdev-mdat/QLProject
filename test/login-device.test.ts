import test from 'node:test';
import assert from 'node:assert/strict';
import { loginDevice } from '../web/lib/login-device.js';
import { deviceText } from '../web/lib/login-history.js';

const UA = {
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneFacebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0]',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  coccoc: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) coc_coc_browser/130.0.0 Chrome/124.0.0.0 Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  zalo: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Zalo android/12100',
};

test('sign-in device facts are coarse families only, never versions or models', () => {
  assert.deepEqual(loginDevice(UA.winChrome), { device: 'desktop', os: 'Windows', browser: 'Chrome' });
  assert.deepEqual(loginDevice(UA.winEdge), { device: 'desktop', os: 'Windows', browser: 'Edge' });
  assert.deepEqual(loginDevice(UA.macSafari), { device: 'desktop', os: 'macOS', browser: 'Safari' });
  assert.deepEqual(loginDevice(UA.iphoneSafari), { device: 'mobile', os: 'iOS', browser: 'Safari' });
  assert.deepEqual(loginDevice(UA.iphoneFacebook), { device: 'mobile', os: 'iOS', browser: 'Facebook (trong ứng dụng)' });
  assert.deepEqual(loginDevice(UA.androidChrome), { device: 'mobile', os: 'Android', browser: 'Chrome' });
  assert.deepEqual(loginDevice(UA.androidTablet), { device: 'tablet', os: 'Android', browser: 'Chrome' });
  assert.deepEqual(loginDevice(UA.ipad), { device: 'tablet', os: 'iPadOS', browser: 'Safari' });
  assert.deepEqual(loginDevice(UA.coccoc), { device: 'desktop', os: 'Windows', browser: 'Cốc Cốc' });
  assert.deepEqual(loginDevice(UA.firefoxLinux), { device: 'desktop', os: 'Linux', browser: 'Firefox' });
  assert.deepEqual(loginDevice(UA.zalo), { device: 'mobile', os: 'Android', browser: 'Zalo (trong ứng dụng)' });
  for (const value of Object.values(UA)) {
    const facts = JSON.stringify(loginDevice(value));
    assert.doesNotMatch(facts, /\d/, `no version numbers or model ids stored: ${facts}`);
  }
});

test('unknown or missing User-Agent is recorded as unknown, not guessed', () => {
  assert.deepEqual(loginDevice(undefined), { device: null, os: null, browser: null });
  assert.deepEqual(loginDevice(''), { device: null, os: null, browser: null });
  assert.deepEqual(loginDevice('curl/8.5.0'), { device: null, os: null, browser: null });
  assert.deepEqual(loginDevice('x'.repeat(10_000)), { device: null, os: null, browser: null });
  assert.equal(deviceText({ device: null, os: null, browser: null }), null);
  assert.equal(deviceText({ device: 'desktop', os: 'Windows', browser: 'Chrome' }), 'Windows · Chrome');
  assert.equal(deviceText({ device: 'mobile', os: 'iOS', browser: 'Safari' }), 'Điện thoại · iOS · Safari');
  assert.equal(deviceText({ device: 'desktop', os: null, browser: null }), 'Máy tính');
});

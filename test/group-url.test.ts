import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFacebookGroupUrl } from '../src/group-url.js';

const ok = (input: string) => { const r = normalizeFacebookGroupUrl(input); assert.ok(r.ok, `${input} -> ${JSON.stringify(r)}`); return r; };
const reason = (input: string) => { const r = normalizeFacebookGroupUrl(input); assert.equal(r.ok, false, input); return (r as { reason: string }).reason; };

test('equivalent group URL variants share one key and canonical URL', () => {
  const variants = [
    'https://www.facebook.com/groups/ChuQuanCafeSaiGon',
    'http://facebook.com/groups/chuquancafesaigon/',
    'https://m.facebook.com/groups/chuquancafesaigon/posts/123?ref=share&mibextid=abc#x',
    'web.facebook.com/groups/ChuQuanCafeSaiGon/about',
    '  www.facebook.com/groups/chuquancafesaigon  ',
    'https://mbasic.facebook.com/groups/chuquancafesaigon/permalink/99/',
  ];
  for (const v of variants) {
    const r = ok(v);
    assert.equal(r.key, 'chuquancafesaigon');
    assert.equal(r.url, 'https://www.facebook.com/groups/chuquancafesaigon');
  }
  assert.equal(ok('https://www.facebook.com/groups/123456789012345/').key, '123456789012345');
});

test('rejects empty, malformed, non-Facebook and non-group URLs', () => {
  assert.equal(reason(''), 'empty');
  assert.equal(reason('   '), 'empty');
  assert.equal(reason('not a url'), 'malformed');
  assert.equal(reason('javascript:alert(1)'), 'malformed');
  assert.equal(reason('ftp://facebook.com/groups/abc'), 'malformed');
  assert.equal(reason('https://user:placeholder@facebook.com/groups/abc'), 'malformed');
  assert.equal(reason('https://facebook.com:8443/groups/abc'), 'malformed');
  assert.equal(reason('https://evil.example/groups/abc'), 'not_facebook');
  assert.equal(reason('https://facebook.com.evil.example/groups/abc'), 'not_facebook');
  assert.equal(reason('https://www.facebook.com/somepage'), 'not_group');
  assert.equal(reason('https://www.facebook.com/groups/'), 'not_group');
  assert.equal(reason('https://www.facebook.com/groups/feed/'), 'not_group');
  assert.equal(reason('https://www.facebook.com/groups/%3Cscript%3E'), 'not_group');
  assert.equal(reason(`https://www.facebook.com/groups/${'a'.repeat(3000)}`), 'too_long');
});

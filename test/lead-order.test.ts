import test from 'node:test';
import assert from 'node:assert/strict';
import { resultSchema } from '../src/validation.js';
import { compareLeadByPostedAt } from '../web/lib/lead-order.js';

test('lead list order uses original post time and keeps unknown times last in either direction', () => {
  const leads = [
    { id: 'late', published_at: '2026-11-03T11:00:00Z' },
    { id: 'missing', published_at: null },
    { id: 'early', published_at: '2026-11-03T08:00:00Z' },
    { id: 'invalid', published_at: 'not-a-date' },
    { id: 'tie-b', published_at: '2026-11-03T11:00:00Z' },
  ];

  assert.deepEqual([...leads].sort((a, b) => compareLeadByPostedAt(a, b)).map(lead => lead.id),
    ['late', 'tie-b', 'early', 'invalid', 'missing']);
  assert.deepEqual([...leads].sort((a, b) => compareLeadByPostedAt(a, b, 'oldest')).map(lead => lead.id),
    ['early', 'late', 'tie-b', 'invalid', 'missing']);
});

test('Muse posted_at is stored as the post timestamp when published_at is absent or null', () => {
  const common = {
    event: 'facebook_scan_completed' as const,
    source: 'synthetic-test',
    configuration_version: 1,
    scan_id: 'synthetic-date-alias',
    scanned_at: '2026-11-03T12:00:00Z',
    keywords_used: [],
    sources_used: ['social.search'],
    stats: { total_found: 3 },
    errors: [],
  };
  const result = resultSchema.parse({ ...common, posts: [
    { url: 'https://facebook.com/example/posts/1', posted_at: '2026-11-01T08:00:00+07:00' },
    { url: 'https://facebook.com/example/posts/2', published_at: null, posted_at: '2026-11-02T09:00:00+07:00' },
    { url: 'https://facebook.com/example/posts/3', published_at: '2026-11-03T10:00:00Z', posted_at: '2026-11-01T10:00:00Z' },
  ] });

  assert.equal(result.posts[0]?.published_at, '2026-11-01T08:00:00+07:00');
  assert.equal(result.posts[1]?.published_at, '2026-11-02T09:00:00+07:00');
  assert.equal(result.posts[2]?.published_at, '2026-11-01T10:00:00Z', 'original post timestamp wins over a differing published_at value');
});

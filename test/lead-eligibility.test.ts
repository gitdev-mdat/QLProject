import assert from 'node:assert/strict';
import test from 'node:test';
import { completeLeadMetadataSql, isSourceLinkedCandidate, isSupportedFacebookPostUrl, sourceLinkedPostSql } from '../src/lead-eligibility.js';
import { toLeadRecord } from '../src/lead-data.js';

test('recognizes supported Facebook post and video permalinks, not arbitrary Facebook pages', () => {
  for (const url of [
    'https://www.facebook.com/groups/123/posts/456/',
    'https://m.facebook.com/some-business/posts/456',
    'https://facebook.com/watch/?v=456',
    'https://facebook.com/permalink.php?story_fbid=456&id=123',
    'https://facebook.com/reel/456',
    'https://fb.watch/abc123/',
  ]) assert.equal(isSupportedFacebookPostUrl(url), true, url);

  for (const url of [
    'https://facebook.com/some-business',
    'https://facebook.com/groups/123',
    'https://example.com/groups/123/posts/456',
    'not a url',
    'javascript:alert(1)',
  ]) assert.equal(isSupportedFacebookPostUrl(url), false, url);
});

test('source-linked selection does not require text, title, author, phone, or published time', () => {
  assert.equal(isSourceLinkedCandidate({ url: 'https://facebook.com/groups/123/posts/456', collected_via: 'muse' }), true);
  assert.equal(isSourceLinkedCandidate({ url: 'https://facebook.com/groups/123/posts/456', collected_via: 'muse' }), true, 'missing phone is immaterial');
  assert.equal(isSourceLinkedCandidate({ url: 'https://facebook.com/groups/123/posts/456', collected_via: null }), true, 'missing publication time is immaterial');
  assert.equal(isSourceLinkedCandidate({ url: 'https://facebook.com/groups/123/posts/456', collected_via: 'integration_test' }), false);
  assert.equal(isSourceLinkedCandidate({ url: 'https://facebook.com/some-business', collected_via: 'muse' }), false);
});

test('lead DTO distinguishes complete and unavailable metadata without dropping a valid source', () => {
  const incomplete = toLeadRecord({ id: 'incomplete', original_url: 'https://facebook.com/groups/123/posts/456', author: 'Local business' });
  assert.equal(incomplete.original_url, 'https://facebook.com/groups/123/posts/456');
  assert.equal(incomplete.author, 'Local business');
  assert.equal(incomplete.sourceMetadata.status, 'incomplete');
  assert.equal(incomplete.sourceMetadata.content, null);
  assert.ok(incomplete.sourceMetadata.missingFields.includes('title'));
  assert.ok(incomplete.sourceMetadata.missingFields.includes('content'));
  assert.ok(incomplete.sourceMetadata.missingFields.includes('publishedAt'));

  const complete = toLeadRecord({ id: 'complete', original_url: 'https://facebook.com/groups/123/posts/789', author: 'Business', title: 'Opening', content: 'Looking for a supplier', published_at: '2026-11-01T10:00:00Z' });
  assert.equal(complete.sourceMetadata.status, 'complete');
  assert.deepEqual(complete.sourceMetadata.missingFields, []);
});

test('SQL eligibility ties the URL to an authorized search config and excludes synthetic fixtures', () => {
  const source = sourceLinkedPostSql('fp');
  assert.match(source, /original_url/);
  assert.match(source, /normalized_url/);
  assert.match(source, /facebook_post_search_configs/);
  assert.match(source, /scan_configs/);
  assert.match(source, /integration_test/);
  assert.doesNotMatch(source, /author IS NOT NULL/);
  assert.doesNotMatch(source, /content IS NOT NULL/);

  const metadata = completeLeadMetadataSql('fp');
  assert.match(metadata, /author IS NOT NULL/);
  assert.match(metadata, /title IS NOT NULL/);
  assert.match(metadata, /content IS NOT NULL/);
  assert.match(metadata, /published_at IS NOT NULL/);
});

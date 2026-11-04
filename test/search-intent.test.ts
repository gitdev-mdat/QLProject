import assert from 'node:assert/strict';
import test from 'node:test';
import { deduplicateSearchResults, defaultSearchIntent, evaluatePostAgainstIntent, interpretSearchRequest, planSearchQueries, searchIntentSchema, toLegacyScanConfig } from '../src/search-intent.js';

test('interprets the combined F&B opening-soon Southern Vietnam scenario', () => {
  const result = interpretSearchRequest('Tìm các quán F&B sắp khai trương ở khu vực miền Nam.');
  assert.deepEqual(result.intent.industries, ['food_and_beverage']);
  assert.deepEqual(result.intent.business_types, ['cafe', 'restaurant', 'milk_tea', 'bakery', 'food_shop']);
  assert.deepEqual(result.intent.intent_signals, ['opening_soon']);
  assert.deepEqual(result.intent.included_locations, ['southern_vietnam']);
  assert.equal(result.ambiguous, false);
  assert.deepEqual(planSearchQueries(result.intent).queries, [
    'quán cà phê sắp khai trương Miền Nam',
    'nhà hàng sắp khai trương Miền Nam',
    'quán trà sữa sắp khai trương Miền Nam',
    'tiệm bánh sắp khai trương Miền Nam',
    'quán ăn sắp khai trương Miền Nam',
  ]);
});

test('interprets the requested English test phrasing too', () => {
  const result = interpretSearchRequest('F&B businesses preparing to open in Southern Vietnam.');
  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.intent.industries, ['food_and_beverage']);
  assert.deepEqual(result.intent.intent_signals, ['opening_soon']);
  assert.deepEqual(result.intent.included_locations, ['southern_vietnam']);
  assert.equal(planSearchQueries(result.intent).queries[0], 'quán cà phê sắp khai trương Miền Nam');
});

test('interprets a simple Vietnamese request and normalizes a region edit', () => {
  const result = interpretSearchRequest('Tìm quán cà phê mới khai trương ở TP.HCM');
  assert.deepEqual(result.intent.business_types, ['cafe']);
  assert.deepEqual(result.intent.intent_signals, ['recently_opened']);
  const changed = searchIntentSchema.parse({ ...result.intent, included_locations: ['hanoi'] });
  assert.deepEqual(changed.included_locations, ['hanoi']);
  assert.equal(planSearchQueries(changed).queries[0], 'quán cà phê mới khai trương Hà Nội');
});

test('handles empty, ambiguous, and contradictory requests without inventing conditions', () => {
  const empty = interpretSearchRequest('');
  assert.equal(empty.ambiguous, true);
  assert.equal(empty.intent.business_types.length, 0);
  const ambiguous = interpretSearchRequest('Tìm giúp tôi khách hàng tiềm năng');
  assert.equal(ambiguous.ambiguous, true);
  const contradictory = interpretSearchRequest('Tìm quán ăn sắp khai trương nhưng mới khai trương ở miền Nam và Hà Nội');
  assert.equal(contradictory.warnings.length, 2);
  assert.deepEqual(contradictory.intent.intent_signals, ['opening_soon', 'recently_opened']);
  assert.deepEqual(contradictory.intent.included_locations, ['southern_vietnam', 'hanoi']);
});

test('validates, normalizes, and projects to the unchanged Muse scan config shape', () => {
  const raw = { ...defaultSearchIntent(), user_request: '  Tìm quán F&B sắp khai trương ở miền Nam  ', industries: ['food_and_beverage', 'food_and_beverage'], business_types: ['cafe', 'cafe'], intent_signals: ['opening_soon'], included_locations: ['southern_vietnam'], search_source: ['social.search'], frequency_minutes: 30, enabled: true };
  const intent = searchIntentSchema.parse(raw);
  assert.deepEqual(intent.industries, ['food_and_beverage']);
  assert.deepEqual(intent.business_types, ['cafe']);
  const config = toLegacyScanConfig(intent);
  assert.deepEqual(Object.keys(config).sort(), ['enabled', 'frequency_minutes', 'keywords', 'location', 'sources'].sort());
  assert.deepEqual(config.keywords, ['quán cà phê sắp khai trương Miền Nam', 'quán cà phê chuẩn bị khai trương Miền Nam']);
  assert.equal(config.location, 'Miền Nam');
  assert.deepEqual(config.sources, ['social.search']);
  assert.equal(config.frequency_minutes, 30);
  assert.throws(() => searchIntentSchema.parse({ ...raw, unexpected: 'field' }));
});

test('bounds query expansion and keeps posts with unknown location for review', () => {
  const intent = interpretSearchRequest('Tìm quán F&B sắp khai trương ở miền Nam').intent;
  assert.equal(planSearchQueries(intent, 3).queries.length, 3);
  const unknown = evaluatePostAgainstIntent(intent, 'Mình chuẩn bị khai trương quán cà phê nhỏ, cần tìm đội thiết kế.');
  assert.equal(unknown.decision, 'review');
  const inRegion = evaluatePostAgainstIntent(intent, 'Mình chuẩn bị khai trương quán cà phê nhỏ ở TP.HCM.');
  assert.equal(inRegion.decision, 'include');
  const outsideRegion = evaluatePostAgainstIntent(intent, 'Mình chuẩn bị khai trương quán cà phê ở Hà Nội.');
  assert.equal(outsideRegion.decision, 'exclude');
});

test('deduplicates by the stored normalized URL while retaining records without a URL', () => {
  const rows = deduplicateSearchResults([
    { normalized_url: 'https://facebook.com/post/1/', value: 'first' },
    { normalized_url: 'https://facebook.com/post/1', value: 'duplicate' },
    { url: 'https://facebook.com/post/2', value: 'second' },
    { value: 'missing URL' },
  ]);
  assert.deepEqual(rows.map(row => row.value), ['first', 'second', 'missing URL']);
});


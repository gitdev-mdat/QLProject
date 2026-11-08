import test from 'node:test';
import assert from 'node:assert/strict';
import { rankDistributionCandidates, scoreDistributionCandidate, type DistributionCandidate } from '../src/lead-distribution.js';

const now = Date.parse('2026-11-08T05:00:00.000Z');
function candidate(id: string, ageHours: number, content: string, keywords = ['quán cà phê sắp khai trương']): DistributionCandidate {
  return { id, normalized_url: `https://facebook.com/page/posts/${id}`, title: 'Thông tin kinh doanh', content, summary_vi: null,
    author: 'Trang kinh doanh', published_at: new Date(now - ageHours * 3_600_000), first_seen_at: new Date(now - 1_000), keywords };
}

test('a distribution cycle selects at most its configured limit from all queued candidates', () => {
  const candidates = Array.from({ length: 60 }, (_, i) => candidate(String(i).padStart(2, '0'), 24 + i * 12,
    `Quán cà phê sắp khai trương ở thành phố; bài ${i}`));
  const chosen = rankDistributionCandidates(candidates, 10, now);
  assert.equal(chosen.length, 10);
  assert.equal(new Set(chosen.map(item => item.id)).size, 10);
  assert.equal(rankDistributionCandidates(candidates, 4, now).length, 4);
  assert.deepEqual(rankDistributionCandidates(candidates, 0, now), []);
});

test('a newer unrelated post can rank below an older, intent-matched active opportunity', () => {
  const newWeak = candidate('new-weak', 2, 'Chào buổi sáng, cuối tuần vui vẻ.');
  const oldRelevant = candidate('old-relevant', 30, 'Quán cà phê sắp khai trương, đang cần tìm đơn vị cung cấp.');
  assert.ok(scoreDistributionCandidate(oldRelevant, now) > scoreDistributionCandidate(newWeak, now));
  assert.equal(rankDistributionCandidates([newWeak, oldRelevant], 1, now)[0]?.id, 'old-relevant');
});

test('unknown publication time receives no freshness points but remains rankable', () => {
  const missing = candidate('missing', 0, 'Quán cà phê sắp khai trương.');
  missing.published_at = null;
  const dated = candidate('dated', 0, 'Quán cà phê sắp khai trương.');
  assert.ok(scoreDistributionCandidate(dated, now) > scoreDistributionCandidate(missing, now));
  assert.equal(rankDistributionCandidates([missing], 10, now).length, 1);
});

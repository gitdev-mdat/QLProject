import test from 'node:test';
import assert from 'node:assert/strict';
import type { Lead } from '../web/lib/lead-source.js';
import { compareLeadRank, leadRankScore } from '../web/lib/lead-ranking.js';

const now = Date.parse('2026-11-02T12:00:00.000Z');
function lead(id: string, ageHours: number | null, content = 'Quán cà phê sắp khai trương ở TP.HCM, đang tuyển nhân viên.', extra: Partial<Lead> = {}): Lead {
  return {
    id, author: `Page ${id}`, title: null, content, need: null, contact: null,
    area: { location: content.includes('TP.HCM') ? 'TP.HCM' : null, evidence: null, ambiguous: false },
    published_at: ageHours === null ? null : new Date(now - ageHours * 3_600_000).toISOString(),
    discovered_at: new Date(now - 1_000).toISOString(), original_url: `https://www.facebook.com/${id}`,
    source_type: 'group', collected_via: 'qlead_shared_worker', platform: 'facebook', agent_name: null,
    search_configurations: [],
    sources: [{ kind: 'profile', profileId: 'profile-a', profileName: 'Cafe HCM', version: 1, keywords: ['quán cà phê sắp khai trương', 'đang tuyển nhân viên'], location: 'TP.HCM', discoveredAt: null }],
    ...extra,
  };
}

test('freshness tiers put 2h, 1d, 3d, 12d and 30d in useful order when relevance is comparable', () => {
  const ages = [2, 24, 72, 288, 720];
  const sorted = ages.map((age, i) => lead(String(i), age)).sort((a, b) => compareLeadRank(a, b, now));
  assert.deepEqual(sorted.map(item => item.id), ['0', '1', '2', '3', '4']);
});

test('publication freshness is strong, while a relevant upcoming opportunity can outrank a merely newer weak match', () => {
  const freshWeak = lead('fresh', 2, 'Chào buổi sáng mọi người, cuối tuần vui vẻ.');
  const olderStrong = lead('strong', 30, 'Quán cà phê sắp khai trương ở TP.HCM, đang tuyển nhân viên.', {
    contact: { number: '0900000000', normalized: '0900000000', evidence: 'liên hệ 0900000000' },
  });
  assert.ok(leadRankScore(freshWeak, now) > leadRankScore(lead('old', 288), now));
  assert.ok(leadRankScore(olderStrong, now) > leadRankScore(freshWeak, now));
  assert.equal(compareLeadRank(lead('newer', 2), lead('older', 3), now) < 0, true);
});

test('requested hiring and branch-expansion signals are recognized from the post text', () => {
  const opportunity = lead('opportunity', 48, 'Quán trà sữa ở TP.HCM sắp mở chi nhánh mới, đang tuyển người.');
  const generic = lead('generic', 48, 'Quán trà sữa ở TP.HCM đang hoạt động bình thường.');
  assert.ok(leadRankScore(opportunity, now) > leadRankScore(generic, now));
});

test('owner-provided GLACE evidence ranks as a recent F&B opening opportunity, while old unrelated hiring stays lower', () => {
  const glace = lead('glace-fixture', 21, 'GLACE – Quán chè Trung Hoa sắp khai trương và tuyển 2 nhân viên toàn thời gian tại 308 Phan Xích Long, TP.HCM.', {
    area: { location: 'TP.HCM', evidence: '308 Phan Xích Long, TP.HCM', ambiguous: false },
    sources: [{ kind: 'profile', profileId: 'profile-a', profileName: 'Broad F&B', version: 1, keywords: ['quán chè sắp khai trương', 'tuyển nhân viên quán chè sắp khai trương'], location: 'Miền Nam', discoveredAt: null }],
  });
  const unrelated = lead('old-recruitment', 24 * 30, 'Cửa hàng quần áo tuyển nhân viên bán hàng ca tối ở Hà Nội.', {
    area: { location: 'Hà Nội', evidence: 'ở Hà Nội', ambiguous: false },
  });
  assert.ok(leadRankScore(glace, now) > leadRankScore(unrelated, now));
  assert.equal(glace.published_at, new Date(now - 21 * 3_600_000).toISOString());
});

test('older than seven days needs explicit ongoing evidence to keep opportunity-signal points', () => {
  const stale = lead('stale', 24 * 12, 'Quán cà phê sắp khai trương ở TP.HCM.');
  const ongoing = lead('ongoing', 24 * 12, 'Quán cà phê sắp khai trương ở TP.HCM, hiện vẫn đang tuyển người.');
  assert.ok(leadRankScore(ongoing, now) > leadRankScore(stale, now));
});

test('missing, invalid, and future publication times never receive freshness points', () => {
  const missing = lead('missing', null);
  const future = lead('future', -3);
  const knownOld = lead('old', 720);
  assert.ok(leadRankScore(missing, now) < leadRankScore(knownOld, now));
  assert.equal(leadRankScore(future, now), leadRankScore(missing, now));
  const first = lead('a', 2, 'Quán cà phê sắp khai trương ở TP.HCM.');
  const second = lead('b', 2, 'Quán cà phê sắp khai trương ở TP.HCM.', { published_at: '2026-11-02T11:00:00+07:00' });
  assert.equal(leadRankScore(first, now), leadRankScore(second, now));
});

test('uncertain geography is neutral; a confident requested-region match scores above a mismatch', () => {
  const match = lead('match', 24, 'Quán cà phê sắp khai trương ở TP.HCM.');
  const uncertain = lead('uncertain', 24, 'Quán cà phê sắp khai trương.', { area: { location: null, evidence: null, ambiguous: true } });
  const mismatch = lead('mismatch', 24, 'Quán cà phê sắp khai trương ở Hà Nội.', { area: { location: 'Hà Nội', evidence: 'ở Hà Nội', ambiguous: false } });
  assert.ok(leadRankScore(match, now) > leadRankScore(uncertain, now));
  assert.ok(leadRankScore(uncertain, now) > leadRankScore(mismatch, now));
});

test('relevance terms from multiple profiles are all considered without changing tenant ownership', () => {
  const item = lead('multi', 24, 'Quán trà sữa sắp khai trương ở TP.HCM, tuyển nhân viên.', {
    sources: [
      { kind: 'profile', profileId: 'a', profileName: 'Cafe', version: 1, keywords: ['quán cà phê'], location: 'TP.HCM', discoveredAt: null },
      { kind: 'profile', profileId: 'b', profileName: 'Trà sữa', version: 1, keywords: ['quán trà sữa sắp khai trương'], location: 'TP.HCM', discoveredAt: null },
    ],
  });
  const single = { ...item, sources: [item.sources[0]!] };
  assert.ok(leadRankScore(item, now) >= leadRankScore(single, now));
});

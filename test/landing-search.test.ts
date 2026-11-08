import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCandidates, isVietnamese, LANDING_MAX_RESULTS, maskContacts, normalizeLandingQuery, rankLandingCandidates, type LandingCandidate,
} from '../web/lib/landing-search.js';

const NOW = Date.parse('2026-11-08T03:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
let n = 0;
function post(content: string, extra: Partial<LandingCandidate> = {}): LandingCandidate {
  n += 1;
  return { id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, normalized_url: `https://facebook.com/groups/g/posts/${n}`, title: null,
    content, summary_vi: null, published_at: hoursAgo(5), discovered_at: hoursAgo(4), ...extra };
}

const CAFE_HCM = 'Tôi bán phần mềm quản lý quán cafe, muốn tìm các quán cà phê sắp khai trương ở TP.HCM.';

test('returns at most two real matches, best and freshest first', () => {
  const pool = [
    post('Quán cà phê Mây sắp khai trương tại Quận 3, TP.HCM, đang tuyển pha chế.', { published_at: hoursAgo(2) }),
    post('Tiệm cà phê Lá chuẩn bị khai trương ở Sài Gòn, mời mọi người ghé ủng hộ ngày đầu.', { published_at: hoursAgo(20) }),
    post('Cà phê Gió sắp khai trương ở Gò Vấp, TP.HCM vào thứ bảy này, giảm giá đồ uống cả tuần.', { published_at: hoursAgo(60) }),
  ];
  const result = rankLandingCandidates(CAFE_HCM, pool, NOW);
  assert.equal(result.length, LANDING_MAX_RESULTS);
  assert.equal(result[0]!.candidate.id, pool[0]!.id);
  assert.deepEqual(result.map(match => match.preview.key), ['1', '2']);
  assert.match(result[0]!.preview.match, /Quán cà phê · sắp khai trương · TP\.HCM/);
});

test('never pads: one good match means one result, nonsense means none', () => {
  const pool = [
    post('Quán cà phê Mây sắp khai trương tại Quận 3, TP.HCM.'),
    post('Nhà hàng lẩu sắp khai trương ở Hà Nội, tuyển phục vụ.'),
    post('Bán xe máy cũ giá tốt, liên hệ mình nhé các bạn ơi.'),
  ];
  assert.equal(rankLandingCandidates(CAFE_HCM, pool, NOW).length, 1);
  assert.equal(rankLandingCandidates('asdf qwer zxcv', pool, NOW).length, 0);
});

test('a named place must match: a Hà Nội post never answers a TP.HCM request', () => {
  const pool = [post('Quán cà phê Phố sắp khai trương ở Hà Nội, tuyển nhân viên.'), post('Quán cà phê nhỏ sắp khai trương, chưa nói ở đâu.')];
  assert.equal(rankLandingCandidates(CAFE_HCM, pool, NOW).length, 0);
  const anywhere = rankLandingCandidates('Tìm quán cà phê sắp khai trương', pool, NOW);
  assert.equal(anywhere.length, 2, 'without a place both qualify');
});

test('region requests accept provinces of that region', () => {
  const pool = [post('Nhà hàng Cồn Chill sắp khai trương ở Cần Thơ, tuyển phục vụ.'), post('Nhà hàng Phở sắp khai trương ở Hà Nội.')];
  const result = rankLandingCandidates('Tôi muốn tìm nhà hàng sắp khai trương ở miền Nam', pool, NOW);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.preview.area, 'Cần Thơ');
});

test('old, future-dated and English-only posts are not shown', () => {
  const pool = [
    post('Quán cà phê Cũ sắp khai trương ở TP.HCM.', { published_at: hoursAgo(24 * 40) }),
    post('Grand opening of a coffee shop in TP.HCM on November 5, with live music and promotions.'),
    post('Quán cà phê Tương Lai sắp khai trương ở TP.HCM.', { published_at: new Date(NOW + 3 * 86_400_000).toISOString() }),
  ];
  assert.equal(rankLandingCandidates(CAFE_HCM, pool, NOW).length, 0);
  assert.equal(isVietnamese('Grand opening on November 5, 2026, at 63 Lò Lu, Long Phước, TP.HCM.'), false);
  assert.equal(isVietnamese('Quán cà phê sắp khai trương ở TP.HCM.'), true);
});

test('a Vietnamese summary makes an English post showable and is labelled as a summary', () => {
  const pool = [post('Carousel promoting the opening of a coffee shop in Saigon.', { summary_vi: 'Quán cà phê Hiên sắp khai trương ở TP.HCM, có ưu đãi tuần đầu.' })];
  const [match] = rankLandingCandidates(CAFE_HCM, pool, NOW);
  assert.ok(match);
  assert.equal(match.preview.summarized, true);
  assert.match(match.preview.excerpt, /^Quán cà phê Hiên/);
});

test('near-duplicate posts about the same opening are collapsed', () => {
  const text = 'Quán cà phê La Cà sắp khai trương tại 79 Phồn Xương, TP.HCM, ưu đãi đồng giá 15K ba ngày đầu.';
  const pool = [post(text), post(`${text} Hẹn gặp mọi người!`), post('Cà phê Sóc sắp khai trương ở Thủ Đức, TP.HCM.')];
  const result = rankLandingCandidates(CAFE_HCM, pool, NOW);
  assert.equal(result.length, 2);
  assert.ok(result.some(match => /Sóc/.test(match.preview.excerpt)));
});

test('the public preview carries no phone, email, link, author or post URL', () => {
  const pool = [post('Quán cà phê Mây sắp khai trương ở TP.HCM. Liên hệ 0901 234 567 hoặc zalo 0912345678, email chu.quan@gmail.com, web www.caphemay.vn')];
  const [match] = rankLandingCandidates(CAFE_HCM, pool, NOW);
  assert.ok(match);
  const json = JSON.stringify(match.preview);
  assert.doesNotMatch(json, /0901|0912|gmail|caphemay|facebook\.com/);
  assert.equal(match.preview.hasContact, true);
  assert.deepEqual(Object.keys(match.preview).sort(), ['area', 'excerpt', 'hasContact', 'key', 'match', 'publishedAt', 'signals', 'source', 'summarized']);
  assert.equal(maskContacts('Gọi 0901.234.567 nhé'), 'Gọi SĐT ẩn nhé');
});

test('the seller part of the request does not hide the customer type, and pre-analysed pools rank the same', () => {
  const pool = [post('Quán cà phê Mây sắp khai trương tại TP.HCM.'), post('Nhà hàng Mây sắp khai trương tại TP.HCM.')];
  const raw = rankLandingCandidates('Tôi bán phần mềm quản lý quán cafe, muốn tìm các quán sắp khai trương ở TP.HCM', pool, NOW);
  const analyzed = rankLandingCandidates('Tôi bán phần mềm quản lý quán cafe, muốn tìm các quán sắp khai trương ở TP.HCM', analyzeCandidates(pool), NOW);
  assert.deepEqual(raw.map(match => match.candidate.id), [pool[0]!.id]);
  assert.deepEqual(analyzed.map(match => match.candidate.id), raw.map(match => match.candidate.id));
  assert.equal(normalizeLandingQuery('  Quán   CAFE  '), 'quán cafe');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { extractContactFromPost, extractLocationFromPost, extractNeedFromPost, toLeadRecord } from '../src/lead-data.js';

test('extracts only a phone number explicitly introduced as contact information', () => {
  const contact = extractContactFromPost('Mình cần tìm thợ sửa máy lạnh. Liên hệ: 0901 234 567 để trao đổi nhé.');
  assert.equal(contact?.number, '0901 234 567');
  assert.equal(contact?.normalized, '0901234567');
  assert.match(contact?.evidence ?? '', /Liên hệ/);
  assert.equal(extractContactFromPost('Mẫu máy 2025, giá 0901234567 đồng, cần tìm nơi sửa.'), null);
});

test('normalizes a city-and-district mention and marks distinct areas ambiguous', () => {
  assert.deepEqual(extractLocationFromPost('Mình đang cần tìm chỗ decor ở Thủ Đức, TP.HCM.'), {
    location: 'Thủ Đức, TP.HCM',
    evidence: 'Mình đang cần tìm chỗ decor ở Thủ Đức, TP.HCM.',
    ambiguous: false,
  });
  assert.equal(extractLocationFromPost('Mình cần tìm nguồn sỉ tại Hà Nội hoặc TP.HCM.').ambiguous, true);
  assert.equal(extractLocationFromPost('Mình cần tìm nguồn sỉ tại Hà Nội.').location, 'Hà Nội');
  assert.equal(extractLocationFromPost('Mình cần tìm nguồn hàng tốt.').location, null);
});

test('uses exact need-bearing post text and preserves long Vietnamese content', () => {
  const content = 'Xin chào cả nhà. Mình đang cần tìm đơn vị thiết kế nội thất cho quán mới ở Đà Nẵng. Ưu tiên có kinh nghiệm F&B.';
  assert.equal(extractNeedFromPost(content), 'Mình đang cần tìm đơn vị thiết kế nội thất cho quán mới ở Đà Nẵng.');
  assert.equal(extractNeedFromPost('Có ai biết bên nào thi công kệ gỗ treo tường đẹp ở Hà Nội không ạ? Mình muốn đặt cho cửa hàng.'), 'Có ai biết bên nào thi công kệ gỗ treo tường đẹp ở Hà Nội không ạ?');
  assert.equal(extractNeedFromPost('Một ngày nắng đẹp, quán mở cửa lúc 8 giờ.'), null);
  const long = `Mình đang tìm nhà cung cấp. ${'Nội dung tiếng Việt rất dài để kiểm tra khả năng bảo toàn dấu. '.repeat(40)}`;
  const record = toLeadRecord({ id: 'legacy', content: long, discovered_at: '2026-10-31T09:00:00+07:00' });
  assert.equal(record.content, long);
  assert.equal(record.published_at, null);
  assert.equal(record.discovered_at, '2026-10-31T02:00:00.000Z');
});

test('keeps URL-only legacy rows and never substitutes discovery time for post time', () => {
  const lead = toLeadRecord({ id: 'url-only', original_url: 'https://www.facebook.com/groups/123/posts/456/', first_seen_at: '2026-10-30T10:00:00Z' });
  assert.equal(lead.original_url, 'https://www.facebook.com/groups/123/posts/456/');
  assert.equal(lead.author, null);
  assert.equal(lead.content, '');
  assert.equal(lead.contact, null);
  assert.equal(lead.area.location, null);
  assert.equal(lead.published_at, null);
  assert.equal(lead.discovered_at, '2026-10-30T10:00:00.000Z');
  assert.equal(toLeadRecord({ id: 'bad-url', original_url: 'https://example.com/not-a-post' }).original_url, null);
});

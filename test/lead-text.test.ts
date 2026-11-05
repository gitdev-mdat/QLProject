import test from 'node:test';
import assert from 'node:assert/strict';
import { leadSearchText, leadText, looksEnglish, NO_CONTENT_STATUS, NO_SUMMARY_STATUS, RECORDED_TEXT } from '../web/lib/lead-text.js';

const VI = 'Quán mình sắp khai trương ở Thủ Đức, cần tìm máy pha cà phê và phần mềm bán hàng.';
const EN = "Advertisement for Hontil Homestay announcing its grand opening ('Khai truong') on November 2, 2026, with a 15% discount.";

test('Vietnamese post text is shown as the original, nothing kept aside', () => {
  const shown = leadText({ content: VI, title: null });
  assert.equal(shown.kind, 'original');
  assert.equal(shown.text, VI);
  assert.equal(shown.stored, null);
  assert.equal(shown.status, null);
});

test('English collector description without a summary: Vietnamese fallback, English kept under "Xem nội dung gốc"', () => {
  const shown = leadText({ content: EN, title: null });
  assert.equal(shown.kind, 'fallback');
  assert.equal(shown.text, RECORDED_TEXT);
  assert.equal(shown.status, NO_SUMMARY_STATUS);
  assert.equal(shown.stored?.text, EN);
  assert.match(shown.stored!.label, /chưa dịch/);
});

test('a backend Vietnamese summary leads, never as a quote, and the stored text stays reachable and searchable', () => {
  const lead = { content: EN, title: null, summary: { text: 'Homestay Hontil khai trương ngày 2/11/2026, giảm giá 15%.', language: 'vi' },
    sourceMetadata: { content: EN, contentKind: 'generated_description' as const, contentLanguage: 'en' } };
  const shown = leadText(lead);
  assert.equal(shown.kind, 'summary');
  assert.equal(shown.text, lead.summary.text);
  assert.equal(shown.stored?.label, 'Mô tả do QLead ghi nhận từ bài đăng (tiếng Anh, chưa dịch)');
  const search = leadSearchText(lead).toLowerCase();
  assert.ok(search.includes('giảm giá') && search.includes('homestay'));
});

test('summary_vi from the backend contract is the Vietnamese preview', () => {
  const shown = leadText({ content: EN, title: null, summary_vi: 'Homestay Hontil thông báo khai trương ngày 2/11/2026.' });
  assert.equal(shown.kind, 'summary');
  assert.equal(shown.stored?.text, EN);
});

test('a non-Vietnamese summary is not used as the Vietnamese preview', () => {
  const shown = leadText({ content: EN, title: null, summary: { text: 'English summary of the post', language: 'en' } });
  assert.equal(shown.kind, 'fallback');
});

test('backend content kind wins over the interim heuristic: a generated Vietnamese description is not quoted as the post', () => {
  const shown = leadText({ content: VI, title: null, sourceMetadata: { content: VI, contentKind: 'generated_description', contentLanguage: 'vi' } });
  assert.equal(shown.kind, 'fallback');
  assert.equal(shown.stored?.label, 'Mô tả do QLead ghi nhận từ bài đăng');
});

test('no extracted content: honest status, no invented text', () => {
  const shown = leadText({ content: '', title: null, sourceMetadata: { content: null } });
  assert.equal(shown.kind, 'fallback');
  assert.equal(shown.status, NO_CONTENT_STATUS);
  assert.equal(shown.stored, null);
  assert.equal(leadSearchText({ content: '', title: null }).trim(), '');
});

test('interim language gate keeps Vietnamese names inside English descriptions out of the Vietnamese preview', () => {
  assert.equal(looksEnglish('Advertisement for Cà Phê Chim Cảnh Hội Ngộ Quán at Mai Xuân Thưởng, Phường Tuy Hòa'), true);
  assert.equal(looksEnglish(VI), false);
  assert.equal(looksEnglish('Tuyển nhân viên phục vụ, quán mới mở cần gấp'), false);
});

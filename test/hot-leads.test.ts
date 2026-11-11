import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHotLead, type HotLeadCandidate } from '../src/hot-leads.js';

const now = new Date('2026-11-10T12:00:00.000Z');
const candidate = (overrides: Partial<HotLeadCandidate> = {}): HotLeadCandidate => ({
  title: null, content: 'Chủ quán đang tìm phần mềm quản lý nhà hàng cho cơ sở sắp khai trương.', summary_vi: null,
  published_at: new Date(now.getTime() - 30 * 60_000), keywords: ['phần mềm quản lý nhà hàng'], description: 'Tôi bán phần mềm quản lý nhà hàng.', ...overrides,
});

test('a recent explicit request relevant to this profile is a grounded Hot Lead', () => {
  const result = assessHotLead(candidate(), now);
  assert.equal(result.hot, true);
  assert.match(result.reasonVi ?? '', /đang tìm phần mềm/);
  assert.doesNotMatch(result.reasonVi ?? '', /dang tim/);
  assert.equal(result.evidence, 'đang tìm phần mềm');
  assert.equal(result.expiresAt?.toISOString(), '2026-11-10T13:30:00.000Z');
});

test('recent but irrelevant posts and relevant but old posts are not Hot', () => {
  assert.equal(assessHotLead(candidate({ content: 'Đang tìm nhà cung cấp cà phê cho quán mới.', keywords: ['phần mềm quản lý nhà hàng'], description: 'Bán phần mềm POS.' }), now).hot, false);
  assert.equal(assessHotLead(candidate({ published_at: new Date(now.getTime() - 3 * 60 * 60_000) }), now).hot, false);
});

test('unknown and future publication times are not Hot; an absent comment count adds no signal', () => {
  assert.equal(assessHotLead(candidate({ published_at: null }), now).hot, false);
  assert.equal(assessHotLead(candidate({ published_at: new Date(now.getTime() + 1_000) }), now).hot, false);
  assert.equal(assessHotLead(candidate(), now).hot, true);
});

test('the same post can be relevant to one profile and not another', () => {
  const post = candidate();
  assert.equal(assessHotLead(post, now).hot, true);
  assert.equal(assessHotLead({ ...post, keywords: ['tuyển nhân viên phục vụ'], description: 'Tôi tuyển nhân viên phục vụ quán.' }, now).hot, false);
});

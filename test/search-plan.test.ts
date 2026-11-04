import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SEARCH_PHRASES, planEarlyFollowup, planFromDescription } from '../src/search-plan.js';

test('turns the F&B opening/recruiting description into business-signal phrases without a hidden region', () => {
  const plan = planFromDescription('Các quán, nhà hàng F&B sắp khai trương hoặc tuyển dụng nhân viên cho quán sắp khai trương.');
  assert.equal(plan.location, null, 'no place named means no geographic limit');
  assert.ok(plan.recognized);
  assert.deepEqual(plan.signals, ['opening_soon', 'recruiting']);
  assert.ok(plan.queries.includes('nhà hàng sắp khai trương'));
  assert.ok(plan.queries.includes('tuyển nhân viên nhà hàng sắp khai trương'));
  assert.ok(plan.queries.length <= MAX_SEARCH_PHRASES);
  assert.ok(plan.queries.every(query => !/pos|phần mềm|cần mua/i.test(query)), 'phrases describe post signals, never a product request');
  assert.equal(plan.name, 'Quán F&B sắp khai trương, đang tuyển người');
});

test('a different business category changes the phrases and keeps an explicitly named place', () => {
  const plan = planFromDescription('Khách sạn, homestay mới khai trương ở Đà Lạt');
  assert.deepEqual(plan.queries, ['khách sạn mới khai trương', 'homestay mới khai trương']);
  assert.equal(plan.location, 'Đà Lạt');
  assert.match(plan.name, /Đà Lạt$/);
});

test('broad F&B intent covers new premises and keeps dessert opportunities within the six-phrase budget', () => {
  const plan = planFromDescription('Quán ăn uống mới thuê mặt bằng hoặc sắp khai trương ở miền Nam');
  assert.deepEqual(plan.signals, ['opening_soon', 'new_premises']);
  assert.equal(plan.location, 'Miền Nam');
  assert.equal(plan.queries.length, 6);
  assert.ok(plan.queries.includes('quán chè sắp khai trương'));
  assert.ok(plan.queries.includes('quán chè mới thuê mặt bằng'));
});

test('broad F&B first scan covers representative subtypes and follow-up uses complementary signals', () => {
  const description = 'Các quán F&B sắp khai trương';
  const initial = planFromDescription(description);
  assert.equal(initial.queries.length, MAX_SEARCH_PHRASES);
  assert.ok(initial.queries.some(query => query.includes('trà sữa')));
  assert.ok(initial.queries.some(query => query.includes('tiệm bánh')));
  const followup = planEarlyFollowup(description, initial.queries);
  assert.ok(followup.length > 0 && followup.length <= MAX_SEARCH_PHRASES);
  assert.ok(followup.every(query => !initial.queries.includes(query)));
  assert.ok(followup.some(query => query.includes('mới thuê mặt bằng')));
  assert.ok(followup.some(query => query.includes('tuyển nhân viên')));
});

test('early follow-up has no invented direction for vague intent or a request without opening intent', () => {
  assert.deepEqual(planEarlyFollowup('cửa hàng cần tìm khách', ['cửa hàng']), []);
  assert.deepEqual(planEarlyFollowup('Quán cà phê đang tuyển người', ['quán cà phê']), []);
});

test('a sweet-soup shop opening and hiring maps to explicit but bounded query phrases', () => {
  const plan = planFromDescription('Quán chè Trung Hoa sắp khai trương và đang tuyển nhân viên ở miền Nam');
  assert.deepEqual(plan.categories, ['dessert_shop']);
  assert.deepEqual(plan.signals, ['opening_soon', 'recruiting']);
  assert.ok(plan.queries.includes('quán chè sắp khai trương'));
  assert.ok(plan.queries.includes('tuyển nhân viên quán chè sắp khai trương'));
  assert.ok(plan.queries.length <= MAX_SEARCH_PHRASES);
  assert.equal(plan.location, 'Miền Nam');
});

test('cafe and milk-tea searches cover opening, recruiting, and branch expansion without losing the requested city', () => {
  const plan = planFromDescription('Quán cà phê, quán trà sữa sắp khai trương, đang tuyển người, mở chi nhánh tại TP.HCM');
  assert.deepEqual(plan.categories, ['cafe', 'milk_tea']);
  assert.deepEqual(plan.signals, ['opening_soon', 'recruiting', 'new_branch']);
  assert.equal(plan.location, 'TP.HCM');
  assert.ok(plan.queries.some(query => query.includes('sắp khai trương')));
  assert.ok(plan.queries.some(query => query.includes('tuyển nhân viên')));
  assert.ok(plan.queries.some(query => query.includes('mở chi nhánh mới')));
});

test('matches places with Vietnamese diacritics at word boundaries', () => {
  assert.equal(planFromDescription('Spa mở chi nhánh mới tại Đà Nẵng').location, 'Đà Nẵng');
  assert.equal(planFromDescription('quán cafe ở Cần Thơ, Đồng Nai').location, 'Cần Thơ, Đồng Nai');
  assert.deepEqual(planFromDescription('Spa sắp mở chi nhánh mới').signals, ['new_branch'], '"sắp mở chi nhánh" is a new branch, not an opening');
});

test('unrecognised wording falls back to the main idea and says so', () => {
  const plan = planFromDescription('Tôi muốn tìm công ty xây dựng cần mua máy phát điện');
  assert.equal(plan.recognized, false);
  assert.equal(plan.queries.length, 1);
  assert.match(plan.queries[0]!, /^công ty xây dựng/);
  assert.equal(plan.notes.length, 1);
});

test('is deterministic so the web preview equals what the server stores', () => {
  const text = 'Quán trà sữa sắp khai trương ở TP.HCM';
  assert.deepEqual(planFromDescription(text), planFromDescription(`  ${text.replace(/ /g, '  ')} `));
});

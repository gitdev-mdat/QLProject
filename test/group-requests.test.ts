import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { pool } from '../src/db.js';
import { createRequest, GroupRequestError, listRequestsForAdmin, listRequestsForUser, updateRequestStatus } from '../src/group-requests.js';

/** Group suggestions against the database (synthetic users, removed afterwards). Run on the isolated test DB. */
async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const code = (fn: () => Promise<unknown>, expected: string) => assert.rejects(fn, (e: GroupRequestError) => e.code === expected);

test('Facebook group requests: ownership, duplicates and Admin review', async t => {
  try { await pool.query('SELECT 1 FROM facebook_group_requests LIMIT 1'); }
  catch { t.skip('Migration 008 not applied'); await pool.end(); return; }
  const ids: string[] = [];
  try {
    for (const name of ['Synthetic Group A', 'Synthetic Group B', 'Synthetic Group Admin']) ids.push((await pool.query('INSERT INTO users(display_name) VALUES ($1) RETURNING id', [name])).rows[0].id);
    const [a, b, admin] = ids;

    await t.test('valid request is stored for the authenticated user with a canonical URL', async () => {
      const r = await createRequest(pool, a, { url: 'https://m.facebook.com/groups/ChuQuanCafe/posts/1?ref=x', note: '  Nhiều chủ quán <b>cafe</b>\u0007 ' });
      assert.equal(r.groupUrl, 'https://www.facebook.com/groups/chuquancafe');
      assert.equal(r.note, 'Nhiều chủ quán <b>cafe</b>', 'control chars stripped; markup kept as text (React escapes it)');
      assert.equal(r.status, 'pending');
    });

    await t.test('equivalent variant from the same user is a duplicate; another user may suggest the same group', async () => {
      await code(() => createRequest(pool, a, { url: 'facebook.com/groups/chuquancafe/' }), 'duplicate');
      const rb = await createRequest(pool, b, { url: 'https://www.facebook.com/groups/chuquancafe' });
      assert.equal(rb.status, 'pending');
      await createRequest(pool, b, { url: 'https://www.facebook.com/groups/khachsanhanoi', note: null });
    });

    await t.test('invalid input is rejected', async () => {
      await code(() => createRequest(pool, a, { url: '' }), 'empty');
      await code(() => createRequest(pool, a, { url: 'https://evil.example/groups/x' }), 'not_facebook');
      await code(() => createRequest(pool, a, { url: 'https://facebook.com/somepage' }), 'not_group');
      await code(() => createRequest(pool, a, { url: 42 }), 'empty');
      await code(() => createRequest(pool, a, { url: 'https://facebook.com/groups/ok2', note: 'x'.repeat(1001) }), 'note_too_long');
    });

    await t.test('each user lists only their own requests', async () => {
      const la = await listRequestsForUser(pool, a); const lb = await listRequestsForUser(pool, b);
      assert.equal(la.length, 1); assert.equal(lb.length, 2);
      assert.ok(!lb.some(r => la.some(x => x.id === r.id)));
    });

    await t.test('Admin transitions are validated; APPROVED never implies ADDED', async () => {
      const [req] = await listRequestsForUser(pool, a);
      await code(() => tx(c => updateRequestStatus(c, admin, req.id, { status: 'added' })), 'invalid_transition');
      await code(() => tx(c => updateRequestStatus(c, admin, req.id, { status: 'deleted' })), 'invalid_status');
      assert.equal((await tx(c => updateRequestStatus(c, admin, req.id, { status: 'reviewing' }))).status, 'reviewing');
      assert.equal((await tx(c => updateRequestStatus(c, admin, req.id, { status: 'approved', adminNote: 'Đã gửi yêu cầu tham gia nhóm' }))).status, 'approved');
      const added = await tx(c => updateRequestStatus(c, admin, req.id, { status: 'added', adminNote: 'Đã xác minh tìm kiếm được bài trong nhóm' }));
      assert.equal(added.status, 'added');
      const [seen] = await listRequestsForUser(pool, a);
      assert.equal(seen.status, 'added'); assert.equal(seen.adminNote, 'Đã xác minh tìm kiếm được bài trong nhóm');
      const all = await listRequestsForAdmin(pool);
      const row = all.find(r => r.id === req.id)!;
      assert.equal(row.requester, 'Synthetic Group A'); assert.equal(row.sameGroupRequests, 2); assert.ok(row.reviewedAt);
      const [, other] = await listRequestsForUser(pool, b);
      assert.equal((await tx(c => updateRequestStatus(c, admin, other.id, { status: 'rejected', adminNote: 'Nhóm riêng tư, không thể hỗ trợ' }))).status, 'rejected');
      await code(() => tx(c => updateRequestStatus(c, admin, '00000000-0000-4000-8000-000000000000', { status: 'reviewing' })), 'not_found');
    });
  } finally {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids]);
    await pool.end();
  }
});

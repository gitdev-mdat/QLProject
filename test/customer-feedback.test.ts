import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../src/db.js';
import { setLeadMonitoringStatus } from '../src/account-monitoring.js';
import {
  claimFeedbackInvitation, declineFeedbackInvitation, FEEDBACK_RULES, getAdminFeedbackReport, getFeedbackEligibility, hasAnyAnswer,
  normalizeFeedbackText, recordLeadSourceOpen, submitCustomerFeedback, type FeedbackAnswers,
} from '../src/customer-feedback.js';

async function tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

const HOUR = 3600_000;
/** Test clock: every call gets an explicit time; nothing depends on the database or machine clock. */
const T0 = new Date('2026-11-01T02:00:00.000Z');
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

test('feedback text is normalized, never invented', () => {
  assert.equal(normalizeFeedbackText(undefined, 10), null);
  assert.equal(normalizeFeedbackText('   \n ', 10), null);
  assert.equal(normalizeFeedbackText(' a\r\nb\u0000c\n\n\n\nd ', 100), 'a\nbc\n\nd');
  assert.equal(normalizeFeedbackText('x'.repeat(50), 10), 'x'.repeat(10));
  assert.equal(normalizeFeedbackText('abc\u202Edef\u2066g', 100), 'abcdefg');
  assert.equal(normalizeFeedbackText('<script>alert(1)</script> & "quotes" 😀', 100), '<script>alert(1)</script> & "quotes" 😀');
  assert.equal(hasAnyAnswer({ easeRating: null, needsRating: null, unmetReason: null, improvement: null }), false);
  assert.equal(hasAnyAnswer({ easeRating: null, needsRating: 2, unmetReason: null, improvement: null }), true);
});

test('one-time feedback: eligibility, single invitation, final decline/submit, isolation, admin report (isolated DB)', async t => {
  try { await pool.query('SELECT 1'); }
  catch { t.skip('PostgreSQL unavailable.'); return; }
  const { rows: [database] } = await pool.query('SELECT current_database() AS name');
  if (!/_test/.test(database.name) && database.name !== 'muse_bridge') { t.skip('Requires an isolated local test database.'); await pool.end(); return; }

  const users: string[] = [];
  const makeUser = async (name: string) => { const id = (await pool.query('INSERT INTO users(display_name) VALUES ($1) RETURNING id', [name])).rows[0].id as string; users.push(id); return id; };
  /** A customer with a search profile and `count` source-linked leads; returns the post ids. */
  async function withLeads(userId: string, count: number, tag: string): Promise<string[]> {
    const profile = (await pool.query("INSERT INTO agent_connections(user_id,name,kind) VALUES ($1,$2,'search_profile') RETURNING id", [userId, `Synthetic FB ${tag}`])).rows[0].id;
    await pool.query(`INSERT INTO scan_configs(agent_connection_id,version,enabled,keywords,location,sources,frequency_minutes) VALUES ($1,1,true,'["x"]','','["social.search"]',30)`, [profile]);
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const url = `https://facebook.com/groups/fbsynthetic${tag}/posts/${i + 1}`;
      ids.push((await pool.query(`INSERT INTO facebook_posts(agent_connection_id,normalized_url,original_url,content,author,published_at,platform,collected_via)
        VALUES ($1,$2,$2,'Synthetic lead','A',now(),'facebook','synthetic') RETURNING id`, [profile, url])).rows[0].id);
      await pool.query('INSERT INTO facebook_post_search_configs(agent_connection_id,normalized_url,configuration_version) VALUES ($1,$2,1)', [profile, url]);
    }
    return ids;
  }
  const answers = (overrides: Partial<FeedbackAnswers> = {}): FeedbackAnswers => ({ submissionId: randomUUID(), context: 'invitation', easeRating: 4, needsRating: 2, unmetReason: null, improvement: null, ...overrides });

  try {
    // 1. A new account without leads.
    const fresh = await makeUser('Synthetic FB Fresh');
    assert.equal((await getFeedbackEligibility(pool, fresh, at(100))).state, 'not_eligible');
    assert.deepEqual(await claimFeedbackInvitation(pool, fresh, { now: at(100) }), { show: false, final: false });

    // 2. Leads, but no Facebook link opened.
    const customer = await makeUser('Synthetic FB Customer');
    const posts = await withLeads(customer, 5, 'c');
    assert.equal((await getFeedbackEligibility(pool, customer, at(100))).distinctSourceOpens, 0);
    assert.equal((await claimFeedbackInvitation(pool, customer, { now: at(100) })).show, false);

    // 3 + 6. Two posts opened, one of them three times: counted once each.
    assert.equal(await recordLeadSourceOpen(pool, customer, posts[0]!, at(0)), true);
    assert.equal(await recordLeadSourceOpen(pool, customer, posts[0]!, at(1)), true);
    assert.equal(await recordLeadSourceOpen(pool, customer, posts[0]!, at(2)), true);
    assert.equal(await recordLeadSourceOpen(pool, customer, posts[1]!, at(2)), true);
    let eligibility = await getFeedbackEligibility(pool, customer, at(100));
    assert.equal(eligibility.distinctSourceOpens, 2);
    assert.equal(eligibility.firstOpenedAt, at(0).toISOString(), 'repeat opens keep the first time');
    assert.equal(eligibility.state, 'not_eligible');
    assert.equal((await claimFeedbackInvitation(pool, customer, { now: at(100) })).show, false);

    // Someone else's lead and unknown ids are refused and never count.
    const other = await makeUser('Synthetic FB Other');
    const otherPosts = await withLeads(other, 3, 'o');
    assert.equal(await recordLeadSourceOpen(pool, customer, otherPosts[0]!, at(2)), false);
    assert.equal(await recordLeadSourceOpen(pool, customer, randomUUID(), at(2)), false);
    assert.equal(await recordLeadSourceOpen(pool, customer, 'not-a-uuid', at(2)), false);
    assert.equal((await getFeedbackEligibility(pool, customer, at(100))).distinctSourceOpens, 2);

    // 4. Third distinct post opened, but under 24 hours since the first open.
    await recordLeadSourceOpen(pool, customer, posts[2]!, at(3));
    assert.equal((await getFeedbackEligibility(pool, customer, at(23.9))).state, 'not_eligible');
    assert.equal((await claimFeedbackInvitation(pool, customer, { now: at(23.9) })).show, false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM customer_feedback_invitations WHERE user_id = $1', [customer])).rows[0].n, 0, 'an early check stores nothing');

    // 19. Suspended account: eligible evidence, but no invitation.
    await tx(client => setLeadMonitoringStatus(client, customer, other, { status: 'suspended' }));
    eligibility = await getFeedbackEligibility(pool, customer, at(30));
    assert.equal(eligibility.state, 'not_eligible');
    assert.equal(eligibility.suspended, true);
    assert.equal((await claimFeedbackInvitation(pool, customer, { now: at(30) })).show, false);
    await tx(client => setLeadMonitoringStatus(client, customer, other, { status: 'active' }));

    // 5 + 18. All conditions met: several tabs/devices claim at once, exactly one wins.
    assert.equal((await getFeedbackEligibility(pool, customer, at(30))).state, 'eligible');
    const claims = await Promise.all(Array.from({ length: 6 }, () => claimFeedbackInvitation(pool, customer, { now: at(30) })));
    const winners = claims.filter(claim => claim.show);
    assert.equal(winners.length, 1, 'only one tab shows the invitation');
    const token = (winners[0] as { token: string }).token;
    assert.ok(claims.filter(claim => !claim.show).every(claim => !claim.show && claim.final));
    assert.equal((await getFeedbackEligibility(pool, customer, at(30))).state, 'shown');

    // The claiming tab may show it again after a reload (token rotated); a stale token or a late reload may not.
    const resumed = await claimFeedbackInvitation(pool, customer, { now: at(30.1), resumeToken: token });
    assert.equal(resumed.show, true);
    assert.equal((await claimFeedbackInvitation(pool, customer, { now: at(30.1), resumeToken: token })).show, false, 'old token is rotated');
    const fresher = (resumed as { token: string }).token;
    assert.equal((await claimFeedbackInvitation(pool, customer, { now: at(31), resumeToken: fresher })).show, false, 'no resume after the window');

    // 10 + 11 + 13. Submit (no reason for Q2), retry with the same id, double click: one row, invitation final.
    const first = answers({ needsRating: 2, unmetReason: null, improvement: 'Thêm lọc theo quận <b>&amp;</b> "SĐT"' });
    const [a, b] = await Promise.all([tx(client => submitCustomerFeedback(client, customer, first, at(31))), tx(client => submitCustomerFeedback(client, customer, first, at(31)))]);
    assert.deepEqual([a, b].map(result => result.ok && result.duplicate).sort(), [false, true]);
    assert.ok(a.ok && a.source === 'invitation');
    const { rows: saved } = await pool.query('SELECT * FROM customer_feedback WHERE user_id = $1', [customer]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].ease_rating, 4);
    assert.equal(saved[0].needs_rating, 2);
    assert.equal(saved[0].unmet_reason, null);
    assert.equal(saved[0].improvement, 'Thêm lọc theo quận <b>&amp;</b> "SĐT"', '14: stored verbatim, escaped only when rendered');
    assert.equal((await getFeedbackEligibility(pool, customer, at(31))).state, 'submitted');

    // 7/8/9. After submitting: never again, whatever the clock, tab, device or new leads.
    await withLeads(customer, 4, 'c2');
    for (const now of [at(32), at(24 * 8), at(24 * 31), at(24 * 400)]) assert.deepEqual(await claimFeedbackInvitation(pool, customer, { now, resumeToken: fresher }), { show: false, final: true });
    assert.equal(await declineFeedbackInvitation(pool, customer, at(40)), false, 'a submitted invitation stays submitted');

    // Decline path: X → final, never shown again, not a rating.
    const decliner = await makeUser('Synthetic FB Decliner');
    const dPosts = await withLeads(decliner, 3, 'd');
    for (const [i, id] of dPosts.entries()) await recordLeadSourceOpen(pool, decliner, id, at(i));
    assert.equal((await claimFeedbackInvitation(pool, decliner, { now: at(48) })).show, true);
    assert.equal(await declineFeedbackInvitation(pool, decliner, at(48.1)), true);
    assert.equal(await declineFeedbackInvitation(pool, decliner, at(48.2)), false, 'idempotent');
    for (const now of [at(49), at(24 * 8), at(24 * 31)]) assert.deepEqual(await claimFeedbackInvitation(pool, decliner, { now }), { show: false, final: true });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM customer_feedback WHERE user_id = $1', [decliner])).rows[0].n, 0);
    // Voluntary feedback after declining is accepted but leaves the decline in place.
    const voluntary = await tx(client => submitCustomerFeedback(client, decliner, answers({ context: 'invitation', easeRating: null, needsRating: null, improvement: 'Chỉ muốn góp ý thêm' }), at(50)));
    assert.ok(voluntary.ok && voluntary.source === 'voluntary', 'a declined invitation cannot be answered as the invitation');
    assert.equal((await getFeedbackEligibility(pool, decliner, at(50))).state, 'declined');

    // Voluntary feedback before any invitation means the account is never invited automatically.
    const early = await makeUser('Synthetic FB Early');
    const ePosts = await withLeads(early, 3, 'e');
    const early1 = await tx(client => submitCustomerFeedback(client, early, answers({ context: 'voluntary', easeRating: 5, needsRating: 5 }), at(1)));
    assert.ok(early1.ok && early1.source === 'voluntary');
    for (const [i, id] of ePosts.entries()) await recordLeadSourceOpen(pool, early, id, at(i));
    assert.deepEqual(await claimFeedbackInvitation(pool, early, { now: at(72) }), { show: false, final: true });

    // Validation, empty answers, spam guard and submission ids owned by someone else.
    assert.deepEqual(await tx(client => submitCustomerFeedback(client, early, answers({ easeRating: 0 }), at(2))), { ok: false, error: 'invalid' });
    assert.deepEqual(await tx(client => submitCustomerFeedback(client, early, answers({ needsRating: 6 }), at(2))), { ok: false, error: 'invalid' });
    assert.deepEqual(await tx(client => submitCustomerFeedback(client, early, answers({ easeRating: 3.5 }), at(2))), { ok: false, error: 'invalid' });
    assert.deepEqual(await tx(client => submitCustomerFeedback(client, early, answers({ easeRating: null, needsRating: null }), at(2))), { ok: false, error: 'empty' });
    assert.deepEqual(await tx(client => submitCustomerFeedback(client, early, answers({ improvement: 'x'.repeat(2001) }), at(2))), { ok: false, error: 'invalid' });
    assert.deepEqual(await tx(client => submitCustomerFeedback(client, other, first, at(2))), { ok: false, error: 'conflict' }, '15: another account cannot reuse or read a submission');
    for (let i = 1; i < FEEDBACK_RULES.voluntaryPerDay; i += 1) assert.ok((await tx(client => submitCustomerFeedback(client, early, answers({ context: 'voluntary' }), at(2)))).ok);
    assert.deepEqual(await tx(client => submitCustomerFeedback(client, early, answers({ context: 'voluntary' }), at(3))), { ok: false, error: 'rate_limited' });
    assert.ok((await tx(client => submitCustomerFeedback(client, early, answers({ context: 'voluntary' }), at(27)))).ok, 'the next day is fine');

    // Database guards behind the code.
    await assert.rejects(pool.query("INSERT INTO customer_feedback(user_id, submission_id, source, ease_rating) VALUES ($1, gen_random_uuid(), 'voluntary', 7)", [early]));
    await assert.rejects(pool.query("INSERT INTO customer_feedback(user_id, submission_id, source) VALUES ($1, gen_random_uuid(), 'voluntary')", [early]));
    await assert.rejects(pool.query("INSERT INTO customer_feedback(user_id, submission_id, source, ease_rating) VALUES ($1, gen_random_uuid(), 'invitation', 3)", [customer]), 'one invitation answer per account');

    // 17. Admin report: averages over real ratings only; declines are a separate count, never a zero.
    const report = await getAdminFeedbackReport(pool, { filter: 'all', limit: 100, offset: 0 });
    const ours = report.items.filter(item => item.user && users.includes(item.user.id));
    assert.equal(ours.length, 1 + 1 + 1 + FEEDBACK_RULES.voluntaryPerDay);
    const { rows: [expected] } = await pool.query(`SELECT count(*)::int AS n, round(avg(ease_rating), 2)::float AS ease, round(avg(needs_rating), 2)::float AS needs,
      count(*) FILTER (WHERE ease_rating <= 2 OR needs_rating <= 2)::int AS low, count(*) FILTER (WHERE unmet_reason IS NOT NULL OR improvement IS NOT NULL)::int AS text
      FROM customer_feedback`);
    assert.equal(report.stats.responses, expected.n);
    assert.equal(report.stats.easeAverage, expected.ease);
    assert.equal(report.stats.needsAverage, expected.needs);
    assert.equal(report.stats.lowRated, expected.low);
    assert.equal(report.stats.withText, expected.text);
    assert.equal(report.stats.easeDistribution.reduce((sum, n) => sum + n, 0), report.stats.easeCount);
    assert.ok(report.stats.invitations.declined >= 1);
    assert.ok(report.stats.invitations.submitted >= 1);
    for (let i = 1; i < report.items.length; i += 1) assert.ok(report.items[i - 1]!.createdAt >= report.items[i]!.createdAt, 'newest first');
    const low = await getAdminFeedbackReport(pool, { filter: 'low', limit: 100, offset: 0 });
    assert.ok(low.items.length > 0 && low.items.every(item => (item.easeRating ?? 5) <= 2 || (item.needsRating ?? 5) <= 2));
    assert.ok(low.items.some(item => item.user?.id === customer));

    // Deleting a lead removes its evidence; deleting an account removes its feedback rows.
    await pool.query('DELETE FROM facebook_posts WHERE id = $1', [posts[2]]);
    assert.equal((await getFeedbackEligibility(pool, customer, at(100))).distinctSourceOpens, 2);
  } finally {
    if (users.length) await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    const { rows: [left] } = await pool.query("SELECT (SELECT count(*) FROM customer_feedback WHERE user_id = ANY($1::uuid[]))::int AS f, (SELECT count(*) FROM lead_source_opens WHERE user_id = ANY($1::uuid[]))::int AS o", [users]);
    assert.deepEqual(left, { f: 0, o: 0 });
    await pool.end();
  }
});

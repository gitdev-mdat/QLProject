import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../src/db.js';
import { consumePasswordReset, createPasswordReset, hashResetToken, isPasswordResetUsable, isResetTokenShape, RESET_RULES } from '../src/password-reset.js';

async function tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

const MINUTE = 60_000;
const T0 = new Date('2026-11-22T02:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE);

test('reset token shape check', () => {
  assert.equal(isResetTokenShape(randomBytes(32).toString('base64url')), true);
  assert.equal(isResetTokenShape(''), false);
  assert.equal(isResetTokenShape('x'.repeat(44)), false);
  assert.equal(isResetTokenShape(`${'a'.repeat(42)}=`), false);
  assert.equal(isResetTokenShape(undefined), false);
});

test('forgot password: single-use, time-limited links, throttling, sign-out everywhere (isolated DB)', async t => {
  try { await pool.query('SELECT 1 FROM password_reset_tokens LIMIT 0'); }
  catch { t.skip('PostgreSQL with migration 026 unavailable.'); return; }
  const { rows: [database] } = await pool.query('SELECT current_database() AS name');
  if (!/_test/.test(database.name)) { t.skip('Requires an isolated local test database.'); return; }

  const run = randomBytes(4).toString('hex');
  const emailA = `reset-${run}-a@qlead.test`;
  const emailB = `reset-${run}-b@qlead.test`;
  const makeUser = async (email: string) => {
    const { rows: [user] } = await pool.query<{ id: string }>("INSERT INTO users(display_name) VALUES ('Reset Test') RETURNING id");
    await pool.query("INSERT INTO user_accounts(user_id, email, password_hash) VALUES ($1, $2, 'scrypt$old')", [user.id, email]);
    return user.id;
  };
  const a = await makeUser(emailA);
  const b = await makeUser(emailB);
  t.after(async () => { await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[a, b]]); await pool.end(); });
  const sessions = async (userId: string) => (await pool.query<{ open: number }>(
    'SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS open FROM web_sessions WHERE user_id = $1', [userId])).rows[0].open;
  const addSession = (userId: string) => pool.query("INSERT INTO web_sessions(user_id, token_hash, created_via, expires_at) VALUES ($1, $2, 'password', now() + interval '7 days')",
    [userId, randomBytes(32).toString('hex')]);
  const passwordOf = async (userId: string) => (await pool.query<{ password_hash: string }>('SELECT password_hash FROM user_accounts WHERE user_id = $1', [userId])).rows[0].password_hash;

  // Unknown email: nothing issued, nothing stored.
  assert.equal(await tx(c => createPasswordReset(c, `nobody-${run}@qlead.test`, at(0))), null);

  // Issue (email is normalized), only the hash is stored.
  const first = await tx(c => createPasswordReset(c, `  ${emailA.toUpperCase()} `, at(0)));
  assert.ok(first);
  assert.equal(first.email, emailA);
  assert.equal(first.expiresAt.getTime(), at(RESET_RULES.linkMinutes).getTime());
  const stored = await pool.query('SELECT token_hash FROM password_reset_tokens WHERE user_id = $1', [a]);
  assert.deepEqual(stored.rows.map(row => row.token_hash), [hashResetToken(first.token)]);
  assert.equal(await isPasswordResetUsable(pool, first.token, at(1)), true);

  // A newer link replaces the older one.
  const second = await tx(c => createPasswordReset(c, emailA, at(2)));
  assert.ok(second);
  assert.equal(await isPasswordResetUsable(pool, first.token, at(3)), false);
  assert.equal(await tx(c => consumePasswordReset(c, first.token, 'scrypt$x', at(3))), null);
  assert.equal(await passwordOf(a), 'scrypt$old');

  // Expired: unusable after linkMinutes.
  assert.equal(await isPasswordResetUsable(pool, second.token, at(2 + RESET_RULES.linkMinutes)), false);
  assert.equal(await tx(c => consumePasswordReset(c, second.token, 'scrypt$x', at(2 + RESET_RULES.linkMinutes + 1))), null);

  // Throttle: at most perAccountPerHour links per rolling hour, then silently none; allowed again an hour later.
  const third = await tx(c => createPasswordReset(c, emailA, at(10)));
  assert.ok(third);
  assert.equal(await tx(c => createPasswordReset(c, emailA, at(11))), null);
  assert.equal(await isPasswordResetUsable(pool, third.token, at(12)), true, 'a throttled request does not end the open link');

  // Consume: password changes, every session of A ends, B untouched; the same link never works twice.
  await addSession(a); await addSession(a); await addSession(b);
  await tx(c => createPasswordReset(c, emailB, at(12)));
  assert.equal(await tx(c => consumePasswordReset(c, third.token, 'scrypt$new', at(13))), a);
  assert.equal(await passwordOf(a), 'scrypt$new');
  assert.equal(await sessions(a), 0);
  assert.equal(await sessions(b), 1);
  assert.equal(await passwordOf(b), 'scrypt$old');
  assert.equal(await tx(c => consumePasswordReset(c, third.token, 'scrypt$again', at(14))), null);
  assert.equal(await passwordOf(a), 'scrypt$new');
  const openB = await pool.query('SELECT 1 FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL', [b]);
  assert.equal(openB.rowCount, 1, "another account's link is not affected");

  // Two tabs submit the same link at once: exactly one wins.
  const fourth = await tx(c => createPasswordReset(c, emailA, at(80)));
  assert.ok(fourth);
  const results = await Promise.all([1, 2, 3, 4].map(n => tx(c => consumePasswordReset(c, fourth.token, `scrypt$race${n}`, at(81)))));
  assert.equal(results.filter(Boolean).length, 1);

  // Deleting the account removes its links.
  await pool.query('DELETE FROM users WHERE id = $1', [a]);
  assert.equal((await pool.query('SELECT 1 FROM password_reset_tokens WHERE user_id = $1', [a])).rowCount, 0);
});

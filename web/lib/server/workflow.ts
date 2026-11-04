import 'server-only';
import { db } from './db';
import { getLeadForUser } from './leads';
import type { LeadNote, LeadStatus, WorkflowMap } from '../lead-workflow';

/** Status and notes for the given posts, for this user only. Posts without a row are 'new'. */
export async function getWorkflowForUser(userId: string, postIds: string[]): Promise<WorkflowMap> {
  if (!postIds.length) return {};
  const [states, notes] = await Promise.all([
    db().query<{ post_id: string; status: LeadStatus; updated_at: Date }>('SELECT post_id, status, updated_at FROM lead_states WHERE user_id = $1 AND post_id = ANY($2::uuid[])', [userId, postIds]),
    db().query<{ id: string; post_id: string; body: string; created_at: Date }>('SELECT id, post_id, body, created_at FROM lead_notes WHERE user_id = $1 AND post_id = ANY($2::uuid[]) ORDER BY created_at DESC', [userId, postIds]),
  ]);
  const map: WorkflowMap = {};
  for (const id of postIds) map[id] = { status: 'new', updatedAt: null, notes: [] };
  for (const row of states.rows) map[row.post_id] = { ...map[row.post_id], status: row.status, updatedAt: row.updated_at.toISOString() };
  for (const row of notes.rows) map[row.post_id]?.notes.push({ id: row.id, body: row.body, createdAt: row.created_at.toISOString() });
  return map;
}

/** Ownership is checked through the same tenant-scoped query the pages use; returns false if not owned. */
export async function setLeadStatus(userId: string, postId: string, status: LeadStatus, onlyIfNew = false): Promise<boolean> {
  if (!await getLeadForUser(userId, postId)) return false;
  if (onlyIfNew) {
    await db().query(`INSERT INTO lead_states(user_id, post_id, status) VALUES ($1, $2, $3) ON CONFLICT (user_id, post_id) DO NOTHING`, [userId, postId, status]);
  } else {
    await db().query(`INSERT INTO lead_states(user_id, post_id, status) VALUES ($1, $2, $3)
      ON CONFLICT (user_id, post_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`, [userId, postId, status]);
  }
  return true;
}

export async function addLeadNote(userId: string, postId: string, body: string): Promise<LeadNote | null> {
  if (!await getLeadForUser(userId, postId)) return null;
  const { rows } = await db().query<{ id: string; body: string; created_at: Date }>(
    'INSERT INTO lead_notes(user_id, post_id, body) VALUES ($1, $2, $3) RETURNING id, body, created_at', [userId, postId, body]);
  return { id: rows[0].id, body: rows[0].body, createdAt: rows[0].created_at.toISOString() };
}

export async function deleteLeadNote(userId: string, postId: string, noteId: string): Promise<boolean> {
  const { rowCount } = await db().query('DELETE FROM lead_notes WHERE id = $1 AND user_id = $2 AND post_id = $3', [noteId, userId, postId]);
  return Boolean(rowCount);
}

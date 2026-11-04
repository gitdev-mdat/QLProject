'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyWorkflow, type LeadNote, type LeadStatus, type LeadWorkflow, type WorkflowMap } from './lead-workflow';

/**
 * Follow-up status and notes for the signed-in user's leads. Starts from the server snapshot and writes every
 * change to the API (optimistic, rolled back on failure). Stored per user in Postgres, so it follows the account.
 */
export function useLeadWorkflow(initial: WorkflowMap) {
  const [map, setMap] = useState<WorkflowMap>(initial);
  const [error, setError] = useState('');
  const mapRef = useRef(map);
  useEffect(() => { mapRef.current = map; }, [map]);

  const get = useCallback((id: string): LeadWorkflow => map[id] ?? emptyWorkflow, [map]);

  const setStatus = useCallback(async (id: string, status: LeadStatus, onlyIfNew = false) => {
    const previous = mapRef.current[id] ?? emptyWorkflow;
    if (onlyIfNew && previous.status !== 'new') return;
    if (previous.status === status) return;
    setMap(current => ({ ...current, [id]: { ...previous, status, updatedAt: new Date().toISOString() } }));
    const response = await fetch(`/api/leads/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status, onlyIfNew }) }).catch(() => null);
    if (!response?.ok) {
      setMap(current => ({ ...current, [id]: previous }));
      setError('Không lưu được trạng thái. Thử lại sau.');
    }
  }, []);

  /** Opening a lead moves it from "new" to "seen"; any later status is kept. */
  const markSeen = useCallback((id: string) => { void setStatus(id, 'seen', true); }, [setStatus]);

  const addNote = useCallback(async (id: string, body: string): Promise<boolean> => {
    const response = await fetch(`/api/leads/${encodeURIComponent(id)}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) }).catch(() => null);
    if (!response?.ok) { setError('Không lưu được ghi chú. Thử lại sau.'); return false; }
    const { note } = await response.json() as { note: LeadNote };
    setMap(current => { const item = current[id] ?? emptyWorkflow; return { ...current, [id]: { ...item, notes: [note, ...item.notes] } }; });
    return true;
  }, []);

  const deleteNote = useCallback(async (id: string, noteId: string) => {
    const response = await fetch(`/api/leads/${encodeURIComponent(id)}/notes/${noteId}`, { method: 'DELETE' }).catch(() => null);
    if (!response?.ok) { setError('Không xóa được ghi chú.'); return; }
    setMap(current => { const item = current[id] ?? emptyWorkflow; return { ...current, [id]: { ...item, notes: item.notes.filter(note => note.id !== noteId) } }; });
  }, []);

  return { get, setStatus, markSeen, addNote, deleteNote, error, clearError: () => setError('') };
}
export type LeadWorkflowApi = ReturnType<typeof useLeadWorkflow>;

/** Client clock for relative times. 0 during server render and hydration, so markup matches; set after mount. */
export function useNow(): number {
  const [now, setNow] = useState(0);
  useEffect(() => { setNow(Date.now()); }, []);
  return now;
}

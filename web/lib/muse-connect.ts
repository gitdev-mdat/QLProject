import type { AdminOverview, AdminWorker } from './server/admin';

/**
 * The owner-facing Muse connection state, derived only from what QLead has recorded. What QLead cannot observe (the
 * Muse Hook, Muse's schedule) is never inferred: "ready" means verified + allowed to take work, not "Hook is on".
 */
export type ConnectionState = 'none' | 'not_connected' | 'waiting' | 'paused' | 'ready' | 'busy' | 'stalled' | 'error';

/** After copying the prompt, the page waits this long for Muse's verification before saying it has not seen it. */
export const WAIT_WINDOW_MS = 30 * 60_000;
/** Work older than this with no claim from an active worker means Muse is evidently not picking work up. */
export const STALL_MS = 20 * 60_000;

/** The worker this environment's page is about: the active one, else the most recently verified, else the newest. */
export function primaryWorker(workers: AdminWorker[]): AdminWorker | null {
  const active = workers.find(w => w.status === 'active' || w.status === 'draining');
  if (active) return active;
  const verified = workers.filter(w => w.connectionVerifiedAt && w.credentialStatus === 'active')
    .sort((a, b) => Date.parse(b.connectionVerifiedAt!) - Date.parse(a.connectionVerifiedAt!));
  return verified[0] ?? workers[workers.length - 1] ?? null;
}

export type ConnectionView = { state: ConnectionState; reason: string | null };

export function connectionState(worker: AdminWorker | null, queue: AdminOverview['queue'], copiedAt: number | null, now: number): ConnectionView {
  if (!worker) return { state: 'none', reason: null };
  if (worker.credentialStatus !== 'active') return { state: 'error', reason: 'Mã bảo mật của worker đã bị thu hồi. Tạo mã mới rồi dán lại prompt vào Muse.' };
  if (worker.status === 'unavailable') return { state: 'error', reason: 'Worker đang bị đánh dấu không khả dụng nên không nhận việc.' };
  const reauth = worker.recentErrors.find(e => e.outcome === 'needs_reauthorization' && now - Date.parse(e.at) < 24 * 3600_000);
  if (worker.status === 'active' && reauth) return { state: 'error', reason: 'Muse báo cần cấp lại quyền truy cập Facebook.' };

  if (!worker.connectionVerifiedAt) {
    if (copiedAt && now - copiedAt < WAIT_WINDOW_MS) return { state: 'waiting', reason: null };
    return { state: 'not_connected', reason: copiedAt ? 'Đã sao chép prompt nhưng QLead chưa nhận được lần xác minh nào từ Muse.' : null };
  }
  if (worker.status !== 'active') return { state: 'paused', reason: worker.status === 'draining' ? 'Worker đang ngừng nhận việc mới.' : null };
  if (worker.inFlight > 0) return { state: 'busy', reason: null };
  const oldest = queue.oldestPendingSlot ? Date.parse(queue.oldestPendingSlot) : null;
  const lastClaim = worker.lastClaimAt ? Date.parse(worker.lastClaimAt) : null;
  const sinceActive = Date.parse(worker.statusChangedAt);
  if (queue.pending > 0 && oldest !== null && now - Math.max(oldest, sinceActive) > STALL_MS && (lastClaim === null || now - lastClaim > STALL_MS)) {
    return { state: 'stalled', reason: null };
  }
  return { state: 'ready', reason: null };
}

/** localStorage key of "prompt copied at", per worker, so waiting survives refresh and navigation. */
export const copiedKey = (workerId: string) => `qlead:muse-connect:copied:${workerId}`;

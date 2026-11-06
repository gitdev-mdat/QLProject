'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { AccountNotification } from '@/lib/server/notifications';
import { NOTIFICATIONS_CHANGED, useSetUnreadNotifications } from './app-shell';

/**
 * Account notifications ("what happened"), newest first. An item counts as read only once it has actually been on screen
 * for a moment (or its reason was opened); opening the page while it is in a background tab marks nothing.
 */
const COPY: Record<AccountNotification['kind'], { title: string; detail: string }> = {
  lead_monitoring_suspended: {
    title: 'Quản trị viên đã tạm dừng tìm lead mới cho tài khoản của bạn.',
    detail: 'Lead, ghi chú và lịch sử đã lưu vẫn được giữ nguyên và xem được như bình thường.',
  },
  lead_monitoring_resumed: {
    title: 'QLead đã tiếp tục tìm lead mới cho tài khoản của bạn.',
    detail: 'Các nhu cầu bạn đang bật sẽ được quét ở lượt theo lịch tiếp theo. Nhu cầu bạn tự tạm dừng vẫn giữ tạm dừng.',
  },
};

const SEEN_AFTER_MS = 1000;
const when = (iso: string) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));

export function NotificationCenter({ initial }: { initial: { items: AccountNotification[]; unread: number } | null }) {
  const [items, setItems] = useState<AccountNotification[] | null>(initial?.items ?? null);
  const [failed, setFailed] = useState(false);
  // Items that were unread when shown keep their "new" look for this visit, even after they are marked read.
  const [fresh, setFresh] = useState<Set<string>>(() => new Set(initial?.items.filter(item => !item.read).map(item => item.id) ?? []));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const setUnread = useSetUnreadNotifications();
  const pending = useRef(new Set<string>());
  const sent = useRef(new Set<string>());
  const flushTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/notifications', { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json() as { items: AccountNotification[]; unread: number };
      setItems(data.items); setFailed(false); setUnread(data.unread);
      setFresh(current => { const next = new Set(current); data.items.forEach(item => { if (!item.read) next.add(item.id); }); return next; });
    } catch { setFailed(true); }
  }, [setUnread]);

  useEffect(() => { if (!initial) void load(); }, [initial, load]);
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener(NOTIFICATIONS_CHANGED, onChanged);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, onChanged);
  }, [load]);

  const flush = useCallback(async () => {
    flushTimer.current = null;
    const ids = [...pending.current].filter(id => !sent.current.has(id));
    pending.current.clear();
    if (!ids.length) return;
    ids.forEach(id => sent.current.add(id));
    try {
      const response = await fetch('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json() as { unread: number };
      setUnread(data.unread);
      setItems(current => current?.map(item => ids.includes(item.id) ? { ...item, read: true } : item) ?? current);
    } catch { ids.forEach(id => sent.current.delete(id)); /* Stays unread; the next view retries. */ }
  }, [setUnread]);

  const markSeen = useCallback((id: string) => {
    if (sent.current.has(id)) return;
    pending.current.add(id);
    if (flushTimer.current === null) flushTimer.current = window.setTimeout(() => void flush(), 150);
  }, [flush]);

  // Unread items become read after being at least half visible for a second while the page itself is visible.
  const observed = useRef(new Map<Element, string>());
  const observer = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const timers = new Map<string, number>();
    observer.current = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = observed.current.get(entry.target);
        if (!id) continue;
        if (entry.isIntersecting && document.visibilityState === 'visible') {
          if (!timers.has(id)) timers.set(id, window.setTimeout(() => { timers.delete(id); markSeen(id); }, SEEN_AFTER_MS));
        } else if (timers.has(id)) { window.clearTimeout(timers.get(id)); timers.delete(id); }
      }
    }, { threshold: 0.5 });
    observed.current.forEach((_id, element) => observer.current?.observe(element));
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') { timers.forEach(timer => window.clearTimeout(timer)); timers.clear(); return; }
      // Re-check what is on screen now that the page is visible again.
      observed.current.forEach((_id, element) => { observer.current?.unobserve(element); observer.current?.observe(element); });
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { observer.current?.disconnect(); observer.current = null; timers.forEach(timer => window.clearTimeout(timer)); document.removeEventListener('visibilitychange', onVisibility); };
  }, [markSeen]);
  const watch = useCallback((id: string, unread: boolean) => (element: HTMLLIElement | null) => {
    for (const [el, value] of observed.current) if (value === id && el !== element) { observer.current?.unobserve(el); observed.current.delete(el); }
    if (!element || !unread) return;
    observed.current.set(element, id);
    observer.current?.observe(element);
  }, []);

  const toggleReason = (id: string) => {
    setOpen(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    markSeen(id);
  };
  const unreadIds = items?.filter(item => !item.read).map(item => item.id) ?? [];

  return <section className="panel notif-panel" aria-labelledby="notif-title">
    <div className="panel-head">
      <h2 id="notif-title">Gần đây</h2>
      {unreadIds.length > 1 && <button type="button" className="text-link notif-all" onClick={() => { unreadIds.forEach(markSeen); }}>Đánh dấu đã đọc</button>}
    </div>
    {items === null
      ? failed
        ? <p className="notif-empty" role="alert">Chưa tải được thông báo. <button type="button" className="text-link" onClick={() => void load()}>Thử lại</button></p>
        : <p className="notif-empty muted-text" role="status">Đang tải thông báo…</p>
      : items.length === 0
        ? <p className="notif-empty muted-text">Chưa có thông báo nào. QLead sẽ báo ở đây khi có thay đổi quan trọng với tài khoản của bạn.</p>
        : <ul className="notif-list">{items.map(item => {
          const copy = COPY[item.kind];
          const isNew = fresh.has(item.id);
          const reasonId = `notif-reason-${item.id}`;
          return <li key={item.id} ref={watch(item.id, !item.read)} className={`notif${isNew ? ' is-new' : ''}`} data-notification={item.id}>
            <span className="notif-mark" aria-hidden="true"/>
            <div className="notif-body">
              <p className="notif-title">{isNew && <span className="sr-only">Mới: </span>}{copy.title}</p>
              <p className="notif-detail">{copy.detail}</p>
              <p className="notif-meta">
                <time dateTime={item.createdAt}>{when(item.createdAt)}</time>
                {item.publicReason && <button type="button" className="notif-reason-toggle" aria-expanded={open.has(item.id)} aria-controls={reasonId} onClick={() => toggleReason(item.id)}>{open.has(item.id) ? 'Ẩn lý do' : 'Xem lý do'}</button>}
                {item.kind === 'lead_monitoring_resumed' && <Link className="notif-link" href="/app/bo-loc">Xem nhu cầu</Link>}
              </p>
              {item.publicReason && open.has(item.id) && <p className="notif-reason" id={reasonId}>{item.publicReason}</p>}
            </div>
          </li>;
        })}</ul>}
  </section>;
}

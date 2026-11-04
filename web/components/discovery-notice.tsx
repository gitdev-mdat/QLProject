'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { FirstScan } from '@/lib/first-scan';
import { discoveryView } from '@/lib/first-discovery';
import { frequencyLabel } from '@/lib/profile-state';
import { useFirstScan } from './first-scan';
import { Icon } from './visuals';

/** How long after the extra search finished its outcome is still worth a line on Today and the lead list. */
const RECENT_MS = 60 * 60_000;

/**
 * A slim line on Today and the lead list while QLead is still looking further after a first search that already
 * found leads, and briefly once that extra search ends. Leads stay usable underneath; when the extra search ends the
 * page reloads its data from the server, so new leads appear without the customer doing anything.
 */
export function DiscoveryNotice({ initial, place }: { initial: FirstScan; place: 'today' | 'list' }) {
  const router = useRouter();
  const scan = useFirstScan(initial);
  const view = discoveryView(scan);
  const open = view.stage === 'more';
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) router.refresh();
    wasOpen.current = open;
  }, [open, router]);

  const dismissKey = view.moreFinishedAt ? `qlead:discovery-notice-dismissed:${scan.profile.id}:${view.moreFinishedAt}` : null;
  const [now, setNow] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setNow(Date.now());
    try { setDismissed(Boolean(dismissKey) && window.localStorage.getItem(dismissKey!) === '1'); } catch { /* storage unavailable */ }
  }, [dismissKey]);
  function dismiss() {
    setDismissed(true);
    try { if (dismissKey) window.localStorage.setItem(dismissKey, '1'); } catch { /* storage unavailable */ }
  }

  const name = `“${scan.profile.name}”`;
  if (open) {
    const running = view.more === 'running';
    return <aside className="discovery-notice is-open" aria-live="polite">
      <span className="discovery-notice-icon" aria-hidden="true">{running ? <span className="first-scan-live"/> : <Icon name="clock" size={18}/>}</span>
      <p><b>{running ? 'QLead đang tìm thêm cơ hội' : 'QLead sẽ tiếp tục tìm thêm cơ hội'} cho {name}.</b> <span>{place === 'list'
        ? 'Bạn xem được các lead dưới đây ngay. Lead mới (nếu có) sẽ tự thêm vào danh sách.'
        : 'Lead đã có bạn xem được ngay. Lead mới (nếu có) sẽ tự vào danh sách.'}</span></p>
      <Link className="text-link discovery-notice-link" href="/app/lan-tim-dau">Xem tiến trình</Link>
    </aside>;
  }

  const recent = view.moreFinishedAt && now && now - new Date(view.moreFinishedAt).getTime() < RECENT_MS;
  if (view.stage !== 'done' || !recent || dismissed || view.hold) return null;
  if (view.moreOutcome !== 'found' && view.moreOutcome !== 'none') return null;
  const found = view.moreOutcome === 'found';
  return <aside className={`discovery-notice ${found ? 'is-found' : 'is-quiet'}`} aria-live="polite">
    <span className="discovery-notice-icon" aria-hidden="true"><Icon name={found ? 'spark' : 'check'} size={18}/></span>
    <p>{found
      ? <><b>QLead đã tìm thêm được {view.moreLeads} lead mới</b> <span>cho {name}.</span></>
      : <><b>QLead đã tìm thêm xong, chưa có lead mới</b> <span>cho {name}. QLead tiếp tục theo dõi {frequencyLabel(scan.profile.frequencyMinutes)}.</span></>}</p>
    {found && place === 'today' && <Link className="text-link discovery-notice-link" href={`/app/bai-viet?nhu-cau=${scan.profile.id}`}>Xem lead</Link>}
    <button type="button" className="icon-btn discovery-notice-close" onClick={dismiss} aria-label="Ẩn thông báo">×</button>
  </aside>;
}

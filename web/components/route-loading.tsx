'use client';

import { usePathname } from 'next/navigation';
import './route-loading.css';

type Shape = 'today' | 'list' | 'detail' | 'cards' | 'table';

/** The destination's real heading and a rough outline of its content, so the switch reads as "this page, filling in". */
function routeFor(path: string): { title: string | null; shape: Shape } {
  if (path === '/app') return { title: 'Hôm nay', shape: 'today' };
  if (path === '/app/bai-viet') return { title: 'Danh sách lead', shape: 'list' };
  if (path.startsWith('/app/bai-viet/')) return { title: null, shape: 'detail' };
  if (path.startsWith('/app/bo-loc')) return { title: 'Nhu cầu theo dõi', shape: 'cards' };
  if (path.startsWith('/app/de-xuat-nhom')) return { title: 'Đề xuất nhóm Facebook', shape: 'cards' };
  if (path.startsWith('/app/lich-su-quet')) return { title: 'Lịch sử quét', shape: 'list' };
  if (path.startsWith('/admin/users')) return { title: 'Khách hàng', shape: 'table' };
  if (path.startsWith('/admin/workers')) return { title: 'Kết nối Muse', shape: 'cards' };
  if (path.startsWith('/admin/group-requests')) return { title: 'Đề xuất nhóm', shape: 'table' };
  return { title: null, shape: 'cards' };
}

const Bar = ({ w, h = 14 }: { w: string; h?: number }) => <span className="rl-bar" style={{ width: w, height: h }}/>;

/**
 * Route-level loading UI (used by loading.tsx). It is prefetched with the layout, so a click swaps <main> to this at
 * once while the page's data is fetched. It stays invisible for the first 150 ms, so a fast response replaces it
 * without a skeleton flash. No spinner, no progress numbers: only the outline of what is coming.
 */
export function RouteLoading() {
  const { title, shape } = routeFor(usePathname());
  return <div className="route-loading" data-route-loading aria-busy="true">
    <span className="sr-only" role="status">Đang tải{title ? ` ${title.toLocaleLowerCase('vi')}` : ''}…</span>
    {shape === 'detail'
      ? <div className="rl-detail" aria-hidden="true"><Bar w="9rem"/><div className="rl-panel"><Bar w="55%" h={22}/><Bar w="90%"/><Bar w="80%"/><Bar w="40%"/></div></div>
      : <div aria-hidden="true">
        <div className="page-head rl-head"><div>{title ? <p className="rl-title">{title}</p> : <Bar w="12rem" h={26}/>}<Bar w="18rem"/></div></div>
        {shape === 'today' && <div className="rl-grid"><div className="rl-panel rl-tall"><Bar w="40%" h={18}/><Bar w="85%"/><Bar w="75%"/><Bar w="60%"/></div><div className="rl-panel"><Bar w="50%" h={18}/><Bar w="70%"/><Bar w="55%"/></div></div>}
        {(shape === 'list' || shape === 'table') && <div className="rl-panel rl-rows">{Array.from({ length: 6 }, (_, i) => <div key={i} className="rl-row"><Bar w="4.5rem"/><Bar w={`${60 - (i % 3) * 10}%`}/><Bar w="5rem"/></div>)}</div>}
        {shape === 'cards' && <div className="rl-cards">{Array.from({ length: 3 }, (_, i) => <div key={i} className="rl-panel"><Bar w="45%" h={18}/><Bar w="80%"/><Bar w="65%"/></div>)}</div>}
      </div>}
  </div>;
}

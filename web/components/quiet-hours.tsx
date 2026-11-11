'use client';

import { useEffect, useState } from 'react';
import { isSearchQuietHours } from '../../src/quiet-hours';
import './quiet-hours.css';

/** The calm overnight status shown instead of a countdown while new searches are paused. */
export function QuietHoursNote({ compact = false }: { compact?: boolean }) {
  return <p className={`quiet-note ${compact ? 'is-compact' : ''}`} role="status">
    <span className="quiet-moon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M10.8 1.6A6.5 6.5 0 1 0 14.4 11 5.3 5.3 0 0 1 10.8 1.6Z" fill="currentColor"/></svg></span>
    <span><b>QLead đang tạm nghỉ ban đêm</b> Việc tìm khách hàng mới sẽ tiếp tục từ 06:30. Bạn vẫn xem lead và sửa nhu cầu bình thường.</span>
  </p>;
}

/**
 * Whether new searches are paused overnight right now, re-checked every 30 seconds so 00:30 and 06:30 flip the UI on
 * their own. The rule is the backend's own helper (src/quiet-hours.ts), never a second copy of it. False until mounted.
 */
export function useQuietHours(): boolean {
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    const check = () => setQuiet(isSearchQuietHours(new Date()));
    check();
    const timer = window.setInterval(check, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return quiet;
}

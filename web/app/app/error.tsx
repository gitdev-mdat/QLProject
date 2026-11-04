'use client';

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return <div className="empty-state"><h1>Không tải được dữ liệu</h1><p>Kiểm tra Postgres cục bộ đang chạy rồi thử lại.</p><button type="button" className="btn btn-primary" onClick={reset}>Thử lại</button></div>;
}

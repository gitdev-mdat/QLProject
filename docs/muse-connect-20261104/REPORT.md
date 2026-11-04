# Kết nối Muse: một prompt, trạng thái thật (2026-11-04)

## 1. Vấn đề cũ
- `/admin/workers` ("Tài khoản Muse") mở ra bằng thẻ worker kỹ thuật 12 dòng (ACTIVE/PAUSED, /claim, lease, nguồn…), nhiều nút ngang hàng (Hướng dẫn kết nối, Hướng dẫn Hook, Kích hoạt, Không khả dụng, Tạo lại credential) và modal 5 bước tự tạo connector.
- Prompt luôn ghi connector `"QLead Worker"` + header ngrok, kể cả trên Production → dễ dùng nhầm connector Local.
- Lần tìm đầu nói "sẽ bắt đầu ngay khi hệ thống tìm kiếm nhận lượt" dù không có worker nào hoạt động.

## Đã xác minh nguyên nhân kẹt lần tìm đầu (Production, chỉ đọc)
- `GET https://qlead.vercel.app/api/public/worker-dispatch` → `{"wake":false}`; `/health` ok. Theo `src/wake-signal.ts`, wake chỉ bật khi có đúng một worker `active` + credential `active` + việc đủ điều kiện → Worker 02 đang PAUSED là chỗ kẹt (cộng thêm Hook Muse vẫn trỏ Local).
- Biến Vercel Production (chỉ đọc tên): **không có** `QLEAD_DISPATCH_SECONDARY_WAKE_URL` → nếu đổi Hook sang dispatcher bây giờ, Local (Worker 01) sẽ ngừng được đánh thức.
- Không đọc trực tiếp DB Supabase (quyền tự động chặn truy vấn production).

## 2. Trải nghiệm mới
Trang **Kết nối Muse** (nhãn môi trường Production/Local) gồm một thẻ trạng thái + một nút chính **"Sao chép prompt kết nối Muse"**. Mọi thứ kỹ thuật cũ nằm trong **"Chi tiết kỹ thuật"** (thu gọn, nhớ trạng thái theo trình duyệt, tự mở khi có lượt chuyển đổi).

Trạng thái (`web/lib/muse-connect.ts`, chỉ từ dữ liệu QLead ghi nhận):

| Trạng thái | Bằng chứng |
|---|---|
| Chưa kết nối | `connection_verified_at` rỗng |
| Đang chờ Muse xác minh | đã sao chép prompt (localStorage theo worker) và chưa có xác minh; tối đa 30 phút, tự làm mới 5 giây/lần; quá hạn → quay về "Chưa kết nối" kèm lý do |
| Đã xác minh · đang tạm dừng | đã xác minh, status ≠ active → nút "Cho phép nhận việc" (API activate có sẵn) |
| Sẵn sàng nhận việc | active + đã xác minh; hiện lần gọi nhận việc gần nhất |
| Đang xử lý | có lease hợp lệ |
| Muse chưa nhận việc | có việc chờ > 20 phút, không có lần claim nào trong 20 phút → gợi ý kiểm tra Hook |
| Lỗi kết nối | credential bị thu hồi, worker unavailable, hoặc needs_reauthorization 24h |

Luôn ghi rõ: QLead không đọc được trạng thái Hook; ACTIVE không có nghĩa Hook đang bật.

Prompt (`museConnectPrompt` trong `web/lib/admin-prompts.ts`): đầy đủ, theo môi trường, dán lại được nhiều lần. Bước 0 kiểm tra công cụ Muse thật sự có → Bước 1 connector riêng (`QLead Worker Production`, base `https://qlead.vercel.app`, không header ngrok; cấm dùng `QLead Worker`/`Local Lead Bridge`) → Bước 2 đúng một `GET /api/worker/status`, kiểm tra `name` = worker → Bước 3 nếu chưa active thì dừng → Bước 4 Hook chỉ đọc; chỉ sửa Hook hiện có khi chủ gõ `ĐỒNG Ý CHUYỂN HOOK SANG PRODUCTION`, có cảnh báo Local khi dispatcher chưa relay. Mẫu báo cáo cuối cố định. Không chứa credential.

Lần tìm đầu: `FirstScan.searchReady` (có worker active + credential active + đã xác minh). Khi false → "Lượt tìm đầu tiên chưa thể bắt đầu", không ước tính 2–3 phút, không thanh tiến trình, không nhắc Muse/worker. Đã bỏ dòng "Thời gian chờ trong hàng không tính vào ước tính này…".

## 3. Owner cần làm
1. Mở https://qlead.vercel.app/admin/workers → "Sao chép prompt kết nối Muse" → dán vào Muse MAIN.
2. Khi Muse cần mã: bấm "Tạo mã bảo mật" (hiện một lần), nhập vào ô bí mật của connector `QLead Worker Production` trong Muse. Đây là bước tay duy nhất không tránh được với hệ thống hiện tại (QLead chỉ lưu hash; Muse không có API công khai để QLead đẩy secret).
3. Trang chuyển "Đã xác minh" → bấm "Cho phép nhận việc" → dán lại prompt để Muse kiểm tra Hook. Quyết định có chuyển Hook hay không (xem cảnh báo Local).

## 4. File
- `web/components/muse-connect.tsx`, `web/components/muse-connect.css`, `web/lib/muse-connect.ts` (mới)
- `web/components/admin-workers.tsx`, `web/lib/admin-prompts.ts`, `web/lib/server/admin.ts`, `web/app/admin/workers/page.tsx`, `web/components/admin-nav.tsx`
- `web/lib/first-scan.ts`, `web/lib/server/first-scan.ts`, `web/components/first-scan.tsx`
- `web/e2e/muse-connect-e2e.mts` (mới), `web/e2e/admin-workers-e2e.mts` (tiêu đề + mở Chi tiết kỹ thuật)

## 5. Kiểm thử
`web/e2e/muse-connect-e2e.mts` trên DB riêng `muse_bridge_test_museconnect`, Next dev, Muse giả lập qua worker API thật: **16/16** — chưa kết nối, sao chép (clipboard = prompt), đúng worker/URL/connector, không lộ token/Bearer/DB URL, chờ xác minh, giữ trạng thái khi reload/chuyển trang, tự cập nhật sau `/status`, tạm dừng → cho phép nhận việc → sẵn sàng, Muse chưa nhận việc, đang xử lý, lỗi credential, prompt Production (hàm thuần), 390/768/1440 không tràn ngang, không lỗi trang; trang lần tìm đầu chưa sẵn sàng/đã sẵn sàng. Ảnh trong `screens/`.
Unit `test/admin-prompts.test.ts` 3/3. `tsc --noEmit` (web) sạch.
`admin-workers-e2e.mts` (bộ handoff cũ) 15/25 trên cùng DB riêng: bước lỗi đầu tiên (16) kiểm chữ "Prompt một chu kỳ làm việc" mà panel chuyển đổi không hiển thị từ trước thay đổi này; các bước sau lỗi dây chuyền vì lượt chuyển đổi còn mở. Chưa sửa bộ này.
Giao diện Production chỉ được kiểm qua hàm thuần + chế độ Local (DB production không thể chạy cục bộ do guard môi trường). Chưa deploy.

## 6. Kết nối Muse thật
**Chưa kết nối.** Không có xác minh nào từ Muse; Worker 02 PAUSED theo Admin; dispatcher production `wake:false`.

## 7. Handoff Backend cho Codex (nhỏ, không bắt buộc để dùng ngay)
1. **Quan sát Hook production** (khuyến nghị): ghi thời điểm gọi gần nhất của `GET /api/public/worker-dispatch` (một dòng, không IP/danh tính) và trả qua `/api/admin/workers` → Admin hiện "Hook đang gọi Production lúc …" thay vì chỉ suy từ claim.
2. **Phân biệt 401**: token hiện không gắn worker nên QLead không biết Muse đang gửi sai mã. Tiền tố id công khai trong token (`<worker_prefix>.<secret>`) cho phép ghi `last_auth_failure_at` → trạng thái "Mã bảo mật sai".
3. **Pairing (chỉ khi xác minh được Muse có công cụ ghi secret vào connector mà không đưa vào hội thoại)**: mã ghép một lần, 10 phút, chỉ băm, gắn một worker; `POST /api/worker/pair` đổi lấy credential. Nếu không xác minh được, giữ bước nhập tay.
4. `searchReady` trong `GET /api/first-scan` đang được web tính từ `muse_workers`; nếu Codex muốn sở hữu hợp đồng này thì đưa vào API chính thức.
5. Ops (owner quyết): đặt `QLEAD_DISPATCH_SECONDARY_WAKE_URL` trên Vercel Production trước khi chuyển Hook, nếu muốn Local tiếp tục chạy.

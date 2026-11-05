# Kết nối Muse 2, 3, 4: kiểm tra lần cuối Admin (2026-11-05)

Nhánh `feature/muse-connect-onboarding`. Chưa deploy production.

## 1. Nguyên nhân Admin 404
- Không có route `/app/admin` (Admin nằm ở `/admin`), và app khách không có link nào sang Admin, nên owner phải tự gõ URL.
- Admin production mới (có `user_accounts`, chưa có nhu cầu tìm kiếm) bị đăng nhập đẩy sang `/bat-dau`, và layout `/app` cũng ép sang onboarding.

Sửa:
- `web/app/app/admin/page.tsx`: chạy `requireAdmin()` trước rồi mới chuyển sang `/admin/workers`. Chưa đăng nhập thì về trang đăng nhập; không phải admin thì vẫn 404 như trước. Không nới quyền.
- Đăng nhập bằng mật khẩu: admin (allowlist phía server) vào thẳng `/admin/workers`.
- Layout `/app`: admin không bị ép onboarding khách; sidebar và topbar mobile có link "Quản trị" chỉ cho admin.

## 2. File thay đổi (so với commit trước trên nhánh)
- `web/app/app/admin/page.tsx` (mới), `web/app/app/layout.tsx`, `web/app/api/auth/login/route.ts`, `web/components/app-shell.tsx`
- `web/components/muse-connect.tsx`, `web/components/muse-connect.css`, `web/components/admin-workers.tsx`
- `web/lib/admin-prompts.ts`, `web/lib/server/admin.ts`
- `web/e2e/muse-connect-e2e.mts` (viết lại), `web/e2e/admin-workers-e2e.mts` (sửa 3 chỗ lỗi thời)

## 3. Luồng kết nối Muse 2
Admin → chọn "Muse Worker 02" (hoặc "Thêm tài khoản Muse") → "Sao chép prompt kết nối Muse" → dán vào Muse MAIN của **tài khoản Muse 2** → khi Muse cần, bấm "Tạo mã bảo mật" (hiện một lần) và nhập vào ô bí mật của connector `QLead Worker Production` → QLead tự cập nhật "Đã xác minh" (chỉ khi có lần gọi `/api/worker/status` thành công) → "Cho phép nhận việc" → dán lại prompt để Muse bật Hook riêng của tài khoản này → "Sẵn sàng nhận việc".

Prompt production: Worker 02, `https://qlead.vercel.app`, connector `QLead Worker Production`, không header ngrok. Hook riêng `qlead-worker-wake` của tài khoản Muse 2, GET `https://qlead.vercel.app/api/public/worker-wake`, chỉ tạo/bật khi worker đã ACTIVE, tối đa một Hook QLead. Không có hướng dẫn chuyển Hook Local, không dùng dispatcher. Nếu tài khoản Muse đang dán có connector Local hoặc Hook trỏ URL khác thì Muse dừng và báo nhầm tài khoản. Không chứa credential.

## 4. Quản lý nhiều tài khoản
- Danh sách "Tài khoản Muse (N)" bên trái (xếp chồng trên mobile): tên, trạng thái QLead (Đang nhận việc mới · ACTIVE / Tạm dừng · PAUSED / Đang ngừng nhận việc · DRAINING / Không khả dụng · UNAVAILABLE), trạng thái kết nối, số lượt tìm đã hoàn tất và lần gần nhất. Ghi rõ tài khoản nào đang nhận việc mới.
- Chọn tài khoản → thẻ chính và prompt đổi theo tài khoản đó; lựa chọn được nhớ khi tải lại trang.
- "Thêm tài khoản Muse": gợi ý tên kế tiếp (Muse Worker 03…), tạo worker tạm dừng, hiện mã một lần, tự chọn tài khoản mới. Tài khoản cũ và lịch sử giữ nguyên. Nguồn và số job nằm trong "Tuỳ chọn nâng cao".
- Kích hoạt chỉ khi đã xác minh và chưa có tài khoản nào nhận việc. Nếu đã có, thẻ giải thích chuyển đổi an toàn và nút "Chuẩn bị chuyển từ …" mở đúng luồng handoff có sẵn (xem trước → tạo bản chuẩn bị). Khi có lượt chuyển đổi, banner ở đầu trang và "Xem lượt chuyển đổi" mở phần kỹ thuật. Không có nút nào bỏ việc.

## 5. Kiểm thử trình duyệt
`web/e2e/muse-connect-e2e.mts` trên DB riêng `muse_bridge_test_museconnect` (Muse giả lập qua API worker thật): **20/20**. Gồm: chưa đăng nhập `/app/admin` → đăng nhập; khách → 404 cho `/app/admin`, `/admin/workers`, API; admin mới đăng nhập mật khẩu → vào Admin; link "Quản trị" + `/app/admin`; Muse 2 chưa kết nối → sao chép prompt (không secret) → tạo mã (chỉ lưu hash, mã cũ 401) → chờ xác minh (giữ qua reload/chuyển trang) → tự cập nhật → kích hoạt → đang xử lý → lịch sử; thêm Muse 3 không thay Muse 2; Muse 3 không kích hoạt được song song, tạo bản chuẩn bị chuyển đổi rồi huỷ (Muse 2 vẫn ACTIVE); lịch sử còn nguyên; lỗi credential; prompt production (hàm thuần); 390/768/1440 không tràn ngang; lần tìm đầu trung thực. Ảnh trong `screens/`.

## 6. Bộ kiểm thử handoff cũ
`web/e2e/admin-workers-e2e.mts`: **25/25** (trước: 15/25). Nguyên nhân lỗi cũ, không phải do tính năng hỏng:
1. Bước 16 kiểm tra nhãn "Prompt một chu kỳ làm việc" mà panel chuyển đổi đã bỏ từ commit 48b6120 (thay bằng prompt kích hoạt Hook). Nay kiểm tra nhãn "Prompt kích hoạt Hook · E2E Muse 02".
2. Muse giả lập nộp kết quả không kèm `attempt_no`. Backend đã bắt buộc trường này cho job được giao lại (`src/worker-api.ts`, attempt identity), nên kết quả bị từ chối và handoff không hoàn tất, kéo theo 8 bước sau. Nay gửi `attempt_no` của job; bước "kết quả cũ của Muse 01 bị từ chối" vẫn được kiểm và vẫn đạt.
3. Đổi tiêu đề hộp mã bảo mật mới.
Không bỏ hay nới assertion nào. `test/admin-prompts.test.ts` 3/3, `tsc --noEmit` sạch.

## 7. Production
Giao diện Production chỉ được kiểm qua chế độ Local (guard môi trường không cho DB production chạy cục bộ) và hàm prompt thuần. Chưa tạo hay kích hoạt worker production nào. Chưa deploy.

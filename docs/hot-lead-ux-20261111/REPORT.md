# Hot Lead, "Không quan tâm", giờ nghỉ đêm — báo cáo frontend (2026-11-11)

Nhánh `claude/hot-lead-ux`, dựng trên backend của Codex `codex/hot-lead-quiet-hours` (PR #24). Frontend không tự phân loại Hot: chỉ hiển thị `hotAssessments` (status, reasonVi, expiresAt) do server trả về.

## Thiết kế
- **Hot Lead**: một dải "Có N Hot Lead nên xem ngay" phía trên danh sách thường (Hôm nay, Danh sách lead), tối đa 3 dòng, mỗi dòng có lý do của server, giờ đăng thật ("Đăng 15 phút trước" / "Chưa rõ giờ đăng"), nút chính "Xem bài Facebook" và "Mở lead". Nhãn nhỏ "Hot Lead" + viền cam ấm trên dòng/thẻ. Chip lọc "Hot Lead (N)" và `?hot=1`. Không có Hot thì không hiện gì (không có số 0, không placeholder).
- **Chi tiết lead**: khung "Hot Lead · Khách hàng đang có nhu cầu rõ ràng", lý do, giờ đăng, "Nên liên hệ trước HH:MM". Hết hạn → "Từng là Hot Lead khi QLead tìm thấy…". Nhãn tự tắt đúng `expiresAt` khi trang đang mở.
- **Màu**: giữ xanh QLead; một màu cam ấm nhạt cho Hot, không nền đỏ, không nhấp nháy.
- **Mừng**: lần đầu thiết bị thấy một Hot Lead: dê nhảy nhẹ + quầng ấm ~2 giây + câu chúc. Nhớ theo id trong localStorage, không lặp khi tải lại/chuyển trang, không chạy khi đang mở lead khác, tắt với prefers-reduced-motion, không âm thanh.
- **Push**: sw.js nhận `kind: 'hot_lead'`, tag riêng `hot-lead-<id>`, `requireInteraction` + nút "Xem Hot Lead" nơi trình duyệt hỗ trợ; bấm mở `/mo?den=/app/bai-viet/<id>`. Trang đang mở tự làm mới khi có push Hot. Không hứa âm thanh/rung.
- **Cài PWA**: dòng "Đừng bỏ lỡ Hot Lead" chỉ nằm trong dải Hot (tức là sau khi đã có Hot thật); ẩn trong app đã cài; "Để sau" ẩn luôn cả gợi ý cài trên Hôm nay. Gợi ý cài chung trên Hôm nay giờ chỉ hiện khi đã có lead. Không xin quyền thông báo khi tải trang.
- **Giờ nghỉ đêm (00:30–06:30)**: Hôm nay thay đồng hồ đếm ngược bằng "QLead đang tạm nghỉ ban đêm · Việc tìm khách hàng mới sẽ tiếp tục từ 06:30"; nếu lượt kế tiếp rơi vào giờ nghỉ thì không đếm ngược tới đó. Thẻ Nhu cầu: lượt chờ → "Lượt tìm đã được giữ và sẽ bắt đầu từ 06:30", nút đổi thành "Tìm lại lúc 06:30", phản hồi `quietHoursActive` được giải thích. Lượt tìm đầu: pha "quiet" thay cho "chậm/đang chờ lâu". Tài khoản bị tạm dừng: thông báo tạm dừng thắng giờ nghỉ.
- **Không quan tâm**: thêm vào bộ chọn trạng thái (cạnh "Không phù hợp"), tab lọc + số đếm; dòng giải thích ngắn dưới bộ chọn phân biệt hai trạng thái.
- **Mô tả nhu cầu**: "Bạn kinh doanh gì và muốn tìm khách hàng nào?", ví dụ "Tôi đang bán phần mềm quản lý, tính tiền và muốn tìm các quán F&B sắp khai trương."

## QA
`web/e2e/hot-lead-ux-e2e.mts` trên DB riêng `muse_bridge_test_hot` (001–025), worker giả gọi API worker thật (phân loại Hot là code của Codex): **25/25**. Bao gồm 20 kịch bản của brief + 390/768/1440 không cuộn ngang. Production build OK, test quiet-hours/hot-leads 8/8. Ảnh chụp ở `docs/hot-lead-ux-20261111/screenshots/` (png bị gitignore).
Chưa xác minh: push thật trên iPhone/Android (chỉ giả lập desktop); thời gian điều hướng chỉ đo trên dev build.

## Vấn đề gửi Codex
- `reasonVi` chứa cụm bằng chứng đã bỏ dấu, ví dụ: Bài đăng còn mới, nêu nhu cầu “dang can tim”… Khách sẽ thấy chữ không dấu. Nên dùng đoạn gốc có dấu.
- Hot vẫn còn khi `published_at` bị xoá sau khi đánh giá (status chỉ dựa vào `hot_expires_at`); UI hiển thị "Chưa rõ giờ đăng".

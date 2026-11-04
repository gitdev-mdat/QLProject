# Dọn UX khách hàng, Đề xuất nhóm Facebook, đơn giản hoá bộ lọc lead

Ngày: 2026-11-02.

## Thay đổi UX và route

- Thanh điều hướng của khách giờ gồm 4 mục: Hôm nay, Danh sách lead, Nhu cầu theo dõi, **Đề xuất nhóm** (`/app/de-xuat-nhom`, icon nhóm người). Thanh điều hướng dưới trên mobile ghi "Đề xuất".
- `/app/ket-noi` chuyển hướng vĩnh viễn (308) sang `/app/de-xuat-nhom`. Component `ConnectionPage` đã bị xoá. Hạ tầng agent/worker, credential và dữ liệu cũ vẫn giữ nguyên.
- Những chỗ từng lộ chi tiết Muse ra khách và đã được viết lại:
  - Hôm nay:
    - Khung "Trạng thái hệ thống" (Agent Muse x/y) đổi thành "Trạng thái theo dõi", tính từ lịch sử quét: Đang hoạt động / Đang chậm hơn lịch / Chưa có lượt quét / Chưa bật nhu cầu theo dõi.
    - Lịch sử quét không còn nhắc "agent".
    - Trạng thái trống không còn câu "agent Muse của bạn…".
  - Onboarding bước 2: bỏ "Bạn cần mở Muse, đăng nhập Facebook…". Thay bằng "QLead tự tìm bài cho bạn" và gợi ý đề xuất nhóm.
  - Thông báo ở Nhu cầu theo dõi: bỏ câu "…gửi cấu hình này đến Muse".
  - Nhãn nguồn bài: trước đây hiện nguyên giá trị nội bộ của `collected_via` (ví dụ `qlead_shared_worker`). Giờ chỉ hiện các loại nguồn Facebook đã biết; dữ liệu mẫu cũng không còn "Muse".
- Khu Admin có thêm thanh điều hướng: Tài khoản Muse | Đề xuất nhóm.

## Database

`migrations/008_group_requests.sql` chỉ thêm bảng mới. DB thật được backup bằng `pg_dump` trước khi áp dụng. Bảng `facebook_group_requests` gồm:
- `user_id` (chủ sở hữu)
- `group_key` (khóa đã chuẩn hoá), `group_url` (dạng chuẩn `https://www.facebook.com/groups/<key>`), `submitted_url` (đúng như khách nhập)
- `note`, `status` (pending/reviewing/approved/rejected/added), `admin_note`, `reviewed_by_user_id`, `reviewed_at`
- `UNIQUE(user_id, group_key)`

## API và logic

- `src/group-url.ts`:
  - Chuẩn hoá URL thuần bằng xử lý chuỗi, **không bao giờ fetch** URL.
  - Chấp nhận http/https với host facebook.com, www., m., web., mbasic., touch. và đường dẫn `/groups/<id-hoặc-tên>`. Bỏ phần đường dẫn phía sau, query và hash; viết thường tên nhóm.
  - Từ chối: rỗng, có khoảng trắng, `javascript:`/`ftp:`, có userinfo hoặc port, host khác, trang không phải nhóm, các đường dẫn hệ thống như `/groups/feed`, ký tự lạ, quá 2048 ký tự.
- `src/group-requests.ts`:
  - Tạo yêu cầu theo user đã đăng nhập. Gửi trùng (kể cả biến thể tương đương) trả 409 kèm yêu cầu cũ.
  - Ghi chú được lọc ký tự điều khiển, tối đa 1000 ký tự, và hiển thị dạng text nên React tự escape.
  - Admin đổi trạng thái theo bảng chuyển hợp lệ:
    - pending → reviewing / approved / rejected
    - reviewing → pending / approved / rejected
    - approved → reviewing / added / rejected
    - rejected → reviewing
    - added → approved

    **APPROVED không tự trở thành ADDED**: chỉ được chọn ADDED sau khi đã APPROVED.
- Web:
  - `GET/POST /api/group-requests`: cần session; POST cần Origin cùng nguồn; chỉ trả yêu cầu của chính user.
  - `POST /api/admin/group-requests/[id]`: qua `adminApiGuard`, nên cần session admin, Origin cùng nguồn và header `x-qlead-admin`.

## Quy trình Admin `/admin/group-requests`

- Mỗi yêu cầu hiển thị: người đề xuất, URL, ghi chú của khách, thời gian gửi, số khách đã đề xuất cùng nhóm, người và thời điểm duyệt gần nhất, URL gốc. Có tab lọc theo trạng thái.
- Admin chọn trạng thái và ghi chú gửi khách. Ở trạng thái "Không thể hỗ trợ", form gợi ý ghi lý do.
- Không có thao tác nào tự tham gia nhóm, crawl nhóm hay đổi connector/worker.
- Nhãn hiển thị cho khách:
  - Chờ xem xét
  - Đang xem xét
  - Đã chấp thuận
  - Không thể hỗ trợ
  - Đã bổ sung vào nguồn tìm kiếm

  Phản hồi của Admin hiển thị dưới mục "Phản hồi từ QLead".

## Bộ lọc danh sách lead

- Bỏ dropdown khu vực ("Mọi khu vực") và dropdown sắp xếp ("Mới đăng" / "Mới phát hiện").
- Khu vực vẫn hiện trong bảng và trong chi tiết lead khi bài có nêu; không suy đoán khu vực khi bài không ghi.
- Thứ tự cố định: QLead phát hiện mới nhất trước (`first_seen_at`), cùng thời điểm thì xếp theo id, giống truy vấn ở server. Thời gian đăng trên Facebook vẫn hiển thị khi có và không bao giờ được tự điền.
- `new` nghĩa là chưa mở lead (lead chuyển sang `seen` khi mở), nên nhãn đổi thành **"Chưa xem"**. Giá trị lưu trong DB không đổi, không cần migration.
- Bộ lọc thời gian đăng (24 giờ / 7 ngày), tìm kiếm, các tab trạng thái, "Có số liên hệ" và "Có ghi chú" giữ nguyên.

## Kết quả kiểm tra

- Backend trên DB test riêng (`muse_bridge_test`): `npm test` cho **64/64 pass**, gồm 8 test mới cho đề xuất nhóm.
- E2E trên DB test:
  - `web/e2e/customer-groups-e2e.mts`: **18/18** (15 kịch bản yêu cầu, có kiểm XSS, chặn khách dùng API admin, không đổi worker/job, layout 390/768/1440, không có lỗi console).
  - `web/e2e/admin-workers-e2e.mts`: **25/25**.
- E2E cũ trên dữ liệu thật: `web/e2e/qlead-e2e.mjs` cho **31/31** (đã sửa theo route mới và thứ tự mặc định).
- `npm run build` (web) pass. `tsc` (backend) pass.
- Ảnh chụp: `docs/group-request-screenshots/` gồm group-requests, leads và admin-group-requests ở 390/768/1440.

## Việc còn lại

- Lần chạy đầu của E2E admin-workers từng có một log console 404 không ổn định, đến từ trang 404 cố ý của bước kiểm tra phân quyền; lần chạy lại pass 25/25.
- Bài không có thời gian đăng vẫn bị ẩn khỏi danh sách như trước, theo bộ lọc "lead hoàn chỉnh" có từ trước.
- Admin vẫn cần làm các bước cấp quyền admin trên DB thật ở ADMIN_WORKERS.md §15 thì mới mở được `/admin/group-requests`.
- Port 3000 đang chạy bản build cũ; khởi động lại web để thấy thay đổi.

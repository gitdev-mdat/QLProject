# Góp ý khách hàng một lần và báo cáo Admin

Nhánh `feat/customer-feedback` · migration `019_customer_feedback.sql` (chỉ thêm bảng) · chưa chạy trên Production.

## 1. Cách trình bày (UI/UX)

- **Lời mời không chặn màn hình**: một thẻ nhỏ có chú dê QLead, góc phải dưới trên desktop, ngay trên thanh điều hướng dưới trên điện thoại. Thẻ này không phải modal nên không khoá trang, không lấy focus, và khách vẫn làm việc bình thường.
- Nội dung lời mời: "Bạn thấy QLead thế nào?", hai nút "Góp ý" và "Không, cảm ơn", nút X rõ ràng, kèm dòng "QLead chỉ hỏi một lần." để khách biết trước.
- Bấm "Góp ý" thì thẻ mở ra biểu mẫu 3 câu ngay tại chỗ:
  1. "Giao diện QLead có dễ hiểu, dễ sử dụng không?" (1–5 sao)
  2. "QLead có đáp ứng nhu cầu tìm khách hàng của bạn không?" (1–5 sao). Ô "Điểm nào QLead chưa đáp ứng tốt?" tự mở khi khách chấm 1–3 sao. Với điểm cao hơn, ô này vẫn mở được bằng một chạm.
  3. "Bạn muốn QLead cải tiến hoặc bổ sung điều gì?" (không bắt buộc)
- Không câu nào bắt buộc: chấm một câu, hoặc chỉ viết một dòng, cũng gửi được. Mỗi mức sao có chữ đi kèm (Rất khó dùng … Rất dễ dùng) nên khách không phải đoán. Ngôi sao rộng 46–48px, dễ bấm trên điện thoại, và đổi được bằng phím mũi tên.
- **"Góp ý cho QLead"** để khách tự gửi lúc nào cũng được: nằm ở thanh bên desktop (dưới "Thông báo") và trong trang Thông báo trên điện thoại. Mục này không bao giờ tự mở.

## 2. Điều kiện nhận lời mời (server quyết định)

Tất cả điều kiện phải đúng cùng lúc:

- Đã bấm "Xem bài Facebook" của **ít nhất 3 lead khác nhau** thuộc chính tài khoản. Hệ thống đếm theo URL bài Facebook, nên bấm lại cùng một bài, hoặc mở cùng bài do 2 nhu cầu tìm thấy, chỉ tính 1. Việc này cũng đồng nghĩa tài khoản đã có lead hợp lệ.
- **Ít nhất 24 giờ** kể từ lần mở bài Facebook đầu tiên.
- Theo dõi lead không bị Admin tạm dừng.
- Chưa từng được mời, chưa từng gửi góp ý.

Thời điểm hiện lời mời (phía trình duyệt): lời mời chỉ được cân nhắc ở **lượt mở QLead tiếp theo**, sau khi trang đã ổn định 8 giây. Nó chỉ hiện trên các trang yên tĩnh (Hôm nay, Danh sách lead, Lịch sử quét) và chỉ khi khách không gõ hay bấm gì trong 3 giây gần nhất. Lời mời không hiện khi đang có modal hoặc ngăn chi tiết lead, khi gợi ý cài app đang hiện, hoặc khi màn tìm kiếm đầu tiên (First Scan) đang chạy. Nó cũng không hiện ở Onboarding (`/bat-dau`), ở trang Thông báo nơi bật quyền thông báo PWA, hay ở các trang sửa nhu cầu và kết nối Muse. Nếu khách chuyển sang trang bận hoặc mở modal, thẻ tạm ẩn và hiện lại sau, không bị tính là trả lời.

Tôi giữ đúng ngưỡng đề xuất (3 bài, 24 giờ) và chỉ thêm các điều kiện "đúng lúc" ở trên, không nới yêu cầu nào.

**Ghi nhận mở bài Facebook**: trước đây chưa có dữ liệu đáng tin, vì trạng thái "Đã xem" đổi cả khi mở trang chi tiết. Nay mỗi lần bấm "Xem bài Facebook" (chuột trái, chuột giữa hoặc Enter) gửi một yêu cầu nền `fetch keepalive` sau khi trình duyệt đã bắt đầu mở Facebook. Yêu cầu này không chặn và không trì hoãn link: E2E đo Facebook mở sau khoảng 90 ms. Hệ thống chỉ lưu sự kiện "đã bấm mở nguồn", không theo dõi gì bên ngoài QLead, không xin quyền gì, và không đổi trạng thái lead.

## 3. Không bao giờ hỏi lại

- Bấm X, bấm "Không, cảm ơn" hay nhấn Escape đều ghi `declined`. Gửi thành công ghi `submitted`. Cả hai là **trạng thái cuối trong PostgreSQL theo user id**: không bao giờ bị đặt lại khi tải lại trang, đăng xuất rồi đăng nhập, đổi trình duyệt hay thiết bị, có thêm lead, hay sau 7 hoặc 30 ngày.
- Khách tự gửi góp ý trước khi được mời cũng làm lời mời tự động không bao giờ xuất hiện nữa.
- Không có toast nhắc, không có push, không có lần mời thứ hai.
- **Nhiều tab, nhiều thiết bị**: tab đầu tiên giành được lời mời bằng một câu `INSERT … ON CONFLICT DO NOTHING`, nên chỉ một tab của một thiết bị nhận `show: true`. Tab đó được hiện lại lời mời nếu khách tải lại trang trong 30 phút, nhờ mã giữ chỗ được đổi mới mỗi lần nên bản sao tab không dùng lại được. Sau 30 phút, lời mời đã hiện mà khách không trả lời sẽ không hiện lại.
- localStorage chỉ là gợi ý để bớt một yêu cầu mạng. Mọi quyết định do server đưa ra.

## 4. Hiệu ứng

- Khi lời mời xuất hiện: thẻ trượt lên 0,32 giây và chú dê gật đầu một lần (CSS, không dùng thư viện mới).
- Sau khi server lưu thành công: chú dê QLead (Lottie đang có sẵn) hiện lên với 5 trái tim nhỏ bay lên một lần (1,5 giây), kèm dòng "Cảm ơn bạn đã góp ý!" và "Mỗi chia sẻ đều giúp QLead ngày càng hữu ích hơn.". Thẻ tự đóng sau 6 giây; nếu khách rê chuột lên thì thẻ giữ nguyên, và luôn có nút "Đóng".
- Khi trình duyệt đặt `prefers-reduced-motion`: không có chuyển động, không có trái tim, chú dê đứng yên (E2E đã kiểm tra).
- Lúc gửi: nút hiện vòng xoay nhỏ "Đang gửi…" và bị khoá nên không gửi trùng. Nếu lỗi mạng: hiện "Chưa gửi được. Câu trả lời của bạn vẫn còn đây", câu trả lời được giữ nguyên, và nút đổi thành "Thử gửi lại".

## 5. PostgreSQL và API

Migration `019_customer_feedback.sql` chỉ thêm bảng, không sửa bảng cũ, và chạy lại nhiều lần vẫn an toàn:

| Bảng | Nội dung |
|---|---|
| `lead_source_opens` | PK `(user_id, normalized_url)`, `post_id`, `first_opened_at`. Xoá theo khi xoá tài khoản hoặc bài. |
| `customer_feedback_invitations` | Mỗi tài khoản tối đa 1 dòng: `shown` / `submitted` / `declined`, `shown_at`, `responded_at`, `claim_token`. "Chưa đủ điều kiện" và "đủ điều kiện, chưa mời" được tính ra, không lưu. |
| `customer_feedback` | `user_id`, `submission_id` (UNIQUE, chống bấm hai lần hoặc gửi lại), `source` (`invitation`/`voluntary`), `ease_rating`, `needs_rating` (1–5 hoặc NULL, không bao giờ tự điền), `unmet_reason` (≤1000), `improvement` (≤2000), `created_at`. Mỗi tài khoản chỉ có tối đa 1 dòng `invitation`. |

Cả 3 bảng đều bật RLS và REVOKE quyền của anon/authenticated/service_role, giống các bảng tài khoản khác.

API mới (tất cả cần session, kiểm tra Origin cùng nguồn, schema zod `.strict()`, không nhận user id từ trình duyệt):

- `POST /api/leads/[id]/source-open`: 204, hoặc 404 nếu lead không thuộc tài khoản.
- `POST /api/feedback/invitation` `{action:"claim"|"decline"}`: server tự kiểm tra điều kiện và trạng thái tạm dừng.
- `POST /api/feedback`: kiểm tra số sao, độ dài chữ, bỏ ký tự điều khiển và ký tự đảo chiều (bidi). Gửi lại cùng `submissionId` không tạo dòng mới; `submissionId` của người khác trả 409. Tự gửi tối đa 5 lần mỗi ngày. Log không bao giờ chứa nội dung góp ý.

Không đổi: Muse Worker, hooks, claim/result, thuật toán tìm lead, chống trùng, lead và ghi chú đã lưu, tạm dừng tài khoản, PWA/Web Push, đăng nhập, cơ chế phân quyền Admin. Layout `/app` không có thêm truy vấn nào: lời mời chỉ được hỏi một lần sau 8 giây, ngoài luồng điều hướng.

## 6. Báo cáo Admin

Trang `/admin/feedback` có mục **"Phản hồi khách hàng"** trên thanh điều hướng Admin và dùng cùng allowlist `QLEAD_ADMIN_USER_IDS`. Khách thường vào trang này nhận 404.

- Tổng quan: số lượt góp ý, số lượt có chấm sao, điểm trung bình "dễ sử dụng" và "đáp ứng nhu cầu", số góp ý có nội dung viết, số điểm thấp (1–2 sao).
- Phân bố 1–5 sao cho từng câu.
- Lời mời tự động: số đã góp ý / **số đã đóng (không tính là đánh giá)** / số đã hiện nhưng chưa trả lời. Bấm X không bao giờ bị tính là 0 sao.
- Danh sách mới nhất trước: tên, email, link "Xem khách hàng", thời gian, nguồn (từ lời mời hoặc tự gửi), hai điểm, lý do chưa đáp ứng, đề xuất cải tiến. Có bộ lọc "Điểm thấp" và phân trang 30 dòng. Nội dung khách viết luôn hiển thị dạng chữ thuần, giữ nguyên xuống dòng.
- Thanh điều hướng Admin xếp lại để 4 mục vừa màn tablet (768px) và điện thoại (lưới 2×2).

## 7. Ảnh chụp

Trong `docs/customer-feedback/screenshots/`: `invite-1440`, `form-1440`, `form-network-error-1440`, `thanks-1440`, `form-768`, `invite-390`, `voluntary-390`, `admin-feedback-1440/768/390`.

## 8. Kiểm thử

- `npm test` (backend, PostgreSQL 16 cô lập): **137 đạt, 0 lỗi** (4 bỏ qua có sẵn từ trước). Trong đó `test/customer-feedback.test.ts` dùng đồng hồ giả lập cho các mốc thời gian. Test này kiểm tra: điều kiện mời, 6 tab cùng giành lời mời (chỉ 1 tab thắng), bấm hai lần hoặc gửi lại (chỉ 1 dòng), từ chối là trạng thái cuối, sau 8/31/400 ngày vẫn không mời lại, tách biệt giữa các tài khoản, giới hạn tự gửi, ràng buộc ở tầng DB, và số liệu Admin khớp với SQL độc lập.
- `web/e2e/customer-feedback-e2e.mts` chạy trên Chromium thật với bản production build (`next start`) và DB `muse_bridge_test_feedback`: **16/16 đạt**, phủ đủ 22 ca bắt buộc (kết quả trong `customer-feedback-e2e-results.txt`). Chuyển trang trong `/app` mất 230–390 ms và không phát sinh yêu cầu góp ý nào.
- `tsc --noEmit` (backend và web) đều sạch. `next build` thành công.

## 9–11. PR, migration, mức sẵn sàng cho Production

- Migration **chưa chạy trên Production**. Khi được duyệt, chạy từ máy owner: `npx tsx ops/production-db.ts check`, rồi `migrate` (tự chạy cả `harden`), rồi `verify`. Migration chỉ thêm bảng nên chạy trước hay sau khi deploy code đều an toàn.
- Lưu ý thứ tự: nếu deploy code trước khi chạy migration, các API góp ý trả 503. Khách không thấy lỗi vì lời mời không hiện, và nút "Xem bài Facebook" vẫn mở bình thường. Tuy vậy, nên chạy migration trước.
- Không tạo góp ý giả, không sửa dữ liệu khách hàng nào trên Production.
- Cần owner làm: review và merge PR, sau đó chạy migration 019 trên Production.

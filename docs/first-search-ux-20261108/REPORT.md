# Lượt tìm đầu tiên + danh sách lead: audit và tối ưu UX (2026-11-08)

Nhánh `claude/first-search-ux`, dựa trên `codex/lead-delivery-latency` (401ac56, PR #15 của Codex). Chỉ sửa frontend; không đụng worker, phân phối lead, migration hay DB production. Không merge, không deploy.

Kiểm thử bằng **dữ liệu test có kiểm soát** trên DB riêng `muse_bridge_test_firstux` (migration 001–021, worker giả gọi API worker thật qua `app.inject`). **Không phải kiểm chứng end-to-end với Muse thật.**

## 1. Vấn đề UX hiện tại

Màn hình `/app/lan-tim-dau`:

1. **ETA cố định "Thường mất khoảng 2–3 phút sau khi bắt đầu"** hiện cả khi lượt tìm *chưa* bắt đầu. Người dùng dễ hiểu là "2–3 phút kể từ lúc đăng ký". Theo audit của Codex, backend chỉ có **một** lần chạy đo được (~55 giây) và không có P95, nên con số này không có cơ sở. Ngoài ra Muse nhận việc qua Hook polling (production từng ghi nhận khoảng 30 phút), nên thời gian *chờ bắt đầu* không thể đoán.
2. Không cho biết **đã chờ bao lâu**. Người dùng chỉ thấy "Đang chờ bắt đầu", không có mốc thời gian thật.
3. **Thanh "loading" chạy cả khi chỉ đang chờ**: trông như đang tìm dù hệ thống chưa nhận việc (spinner vô tận).
4. **Số lead ở màn hình thành công là số bài tìm được, không phải số lead đã giao.** Với giới hạn 10 lead/chu kỳ của Codex, bản cũ ghi "14 cơ hội mới" trong khi danh sách chỉ có 10 (ảnh `before/c1-found-1440.png`). Đây chính là trường hợp brief cấm: "không tuyên bố số lead hệ thống không giao".
5. Lần thử lại (retry) bị hiện như lần chờ đầu, không nói rõ là "đang thử lại".
6. `searchReady` giờ có thể là `null` (Codex đổi contract). Bản cũ chỉ báo "chưa thể bắt đầu" khi `false`, nên vẫn tương thích. Mình giữ quy tắc này: `null` (không quan sát được) không bao giờ bị hiện như lỗi.

Danh sách lead `/app/bai-viet` và trang Hôm nay `/app`:

7. 37 lead "Chưa xem" dồn chung một bảng, không biết bắt đầu từ đâu. Không phân biệt được lượt gửi mới nhất với lead cũ.
8. Lead thiếu nội dung hiện câu "Mở bài Facebook gốc để xem nội dung." **kèm thêm** chip "Chưa trích xuất nội dung": nói hai lần một ý, lại đọc như lời trích từ bài.
9. Cột "Số liên hệ" ngầm hiểu là số đã xác minh, trong khi số này chỉ được trích từ nội dung bài.

## 2. Thay đổi đã chọn và lý do

### Lượt tìm đầu tiên (`components/first-scan.tsx`)

| Trạng thái | Tiêu đề mới | Thời gian hiển thị (từ dữ liệu thật) |
|---|---|---|
| Vừa lưu / chờ dưới 2 phút | QLead đang chuẩn bị lượt tìm kiếm của bạn | Đã lưu lúc 13:00 · đã chờ dưới 1 phút |
| Chờ 2–10 phút | Lượt tìm đầu tiên chưa bắt đầu | Đã chờ 4 phút (từ 13:00) |
| Chờ trên 10 phút / server báo trễ | Lượt tìm đang chờ lâu hơn bình thường + "không phải lỗi của bạn, không cần tạo lại nhu cầu" | Đã chờ 15 phút (từ 13:00) |
| Thử lại (`initialStatus = retrying`) | QLead đang thử lại lượt tìm | Đã lưu lúc … |
| Chưa có hệ thống tìm (`searchReady = false`) | Lượt tìm đầu tiên chưa thể bắt đầu (giữ nguyên) | Chưa thể biết khi nào bắt đầu |
| Đang tìm (có lease thật) | QLead đang tìm khách hàng phù hợp | Bắt đầu lúc 13:02 · đang tìm 1 phút |
| Đang tìm trên 5 phút | Như trên + "lâu hơn thường lệ" | … · đã tìm 7 phút |
| Có kết quả | QLead đã tìm thấy khách hàng cho bạn! + **số lead đã giao thật** | Hoàn tất lúc … |
| Tìm thấy nhưng chưa được giao (lỗi chu kỳ, §4) | QLead đã tìm thấy bài đăng phù hợp + "Khách hàng sẽ được gửi vào danh sách lead từ lúc 13:30" | Trang tự đọc lại ngay sau mốc đó |

- **Bỏ hoàn toàn ETA "2–3 phút"**, thay bằng thời gian đã trôi qua tính từ mốc lưu trong DB. Các ngưỡng 2/10/5 phút chỉ dùng để đổi câu chữ, không tạo tiến trình giả, không có %.
- Thanh chạy chỉ xuất hiện khi job **thật sự** đang chạy (có lease). Lúc chờ, chỉ có dê đứng yên và dòng thời gian.
- Mọi trạng thái chờ đều có câu "Bạn có thể rời trang: tiến trình được lưu và kết quả sẽ tự vào danh sách lead". Trang vẫn poll 5 giây/lần nên không cần tải lại thủ công.
- **Số ở màn hình thành công lấy từ `GET /api/leads?profile_id=…&limit=1`** (`total`), tức số lead thật sự nằm trong danh sách. Theo contract, chính lần đọc này giao lô lead nên số hiện ra khớp đúng với danh sách. Trong lúc tải, ô số giữ chỗ để layout không nhảy. Confetti chỉ chạy khi đã biết số giao lớn hơn 0.
- Nếu backend báo `queued > 0`: thêm một dòng "QLead giữ thêm 4 cơ hội khác và sẽ gửi tiếp từ lúc 13:30, tối đa 10 khách mỗi lượt." Mốc giờ lấy từ `nextCycleAt` thật.
- CTA đổi thành **"Xem khách hàng"** → `/app/bai-viet?nhu-cau=<id>&luot=moi` (mở danh sách ở lượt gửi mới nhất).
- Không còn hiện partial results. Contract của Codex xác nhận Muse chỉ gửi kết quả một lần khi xong, nên UI nói thẳng "Kết quả sẽ hiện ngay khi lượt tìm xong".

### Danh sách lead (`components/lead-results.tsx`, `app/app/bai-viet/page.tsx`) và Hôm nay (`components/dashboard.tsx`)

- **Dải "N khách hàng mới trong lượt gửi gần nhất"** đặt trên bảng: giờ gửi, số còn chưa xem, thanh "Đã xem k/N" (thẻ `meter`), dòng lead đang được giữ lại, và hai nút: **"Bắt đầu xem" / "Xem khách tiếp theo"** và **"Chỉ hiện lượt này" ⇄ "Hiện tất cả lead"**. Mặc định danh sách vẫn hiện toàn bộ lịch sử; chỉ khi vào từ CTA (`?luot=moi`) mới lọc sẵn lượt mới, và luôn bỏ lọc được bằng một nút.
- Lượt gửi được xác định bằng `deliveredAt` của Codex: một giao dịch giao lô ghi cùng một `delivered_at` (`lib/lead-delivery.ts`). Khi xem hết lượt, dải chuyển sang trạng thái "Bạn đã xem hết N khách hàng của lượt gửi gần nhất".
- Các dòng thuộc lượt mới có thẻ chữ **"Lượt mới"** và vạch xanh bên trái (không chỉ dựa vào màu). Thẻ tự ẩn khi đã xem hết lượt.
- Ngăn chi tiết trên desktop có thanh dưới cùng "Lượt gửi gần nhất · đã xem 2/10" và nút **"Khách tiếp theo"** để xử lý lần lượt.
- Trang Hôm nay có bản rút gọn của dải này, kèm link "Bắt đầu xem" sang danh sách.
- Thiếu nội dung: còn **một** dòng nghiêng màu nhạt "Chưa trích xuất được nội dung bài này." (hoặc "Chưa có tóm tắt tiếng Việt cho bài này."), bỏ chip lặp lại. Nút "Xem bài Facebook" vẫn ở ngay dòng đó.
- SĐT: cột và mục chi tiết đổi thành **"SĐT trong bài"**, chi tiết có thêm ghi chú "Lấy từ nội dung bài, chưa xác minh chủ số." Thiếu số chỉ hiện "—" (danh sách) hoặc "Bài không ghi số" / "Xem trong bài gốc" (chi tiết), không coi là lead lỗi.
- CSS riêng ở `components/first-search-ux.css`, không sửa `globals.css` và không đổi branding.

## 3. Trước / sau (ảnh trong `first-search-ux/screenshots/`)

| | Trước (`before/`) | Sau (`after/`) |
|---|---|---|
| Vừa lưu | `a1-waiting-fresh-*`: "2–3 phút", thanh chạy | `a1-waiting-fresh-*`: "Đã lưu lúc 13:00 · đã chờ dưới 1 phút", không có thanh chạy |
| Chờ lâu | `a3-waiting-slow-*` | `a3-waiting-slow-*`, `a2-waiting-4min-1440` |
| Đang tìm | `b1-running-*` | `b1-running-*`, `b2-running-long-1440` |
| Có kết quả | `c1-found-*`: **"14 cơ hội mới"** dù chỉ giao 10 | `c1-found-live-1440`, `c1-found-viewport-*`, `c2-found-return-*`: **10** + "giữ thêm 4" |
| Chưa được giao | — | `d1-found-not-yet-given-1440` |
| Thử lại / lỗi / không có lead | `e1…e3` | `e1-retrying`, `e2-failed`, `e3-empty` |
| Danh sách 37 cũ + 10 mới | `f1-list-37-plus-10-*`: 27 chưa xem dồn chung | `f1-list-37-plus-10-*`, `f1-list-viewport-*`, `c3-list-latest-1440`, `c3b-drawer-first-1440`, `c3c-list-progress-1440` |
| Hôm nay | `f2-today-*` | `f2-today-latest-*` |
| Thiếu nội dung | — | `f3-missing-content-drawer-1440` |

## 4. Kết quả tích hợp backend

- Dùng đúng contract của Codex: `GET /api/leads` (`total`, `delivery.queued`, `nextCycleAt`, `maxLeadsPerCycle`), `Lead.deliveredAt`, `searchReady: boolean | null`, `discovery.initialStatus`. Không tự suy diễn dữ liệu.
- **Lỗi backend đã tái hiện (gửi Codex, mục A bên dưới):** nếu người dùng mở trang Hôm nay hoặc Danh sách lead trong lúc lượt đầu còn chờ, `distributeProfileLeads` tạo chu kỳ hiện tại với 0 lead. Khi lượt đầu xong *trong cùng chu kỳ*, mọi lần đọc sau đều trả về sớm (`created.rowCount = 0`), không đưa bài vào hàng đợi và không giao. Kết quả lượt đầu vì vậy bị giữ tới mốc chu kỳ sau (tối đa 30 phút, lâu hơn nếu tần suất dài hơn). Tái hiện bằng `web/e2e/first-search-cycle-probe.mts` (`RESULT: BLOCKED`) và bước D1 của E2E (0 lead được giao). Frontend đã xử lý trung thực trường hợp này ("sẽ được gửi từ lúc 13:30" và tự đọc lại sau mốc đó), nhưng trải nghiệm đúng phải là giao ngay.

### Yêu cầu bổ sung cho Codex

A. **(Chặn trải nghiệm lượt đầu)** Trong một chu kỳ, cho phép giao thêm tới `max_leads − delivered_in_cycle` khi có bài mới, thay vì trả về sớm khi chu kỳ đã tồn tại. Ít nhất phải làm vậy với chu kỳ đang có 0 lead, hoặc với kết quả của job `initial`. Cũng cần đưa bài mới vào hàng `queued` ở mọi lần đọc, không chỉ ở lần đầu của chu kỳ.
B. Thêm `deliveryCycleId` (hoặc `deliveryBatchId`) vào mỗi lead trong `GET /api/leads`. Hiện frontend nhóm "lượt gửi gần nhất" theo `deliveredAt` bằng nhau tuyệt đối. Cách này đúng với code hiện tại (cùng một `now()` trong giao dịch), nhưng là hợp đồng ngầm.
C. Trả `deliveredLeads` (số lead đã giao cho customer) trong `GET /api/first-scan.discovery`, để màn hình thành công không phải gọi thêm `/api/leads`. Các số `initialUsablePosts` và `totalSourceLinkedPosts` hiện tại là số bài tìm được, **không** phải số lead đã giao.
D. `delivery.maxLeadsPerCycle` ở scope `all` là *tổng* của các nhu cầu. Nên trả thêm giá trị theo từng nhu cầu, hoặc ghi rõ trong contract.
E. (Đã báo từ trước, vẫn còn) Trong probe, `source_linked_new_posts` được log là 0 dù 12 bài đều source-linked (`countSourceLinkedPostsForRun` truyền Date nên mất micro giây). Số trong discovery có thể lệch.

### Xung đột số migration

Nhánh của Codex có `migrations/021_lead_distribution.sql`. Nhánh `feature/landing-real-leads` (`C:\WorkspaceLead\qlead-landing-real-leads`, chưa push) có `migrations/021_landing_preview.sql`. **Hai file trùng số 021**: nhánh nào merge sau cần đổi thành 022, và phải đổi trước khi chạy migration trên Supabase. Nhánh này không thêm migration nào.

## 5. Browser QA

`web/e2e/first-search-ux-e2e.mts` chạy trên DB test riêng, dev server cổng 3061, Chrome headless, `reducedMotion: reduce`: **16/16 đạt**, 0 lỗi console. Mỗi trang đều được kiểm tra không có từ nội bộ (job/worker/queue/lease/Muse/cycle), không có %, không có "2–3 phút", và không tràn ngang.

- A1–A3: lưu nhu cầu → chờ → chờ lâu (giả lập bằng cách lùi `created_at` của job).
- B1–B2: worker nhận việc → đang tìm → tìm lâu.
- C1: **trang đang mở khi kết quả về: tự chuyển sang thành công, không cần tải lại**, hiện 10 (đã giao), giữ lại 4.
- C2: rời trang rồi quay lại vẫn là 10, DB có đúng 10 dòng `delivered` (không giao lô thứ hai).
- C3–C4: CTA → danh sách ở lượt mới → "Bắt đầu xem" → "Khách tiếp theo" → thanh tiến độ 2/10 → "Hiện tất cả lead".
- D1: lỗi chu kỳ ở §4 được hiển thị trung thực.
- E1–E3: thử lại, lỗi hẳn, không tìm thấy lead.
- F1–F3: 37 lead cũ (20 đã xử lý) + 10 mới: tổng 47 vẫn hiện đủ, có dải lượt mới, bản rút gọn trên Hôm nay, lead thiếu nội dung, nhãn SĐT.

Nếu bước C3 chạy đúng lúc qua mốc chu kỳ (ví dụ 13:00), 4 lead đang giữ sẽ được giao thành lô mới. Đó là hành vi đúng của backend; chạy lại trong cùng chu kỳ thì đạt.

## 6. Responsive QA

Đã chụp ở 390 / 768 / 1440 cho trạng thái chờ, chờ lâu, đang tìm, thành công, danh sách và Hôm nay. Không có trang nào tràn ngang. Ở 390px, dải lượt mới xếp hai nút thành hàng riêng, mỗi nút cao tối thiểu 44px. Stepper 4 bước vẫn đọc được, nhưng nhãn "Đã lưu nhu cầu" / "Chờ bắt đầu" xuống hai dòng như bản cũ. Trạng thái luôn có chữ (chip trạng thái, "Lượt mới", "đã xem k/N"), không chỉ dựa vào màu. Hiệu ứng confetti và nhịp tải đều tắt khi bật `prefers-reduced-motion`.

## 7. Hạn chế chưa xử lý

- Chưa chạy với Muse thật hay dữ liệu production. Tất cả là mô phỏng có kiểm soát.
- Trên mobile, "Khách tiếp theo" chỉ có ở danh sách (dải + nút). Trang chi tiết `/app/bai-viet/[id]` chưa có nút sang khách kế tiếp.
- Lượt gửi chỉ được tính trong tối đa 200 lead mới nhất mà trang tải (giới hạn sẵn có). Cần phân trang ở server (đã yêu cầu Codex từ trước).
- Ngưỡng 2/10/5 phút là lựa chọn UX, không phải số đo. Nên điều chỉnh khi có P95 thật.
- Các E2E cũ kiểm tra câu chữ cũ ("cơ hội mới", "Xem cơ hội ngay", "2–3 phút") sẽ cần cập nhật: `first-scan-e2e.mts`, `first-discovery-e2e.mts`, `goat-source-e2e.mts`. Chưa chạy lại.
- Lỗi chu kỳ (§4-A) phải chờ Codex sửa backend.

## 8. Git

- Worktree: `C:\WorkspaceLead\qlead-first-search-ux`, nhánh `claude/first-search-ux` dựa trên `401ac56`.
- Worktree tham chiếu (chỉ để chụp ảnh "trước"): `C:\WorkspaceLead\qlead-first-search-ux-before` (detached tại 401ac56), có thể xóa bằng `git worktree remove`.
- DB test: `muse_bridge_test_firstux`.
- Commit và PR: xem tin nhắn trong thread.

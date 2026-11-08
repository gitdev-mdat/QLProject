# QLead: tìm lead thật ngay trên Landing Page

Ngày 08/11/2026 · Nhánh `feature/landing-real-leads` (tạo từ `origin/main` cffa3c1) · **Chưa merge, chưa deploy**

Tóm tắt: section "Thử tìm khách hàng của bạn" giữ nguyên bố cục hai cột. Khi khách bấm **Tìm khách hàng**, QLead trả về tối đa 2 bài đăng Facebook thật đã lưu trong hệ thống. Thông tin liên hệ và link bị ẩn ngay từ server. Khách đăng ký miễn phí bằng form hiện có để xem đầy đủ: không phải nhập lại nhu cầu, lead được mở khóa ngay ở bước onboarding, và lượt tìm Muse đầu tiên tự chạy với đúng mô tả đó. Trên bản build production ở máy local, từ lúc bấm đến khi lead hiện ra mất **20–45 ms**.

---

## A. Audit hiện trạng

### Landing (trước khi sửa)
| Câu hỏi | Kết quả kiểm tra |
|---|---|
| Section ở đâu | `web/app/page.tsx` → `components/hero-demo.tsx` (client component). Trang `/` được prerender tĩnh. |
| Form xử lý input ra sao | Không gọi backend. `personaForRequest()` dùng regex để xếp mô tả vào 1 trong 4 persona mẫu, sau đó chờ giả **700 ms** rồi hiện bài. |
| 2 lead mẫu lấy từ đâu | `lib/demo-data.ts`: 12 bài viết tay, SĐT dạng `0900 000 xxx`, nhãn "lead mẫu". |
| "Xem bài đầy đủ" / "Lưu" | Chỉ đổi state cục bộ (mở rộng đoạn văn, bật/tắt chữ "Đã lưu"). Không lưu gì. |
| Điều hướng sang đăng ký | Link chân demo dẫn tới `/dang-ky`. Không mang theo gì từ demo. |
| Form đăng ký | `/api/auth/register`: tên, email, mật khẩu (≥8). Không thanh toán. Đăng ký xong redirect `/bat-dau` (onboarding 3 bước, tự gõ lại nhu cầu). |
| Giữ truy vấn sau đăng ký | Không có. Onboarding chỉ khôi phục bản nháp của chính nó (localStorage theo user). |

### Backend & Muse
- **Lưu lead**: `facebook_posts` thuộc `agent_connections` (search profile) của từng user. Mọi truy vấn khách hàng đều lọc theo `ac.user_id`. Chưa có cờ hay khái niệm "dữ liệu công khai".
- **Hàng đợi**: `search_jobs` trong Postgres (`src/jobs.ts`), gồm claim `FOR UPDATE SKIP LOCKED`, lease, retry 5 phút × số lần, và mỗi profile chỉ có một job mở. Các loại job: `scheduled | initial | manual | followup`. Ưu tiên chỉ là **dời mốc thời gian** (initial/manual sớm hơn 30 phút, followup sớm hơn 5 phút). Không có hàng ưu tiên riêng.
- **Muse**: không đánh thức được bằng lệnh. Worker tự poll, hoặc Hook poll `/api/public/worker-dispatch` mỗi 30 giây. Lần chạy thật tốt nhất (WAKE_SIGNAL_POC.md) mất khoảng 12 giây để khởi động agent và khoảng 55 giây để có kết quả. Lượt tìm đầu tiên thường mất 2–3 phút, quá 20 phút thì báo "chậm". Chưa đo được quota/chi phí của Muse. Worker 02 trên production poll khoảng 30 phút một lần.
- **Giới hạn hiện có**: tìm lại thủ công có cooldown 15 phút và tối đa 10 lần/ngày/user. Rate limit đăng nhập/đăng ký nằm trong bộ nhớ, theo từng instance.
- **Analytics**: repo chưa có công cụ analytics nào.

### Phát hiện quan trọng và rủi ro
1. **Gọi Muse cho khách ẩn danh là không khả thi** nếu muốn có kết quả trong vài giây. Nhanh nhất cũng mất khoảng 1 phút, thường 2–3 phút. Mỗi lượt tìm tốn tài nguyên của tài khoản Muse/Facebook mà chưa đo được chi phí, và bot có thể dùng để đốt quota.
2. **Dữ liệu lead của khách hàng không được coi là công khai.** Bài đăng Facebook là nội dung công khai, nhưng việc một khách hàng đang theo dõi phân khúc nào là thông tin riêng của họ. Hiện cũng chưa có điều khoản nào cho phép QLead dùng lại dữ liệu đó.
3. Dữ liệu có sẵn chất lượng không đều. Trên bản sao DB local, **467/664** bài có văn bản tiếng Việt hiển thị được. Phần còn lại là mô tả tiếng Anh do collector viết và không có `summary_vi`.

## B. Phương án được chọn

**Landing chỉ đọc dữ liệu đã lưu, và chỉ từ "bộ tìm trưng bày" (showcase) của QLead. Bước tìm mới qua Muse chạy sau khi khách đăng ký.**

- **Tầng 1 (landing, ẩn danh)**: chỉ tìm trong các search profile thuộc những tài khoản được liệt kê ở biến môi trường server `QLEAD_LANDING_CATALOG_USER_IDS`, tương tự `QLEAD_ADMIN_USER_IDS`. Đây là các nhu cầu mẫu do Admin tự tạo (F&B sắp khai trương, khách sạn, bán lẻ…) và Muse quét như mọi profile khác. Dữ liệu của khách hàng **không bao giờ** được đọc ở đây. Nếu chưa cấu hình, landing trả lời "Chưa có lead phù hợp" và không mượn dữ liệu của ai.
- **Tầng 2 (Muse)**: landing không tạo job Muse. Khi khách bấm đăng ký, mô tả được mang theo vào onboarding. Lưu xong, `enqueueInitialJob` tạo job `initial` (đã được ưu tiên sẵn) với đúng mô tả đó. Như vậy job Muse chỉ phát sinh từ tài khoản thật, tối đa 1 job đầu tiên cho mỗi nhu cầu, có sẵn retry/lease/backpressure, và bot không đốt được Muse. Mình không thêm job `LANDING_PREVIEW_SEARCH`. Lý do: nó không thể trả kết quả trong lúc khách còn ở trang, mà lại mở thêm một đường tốn quota cho traffic ẩn danh. Hàng đợi hiện có cũng không có mức ưu tiên thật (chỉ dời mốc thời gian).
- **Tốc độ**: mỗi instance tải một "pool" ứng viên (tối đa 1.500 bài trong 35 ngày) **mỗi phút một lần**, phân tích sẵn, rồi xếp hạng trong bộ nhớ. Câu hỏi giống nhau trong vòng 5 phút được trả từ cache. Mỗi lượt tìm tốn đúng **một lệnh INSERT** để lưu preview, không chứa nội dung khách gõ. Không dựng thêm hạ tầng: không search index, queue hay microservice mới.
- **Chất lượng** (`web/lib/landing-search.ts`, thuần, có unit test): dùng chung bộ hiểu mô tả `planFromDescription` với sản phẩm, có thêm vài cụm từ phổ biến như "đi vào hoạt động", "mở thêm cơ sở", "khai trương 08/11", "mừng khai trương". Một bài chỉ được chọn khi:
  - khớp **loại khách** (nếu mô tả có nêu); nếu không nêu loại khách thì phải khớp **tín hiệu** (sắp khai trương, tuyển người, mở chi nhánh…);
  - **khớp khu vực** nếu khách có nêu (miền Nam nhận các tỉnh miền Nam; nếu bài không rõ nơi thì loại);
  - đăng trong **30 ngày**, có văn bản **tiếng Việt** (tóm tắt `summary_vi` hoặc nội dung gốc);
  - không trùng với bài đã chọn (so trigram).

  Xếp hạng theo: khớp loại khách → tín hiệu đúng như yêu cầu → khu vực → độ mới. Có 1 bài phù hợp thì hiện 1, không có thì hiện trạng thái trống. Không độn thêm bài.

Lý do chọn: đây là cách duy nhất vừa trả kết quả **dưới 1 giây**, vừa **không lộ dữ liệu khách hàng**, vừa **không tốn Muse** cho người chưa đăng ký. Giá trị Muse vẫn đến với khách ngay sau đăng ký. Đánh đổi: độ phủ của landing phụ thuộc vào số nhu cầu trưng bày mà Admin tạo.

## C. Thay đổi UI/UX (giữ bố cục hai cột, màu, chữ, mascot)
| Thành phần | Trước | Sau | Lý do |
|---|---|---|---|
| Phụ đề section | "Bản demo dùng bài mẫu, không phải lead thật." | "Nhập nhu cầu, xem ngay lead thật QLead đã tìm thấy trên Facebook." | Trung thực, nói rõ giá trị |
| Khi vừa vào section | Hiện sẵn 2 bài mẫu | Tự chạy câu ví dụ khi section lọt vào màn hình → lead thật | Thấy giá trị ngay, không cần thao tác |
| Loading | Luôn chờ giả 700 ms + thanh chạy | Không có thời gian chờ giả. Skeleton chỉ hiện khi chờ quá 180 ms. Chữ "Đang tìm lead phù hợp… / Trong các bài đăng QLead đã thu thập". Không hiện % | Đúng với việc hệ thống đang làm (đọc dữ liệu đã lưu, không quét Facebook) |
| Thẻ lead | Tác giả, nhóm, SĐT (giả) | Chip tín hiệu, "Đăng 4 ngày trước" (giờ đăng thật), trích đoạn ≤180 ký tự (nhãn "QLead tóm tắt" nếu là tóm tắt), nguồn (Bài đăng / Nhóm / Reels Facebook), khu vực, "Có số liên hệ trong bài", dòng **"Phù hợp: Quán cà phê · sắp khai trương · TP.HCM"** | Lý do được chọn giúp khách tin kết quả. SĐT, email, link trong trích đoạn bị thay bằng "SĐT ẩn" ngay trên server |
| "Xem bài đầy đủ" | Mở rộng đoạn văn mẫu | Mở **khung khóa ngay trong thẻ**: "Bài gốc, link Facebook và số liên hệ mở khi bạn có tài khoản QLead. Miễn phí, không cần thanh toán." + nút "Đăng ký miễn phí để xem" | Khách xem trước được một phần rồi mới quyết định. Không có popup, không đổi trang bất ngờ |
| "Lưu" | Toggle giả | Bỏ | Chưa có tài khoản thì không có chỗ để lưu. Bỏ bớt nút cho đỡ rối |
| Chân section | "Bài mẫu để minh họa" + link | Có lead: "Đăng ký miễn phí để xem đầy đủ" + "Đã có tài khoản? Đăng nhập". Trống: "Đăng ký để QLead tìm cho bạn" | CTA gắn với kết quả vừa thấy |
| Trang đăng ký (`?tu=thu-tim`) | – | Cùng form cũ, chỉ đổi phụ đề: "Miễn phí. Xem đầy đủ lead bạn vừa tìm thấy, không cần nhập lại nhu cầu." | Không thêm form trung gian |
| Onboarding | Gõ lại nhu cầu | Đầu trang hiện "2 lead bạn vừa tìm thấy, đầy đủ thông tin" (nội dung, tác giả, SĐT, giờ đăng, **Mở bài Facebook**). Mô tả điền sẵn ở "Ngành khác" | Signup-to-Value ngay lập tức |
| `/app/thu-tim` (mới) | – | Cho tài khoản cũ đăng nhập từ landing: xem lead đầy đủ + nút "Theo dõi nhu cầu này" (tạo profile, chạy lượt tìm đầu tiên) | Trạng thái 9/10 cho người đã có tài khoản |

**10 trạng thái**: (1) chưa nhập: hướng dẫn ngắn; (2) đang tìm dữ liệu có sẵn: skeleton sau 180 ms; (3) chờ Muse: **không xảy ra trên landing** (Muse chạy sau đăng ký, đã có màn hình `/app/lan-tim-dau`); (4) 1–2 lead; (5) không có lead: giải thích trung thực + CTA + gợi ý mô tả rộng hơn; (6) quá 8 giây: "Tìm lâu hơn bình thường" + Thử lại; (7) quá tải (503): "QLead đang bận", còn bị giới hạn (429): "Bạn vừa tìm nhiều lần liên tiếp"; (8) khách ẩn danh muốn xem đầy đủ: khung khóa; (9) đăng ký xong quay lại kết quả: onboarding mở khóa, hết hạn 24 giờ thì giải thích và giữ lại mô tả; (10) đã đăng nhập: xem đầy đủ ngay trên landing, chân section ghi "Bạn đang đăng nhập".

Ảnh: `before-1440/390`, `found-locked-1440/768/390`, `empty-1440/768/390`, `searching-1440`, `timeout-1440`, `busy-1440`, `rate-limited-1440`, `register-from-landing-1440`, `onboarding-unlocked-1440`, `member-unlocked-1440`, `thu-tim-1440`, `thu-tim-expired-390`.

## D. Kết quả triển khai

**API mới** (Next Route Handlers, `web/app/api/landing/*`):
- `POST /api/landing/search` `{query}` (4–300 ký tự, schema strict): kiểm tra same-origin, rate limit theo địa chỉ (12/phút, 80/giờ), giới hạn 24 request đồng thời mỗi instance (vượt thì 503). Trả về `{previewId, outcome, leads[≤2], expiresAt, serverMs, member}`. Mỗi lead **chỉ có** `key, signals, excerpt, summarized, area, publishedAt, source, hasContact, match`. Server không gửi URL, tác giả, SĐT hay id nội bộ, nên client không thể sửa tham số để lấy thêm.
- `GET /api/landing/previews/:id`: **bắt buộc đăng nhập**. Chỉ trả đúng các bài preview đó đã hiện, và kiểm tra lại rằng bài vẫn thuộc catalog. Preview hết hạn sau 24 giờ thì trả 410. Lần mở đầu tiên ghi `claimed_by_user_id`.
- `POST /api/landing/events`: ghi sự kiện funnel (danh sách cố định), rate limit 90/phút.

**Không đổi worker/Muse/queue.** `src/cli.ts` chỉ thêm 022 vào danh sách migrate local. `ops/production-db.ts` tự đọc thư mục migrations.

**Database: migration `022_landing_preview.sql`** (chỉ thêm 2 bảng, bật RLS):
- `landing_previews`: id ngẫu nhiên, `query_hash` (SHA-256, **không lưu câu khách gõ**), `post_ids` (≤2), kết quả, `served_from` (`cache|pool|database`), `server_ms`, người xem/người mở khóa, `expires_at`.
- `landing_events`: 8 sự kiện theo yêu cầu, gồm `visitor_id` ngẫu nhiên (localStorage), `preview_id`, `trigger` (auto/user/suggestion), `result_count`, `client_ms`, `reason`. Không lưu IP, User-Agent hay nội dung tìm kiếm. Tự xóa bản ghi sau 180 ngày.

**Đo lường (SQL mẫu):**
```sql
-- Search-to-Result Time (trình duyệt) và Search Success Rate
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY client_ms) p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY client_ms) p95
FROM landing_events WHERE event = 'landing_search_results_shown' AND trigger <> 'auto';
SELECT avg((outcome = 'found')::int) FROM landing_previews;            -- success rate
SELECT served_from, count(*), percentile_cont(0.95) WITHIN GROUP (ORDER BY server_ms) FROM landing_previews GROUP BY 1;  -- cache hit / tải DB
-- Preview-to-Signup và Signup-to-Value
SELECT count(DISTINCT preview_id) FILTER (WHERE event = 'landing_signup_clicked')::float / NULLIF(count(DISTINCT preview_id) FILTER (WHERE event = 'landing_search_results_shown'), 0),
       count(*) FILTER (WHERE event = 'landing_signup_completed') FROM landing_events;
SELECT count(*) FILTER (WHERE claimed_by_user_id IS NOT NULL) FROM landing_previews;  -- tài khoản mới thực sự xem được lead
```

**File chính:** `web/lib/landing-search.ts` (xếp hạng thuần), `web/lib/server/landing-search.ts` (pool, cache, preview, mở khóa, sự kiện), `web/lib/server/landing-guard.ts` (rate limit, backpressure), `web/lib/landing-client.ts`, `web/components/hero-demo.tsx`, `web/components/landing-handoff.tsx`, `web/app/app/thu-tim/page.tsx`. Ngoài ra có sửa nhỏ ở `onboarding.tsx`, `auth-screen.tsx`, `dang-ky/page.tsx`, `globals.css`, `web/.env.example`.

## E. Bằng chứng kiểm thử

Môi trường: bản build **production** (`next build` + `next start`) chạy ở cổng 3052 trên máy Thi. DB là **bản sao cô lập** `muse_bridge_landing` (pg_dump từ `muse_bridge` local, áp thêm migration 016–022). Dữ liệu là **664 bài Facebook thật** do Muse thu thập. Catalog thử nghiệm gồm 4 tài khoản của Thi; tài khoản "Quoc Hiep" và các tài khoản khác cố ý để ngoài catalog, dùng để kiểm tra cách ly.

| Bộ test | Kết quả |
|---|---|
| Unit `test/landing-search.test.ts` | **9/9**: tối đa 2 bài, không độn bài, khu vực phải khớp, miền chứa tỉnh, loại bài cũ/ngày tương lai/chỉ tiếng Anh, nhãn tóm tắt, gộp bài trùng, payload không có SĐT/email/link/tác giả, phần "người bán" không làm mất loại khách |
| Backend `npm test` (DB `muse_bridge_landing_test` sạch) | **149 pass, 4 skip, 0 fail** (153 test) |
| E2E `web/e2e/landing-real-leads-e2e.mts` | **27/27** (xem `e2e-output.txt`, `e2e-results.json`) |
| Responsive sweep `web/e2e/responsive-landing.mjs` (280–2560px, landscape, zoom 200/400%, reduced motion, chạm 360px) | **41/41** (`responsive-output.txt`) |
| `tsc --noEmit` (web) | Không lỗi |

E2E đã chạy qua: tìm lead thật và đối chiếu với DB (đúng bài, đúng giờ đăng thật, thuộc catalog); cache; payload và màn hình không có SĐT/link; khung khóa; trạng thái trống; ô nhập quá ngắn; 503/429/chậm hơn 8 giây (giả lập bằng request routing, vì không tạo được thật theo ý); loading không có %; không lỗi console; CTA lưu mô tả → đăng ký bằng form thật → onboarding hiện **đúng link Facebook của các bài preview**, mô tả điền sẵn; server ghi `signup_completed` + `full_results_viewed`; lưu onboarding → **job `initial` thật với đúng mô tả**; landing khi đã đăng nhập mở khóa ngay trên trang; tài khoản cũ đăng nhập → `/app/thu-tim` hiện lead và giải thích khi hết hạn; người chưa đăng nhập gọi API mở khóa nhận 401; 768/390px không cuộn ngang; CLS 0,002; request thứ 13 trong một phút bị 429; cross-origin bị 403, query quá dài hoặc có tham số lạ bị 400; **cách ly tenant**: kiểm tra mọi bài trong **192 preview** đều thuộc catalog, kể cả khi tìm bằng nguyên văn bài của khách khác; 8 loại sự kiện đều được ghi và không có cột chứa nội dung tìm kiếm.

**Hiệu năng đo thật (local, bản production):**
- Bấm → lead hiện trên màn hình (đo trong trang): **20–45 ms**. Request API: 14–29 ms.
- `server_ms` theo nguồn: cache p95 **0 ms**; pool sẵn p50 **3 ms** / p95 **7,6 ms**; nạp lại pool từ DB (mỗi phút một lần trên mỗi instance) p50 **238 ms** / p95 **812 ms**, max 1.048 ms.
- Xếp hạng 467 bài đã phân tích: 2–20 ms mỗi truy vấn.

**Bug tìm được và đã sửa trong lúc test:** khi API trả lỗi (429/503/410), client không đọc body nên kết nối bị giữ mở mãi. Đã sửa bằng cách hủy body. Server cũng đọc body trước khi trả 429.

**Chưa kiểm chứng được và lý do:**
- **Độ trễ thật trên Vercel (hnd1) ↔ Supabase**: chưa deploy. Ước tính thêm khoảng 1 round-trip mạng từ Việt Nam cộng 1 INSERT, tức dưới 0,5 giây. Cần đo bằng `landing_events.client_ms` sau khi deploy.
- **Muse live**: landing cố ý không gọi Muse. Job `initial` sau đăng ký đã được tạo (kiểm tra trong DB), nhưng không có worker Muse chạy trong bản sao này, nên phần Muse quét Facebook thật cho tài khoản mới **chưa chạy trong lần test này**. Luồng đó không đổi so với FIRST_SCAN.md.
- **Dữ liệu catalog trên production**: chưa có. Cần Admin tạo trước (xem mục F).
- Rate limit nằm trong bộ nhớ từng instance, nên trên Vercel nhiều instance thì giới hạn thực tế lỏng hơn. Chấp nhận được vì mỗi request chỉ là một lần đọc cache và một INSERT nhỏ.

## F. Trạng thái Git và các bước để lên production
- Nhánh `feature/landing-real-leads` (từ `origin/main` cffa3c1), 1 commit, PR **draft** (link trong tin nhắn). **Chưa merge, chưa deploy.** Không đụng DB production, không đổi cấu hình Vercel.
- Trước khi merge, Thi cần:
  1. **Quyết định nguồn dữ liệu.** Mình đề xuất chỉ dùng tài khoản trưng bày. Dùng lead của khách hàng cho landing cần có điều khoản/đồng ý rõ ràng, nên mình không bật.
  2. Tạo 1 tài khoản trưng bày (đăng ký bình thường, hoặc dùng tài khoản Admin) với khoảng 4–6 nhu cầu phổ biến, ví dụ: quán F&B sắp khai trương, khách sạn/homestay sắp hoạt động, shop thời trang/mỹ phẩm mở chi nhánh, spa/salon mới mở, nhà hàng tuyển người. Tần suất 6 giờ (có sẵn: 30 phút, 1 giờ, 6 giờ, 24 giờ) để không chiếm năng lực Muse của khách. Chờ ít nhất một lượt quét.
  3. Chạy migration 022 trên Supabase: `npx tsx ops/production-db.ts migrate` rồi `verify`.
  4. Thêm `QLEAD_LANDING_CATALOG_USER_IDS=<user id trưng bày>` vào Vercel **Production**.
  5. Merge PR → Vercel deploy → kiểm tra `/` và chạy `web/e2e/responsive-landing.mjs https://qlead.vn`.

---

## Cập nhật 08/11 (theo góp ý của Thi)
- **Khách chưa đăng ký mở được bài Facebook gốc.** Mỗi lead có nút "Xem bài trên Facebook" (mở tab mới). API trả thêm trường `url`, chỉ khi đó là permalink Facebook hợp lệ (`isSupportedFacebookPostUrl`). Tên người đăng và SĐT trong trích đoạn vẫn được ẩn trên trang QLead.
- **Bỏ khung khóa trong từng thẻ.** Ngay dưới 2 lead là nút **"Xem thêm lead phù hợp"** (kèm dòng "Đăng ký miễn phí để xem thêm lead và nhận lead mới cho nhu cầu này."), dẫn thẳng tới `/dang-ky?tu=thu-tim`. Mô tả và kết quả được mang theo như trước. Không dùng popup.
- Phụ đề trang đăng ký đổi thành: "Miễn phí. Xem thêm lead cho nhu cầu bạn vừa tìm, không cần nhập lại."
- Mọi bước sau khi đăng ký **giữ nguyên**: onboarding hiện 2 lead đầy đủ + mô tả điền sẵn + job `initial`, cùng `/app/thu-tim`. Khi đã đăng nhập, landing có thêm nút "Chi tiết" để xem tác giả/SĐT.
- Kiểm thử lại trên bản build production: unit **9/9**, E2E **27/27**. A5 kiểm tra `url` khớp đúng `original_url` trong DB, và payload vẫn không có tác giả/SĐT. A6 kiểm tra link mở tab mới với `noopener` và nút "Xem thêm" trỏ tới trang đăng ký. Responsive **39/39**: 2 kiểm tra về khung khóa cũ không còn áp dụng nên số kiểm tra giảm từ 41. Ảnh mới: `found-1440/768/390.png`.
- Bỏ dòng "Đã có tài khoản? Đăng nhập" khỏi section; người đã có tài khoản đăng nhập từ trang đăng ký (link vẫn mang `?tiep=/app/thu-tim`). Test lại: E2E 27/27 (C1 đi qua trang đăng ký → Đăng nhập), responsive 39/39.

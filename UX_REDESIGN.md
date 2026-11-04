# QLead — Audit UX và redesign frontend (31/10/2026)

Phạm vi: `web/` (Next.js 16, React 19). Backend Fastify/Postgres, crawler và lịch Muse không bị sửa. Ảnh chụp trước/sau nằm trong `docs/ux-screenshots/`.

## 1. Các vấn đề UX quan trọng đã tìm thấy

| # | Vấn đề | Tác động | Mức độ | Nguyên nhân UX | Đã xử lý |
|---|---|---|---|---|---|
| 1 | Bảng lead mẫu gần như trống: mọi dòng ghi "Chưa rõ người đăng", "Chưa có", "Chưa có thời gian", "Chưa có liên kết" | Sản phẩm không chứng minh được giá trị ở chính màn hình quan trọng nhất | Nghiêm trọng | Dữ liệu preview bị xóa hết trường để tránh "bịa", nhưng không thay bằng mẫu được dán nhãn | Dữ liệu mẫu đầy đủ, hư cấu rõ ràng, dán nhãn một lần ở thanh trên cùng |
| 2 | Dữ liệu mẫu lệch persona: decor quán, túi canvas, kệ gỗ | Sales POS không thấy mình trong sản phẩm | Nghiêm trọng | Demo viết cho chủ shop, không cho Telesales B2B | 9 bài mẫu theo 3 nhóm: POS F&B, phần mềm bán lẻ, thiết bị/thi công |
| 3 | Hero đặt textarea và quy trình 4 bước lên trước kết quả | Người xem tưởng là chatbot/ô tìm kiếm | Nghiêm trọng | Ưu tiên phương thức nhập liệu thay vì kết quả | Demo hiển thị sẵn 3 lead ngay khi tải trang; nhập mô tả là tùy chọn |
| 4 | Không phân biệt lead mới/đã xem, không có hành động lưu thật | Sales không biết bài nào nên xem trước | Cao | Thiếu mô hình "hộp thư" | Chấm "chưa xem", lọc Chưa xem / Có số / Đã lưu, trang Hôm nay |
| 5 | Phải mở trang chi tiết mới đọc được đủ thông tin | Nhiều cú nhấp cho mỗi lead | Cao | Bảng 6 cột chữ nhỏ | Desktop: danh sách + panel chi tiết cạnh nhau; mobile: thẻ gọn, chạm để mở |
| 6 | Typography: chữ bảng 11–12px, nhãn in hoa 9–10px, font fallback serif ở ô thống kê, `letter-spacing:-.035em` làm dính dấu | Khó đọc tiếng Việt, kém chuyên nghiệp | Cao | CSS vá nhiều lớp (70KB, nhiều media query chồng nhau) | Viết lại stylesheet; Be Vietnam Pro; tối thiểu 13px; bỏ nhãn in hoa |
| 7 | Quá nhiều nhãn "MẪU / MINH HỌA / BẢN XEM TRƯỚC / CHƯA CÓ DỮ LIỆU THẬT" lặp lại trên mỗi thẻ | Gây nhiễu, giảm tin cậy | Trung bình | Lo ngại giả mạo dữ liệu được xử lý bằng cách dán nhãn khắp nơi | Một dải thông báo cho cả app, một nhãn "Dữ liệu minh họa" cho demo |
| 8 | Section "Lịch tìm kiếm 30 phút" chiếm cả màn hình cho một chi tiết kỹ thuật | Kể cách hệ thống chạy thay vì lợi ích | Trung bình | Kiến trúc thông tin hướng kỹ thuật | Gộp vào bước 2 của "Cách hoạt động" và FAQ |
| 9 | Search builder lộ `social.search`, "cụm tìm kiếm", "phiên bản cấu hình" | Tải nhận thức không cần thiết | Trung bình | Thiếu progressive disclosure | Ẩn vào "Xem cụm tìm kiếm" và "Tùy chọn nâng cao"; thêm mẫu theo ngành |
| 10 | Điều hướng mobile của app không có (sidebar biến mất) | Không chuyển màn hình được trên điện thoại | Cao | Responsive chỉ thu nhỏ | Thanh điều hướng dưới cùng 4 mục |
| 11 | Mèo xuất hiện ở sidebar, auth, demo, empty state với câu thoại "Miu sẽ giúp bạn" | Mascot lấn át sản phẩm | Thấp | Dùng mascot thay cho nội dung | Giữ mèo nhỏ ở demo (phản hồi trạng thái), auth và empty state; bỏ câu thoại |

## 2. Primary persona: Telesales / Direct Sales

Nhân viên kinh doanh phần mềm POS (KiotViet, Sapo, iPOS…) hoặc giải pháp cho cửa hàng. Có KPI số khách mới, dùng Facebook để prospecting, mở công cụ trong vài phút giữa các cuộc gọi. Câu hỏi mỗi lần mở: có gì mới, bài nào xem trước, ai cần gì, ở đâu, đăng khi nào, có số không, mở bài gốc ở đâu. Họ không muốn học cấu hình. Họ cần tin rằng dữ liệu không bị thổi phồng.

Thiết kế ưu tiên persona này ở luồng đầu tiên, nhưng mẫu ngành và trang chủ có sẵn nhóm thiết bị, nội thất, in ấn, phân phối, dịch vụ B2B.

## 3. Định vị sau audit

**QLead: khách hàng tiềm năng từ Facebook, gom sẵn cho đội sales.** QLead theo dõi bài đăng theo ngành, tín hiệu và khu vực, rồi đưa về một danh sách lead có thể hành động. Giá trị là danh sách lead và tốc độ phát hiện, không phải ô nhập prompt. Mọi chỗ đều nói "cơ hội tiềm năng", và nói rõ cần đọc bài gốc để xác nhận.

## 4. Nội dung và luồng thông tin

Landing mới: Hero + demo → Mỗi lead có gì → So với tự tìm → 3 bước → Ngành phù hợp → FAQ trung thực → CTA. Đã bỏ section lịch quét riêng, bản xem trước app cũ và luồng 4 ô. FAQ nói thẳng: lead chưa xác minh, 30 phút không bảo đảm, thông báo đang phát triển, số điện thoại chỉ lấy từ nội dung bài.

App mới: **Hôm nay** (lead chưa xem, mới đăng trước) → **Danh sách lead** (lọc, chi tiết) → **Nhu cầu theo dõi** (builder) → **Kết nối**.

## 5. Hero và demo

Headline hai dòng, CTA chính "Xem lead mẫu", phụ "Tạo tài khoản", ba lợi ích ngắn. Demo full-width ngay dưới: cột trái chọn "bạn đang bán gì" (3 mẫu + tự mô tả bằng `interpretSearchRequest`), khối "QLead hiểu bạn cần tìm" (Ngành, Tín hiệu, Khu vực). Cột phải là kết quả: tín hiệu, nhu cầu trích nguyên văn, người đăng, nhóm, khu vực, thời gian đăng, số liên hệ nếu có, nút xem bài đầy đủ và lưu. Đổi nhóm có hiệu ứng lọc 0,7 giây (tắt khi bật reduced motion). Mô tả không có dữ liệu mẫu thì demo nói thật thay vì trả kết quả giả. Demo dùng chính các hàm trích xuất của backend nên hiển thị đúng cách dữ liệu thật sẽ hiện, kể cả "Bài chưa nêu rõ khu vực".

## 6. Khu vực lead results

- Mỗi dòng trong danh sách: chấm vàng chưa xem, người đăng, thời gian đăng tương đối, câu nhu cầu (đậm khi chưa xem), khu vực, "Có số liên hệ", "Đã lưu".
- Panel chi tiết: nhu cầu, chip tín hiệu, 6 ô sự kiện (người đăng, số trong bài có nút gọi/sao chép, khu vực, đăng lúc, QLead phát hiện, nguồn). Kèm hành động (mở bài Facebook nếu có link, lưu, đánh dấu chưa xem), nội dung gốc và mục "Vì sao QLead gợi ý bài này?".
- Lọc: từ khóa, khu vực, thời gian đăng, sắp xếp mới đăng/mới phát hiện, chip Chưa xem/Có số/Đã lưu, nút xóa lọc có đếm.
- Quy tắc dữ liệu: không có link thì không hiện nút mở bài, không có giờ đăng thì ghi "Chưa có thời gian đăng" và không thay bằng giờ quét. Khu vực chỉ lấy theo bài, số chỉ lấy khi bài tự ghi.
- Trạng thái đã xem/đã lưu lưu trong trình duyệt (localStorage) vì backend chưa có API, xem mục 11.

## 7. Thay đổi đã triển khai

Hệ thống thiết kế mới (token màu, thang chữ, nút, focus ring, skeleton, reduced motion). Landing và demo viết lại. App shell có thanh điều hướng mobile. Có thêm trang Hôm nay, danh sách lead master-detail, trang chi tiết lead. Builder được làm gọn. Onboarding còn 3 bước theo ngành. Màn hình kết nối không giả trạng thái. Auth được làm gọn. Metadata/OG cập nhật theo định vị mới.

## 8. File đã sửa

- `web/app/layout.tsx`, `web/app/globals.css` (viết lại), `web/app/page.tsx`, `web/app/manifest.ts`, `web/app/dang-nhap/page.tsx`, `web/app/dang-ky/page.tsx`
- `web/components/visuals.tsx`, `hero-demo.tsx`, `lead-results.tsx`, `dashboard.tsx`, `search-intent-builder.tsx`, `auth-demo-form.tsx`
- `web/lib/demo-data.ts`, `web/lib/api/adapter.ts`; mới: `web/lib/lead-format.ts`, `web/lib/lead-state.ts`
- `web/next.config.ts` (tùy chọn `QLEAD_DIST_DIR` để build kiểm thử không đè `.next`), `web/.gitignore`

## 9. Build và kiểm thử

- `tsc --noEmit`: sạch. `next build --webpack` (vào `.next-verify`): thành công, 12 route.
- `test/lead-data.test.ts`, `test/search-intent.test.ts`: 11/11 pass. Integration test cần Postgres nên không chạy lại; backend không bị sửa.
- Không tràn ngang ở 390, 768, 1024, 1280, 1440px trên mọi route.
- Đã thử thật: đổi nhóm demo, tự mô tả và gửi bằng bàn phím, mở lead từ danh sách mobile sang trang chi tiết, chọn lead trên desktop, lưu, lọc.
- Server `next start` ở cổng 3000 vẫn là bản build cũ. Chạy `npm run build` rồi khởi động lại để thấy bản mới.

## 10. Screenshot

`docs/ux-screenshots/`: `before-*` (trước), `final-landing-fold-1440.png`, `final-today-1440.png`, `final-leads-1440.png`, `final-landing-390.jpg`, `final-detail-390.jpg`.

## 11. Còn thiếu để bán cho khách thật (yêu cầu backend)

1. **Đăng nhập người dùng và API theo tenant**: `GET /api/leads` trả `StoredFacebookPost[]` của đúng agent connection người dùng sở hữu; `GET /api/connections` trả `{ muse, facebook, lastScanAt }`. Adapter phía web đã sẵn (`HttpLeadAdapter`).
2. **Trạng thái lead theo người dùng**: lưu `seen_at`, `saved_at` mỗi user/post (`PATCH /api/leads/:id`), thay localStorage.
3. **Lưu nhu cầu theo dõi**: `POST /api/search-configs` nhận `SearchIntent` và dùng `toLegacyScanConfig` phía server.
4. **Lỗi trích xuất khu vực** trong `src/lead-data.ts`: `\b` không hoạt động với chữ có dấu nên không nhận Đồng Nai, Cần Thơ, Đà Nẵng, Huế (cùng lỗi trong `interpretSearchRequest`: "Tiệm bánh sắp mở ở Đà Nẵng" trả về khu vực rỗng, đã thử). Đề xuất dùng lookaround Unicode `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])` với cờ `u`, kèm test. Thiếu cả Long An, Biên Hòa và nhiều tỉnh khác.
5. **Tín hiệu kinh doanh phía server**: chip tín hiệu hiện do frontend khớp cụm từ (`web/lib/lead-format.ts`); nên chuyển vào bản ghi lead để lọc theo ngành/tín hiệu được.
6. **Thông báo lead mới** (email/Zalo/push): chưa có, đang ghi rõ "đang phát triển".
7. **Xác minh pháp lý/điều khoản** về xử lý dữ liệu Facebook và số điện thoại công khai trước khi bán.

---

# Vòng 2 — Tách Hero và sửa cách nhập tìm kiếm (31/10/2026)

**Vì sao Hero cũ chưa hiệu quả.** Màn hình đầu tiên gộp lời giới thiệu, ô chọn ngành, ô nhập liệu và bảng kết quả. Trông như một màn hình ứng dụng đặt ngay dưới navbar: không có điểm nhấn cảm xúc, không có thương hiệu, và người xem phải đọc nhiều trước khi hiểu QLead là gì. Phần marketing và phần chứng minh tranh nhau cùng một chỗ.

**Vì sao 4 lựa chọn bị sai cấp.** Ba thẻ đầu là *loại sản phẩm đang bán*, thẻ thứ tư "Tự mô tả" là *cách nhập liệu*. Đặt ngang hàng khiến QLead trông như chỉ dành cho 3 ngành, còn mọi ngành khác phải đi đường "dự phòng".

**Kiến trúc thông tin mới.** (1) Hero: bán giá trị. (2) Demo "Thử tìm khách hàng của bạn": chứng minh trải nghiệm. (3) "Không chỉ tìm một lần": 3 lợi ích theo dõi tự động. Sau đó là Mỗi lead có gì, So với tự tìm, Ngành phù hợp (ghi rõ là ví dụ, không phải giới hạn), Hỏi đáp, CTA. Section "3 bước" đã bỏ vì trùng với section theo dõi.

**Hero.** Headline "Tìm đúng lead tiềm năng. / Nắm bắt cơ hội sớm hơn." Mô tả: QLead tìm và theo dõi khách hàng tiềm năng từ bài đăng Facebook theo đúng nhu cầu của bạn, tự động quét lại mỗi 30 phút. Nút "Khám phá QLead" cuộn tới `#demo`, nút "Bắt đầu ngay" mở `/dang-ky`. Bên phải là mèo thần tài lớn trên nền vòng tròn kem/xanh, chuyển động nổi nhẹ, kèm hai thẻ minh họa nhỏ "Cơ hội mới phù hợp" và "Tự quét lại mỗi 30 phút". Hai thẻ này là hình minh họa (aria-hidden), không giả lập thông báo thật. Mobile xếp chồng: chữ → nút → mèo. Hiệu ứng tắt khi bật reduced motion.

**Mô hình nhập.** Một ô mô tả chung: "Bạn muốn tìm khách hàng nào?", gợi ý viết bằng ngành nào cũng được, có sẵn câu ví dụ để kết quả hiện ngay. Ba gợi ý phụ (viền đứt, nhỏ hơn ô nhập): Phần mềm bán hàng, Thiết bị quán cafe, Thiết kế nội thất. Bấm gợi ý sẽ điền một câu ví dụ đầy đủ vào ô và người dùng sửa tự do.

**Demo.** "QLead hiểu bạn cần tìm" giờ là 3 ô chỉnh được (Ngành / loại khách, Tín hiệu nhu cầu, Khu vực) và có nút "Tìm lại theo điều kiện này". Với ngành ngoài bộ phân tích hiện có (ví dụ "spa"), QLead lấy cụm khách hàng người dùng tự viết làm giá trị ban đầu. Nếu demo không có bài mẫu cho ngành đó, demo nói thật thay vì trả kết quả giả. Thẻ kết quả CRM giữ nguyên.

**File đổi.** `web/app/page.tsx`, `web/app/globals.css`, `web/components/hero-demo.tsx`.

**Kiểm thử.** `tsc` sạch, `next build` thành công, unit test 11/11. Không tràn ngang ở 390/768/1024/1440. Đã thử thật: nút "Khám phá QLead" cuộn đúng tới demo, gợi ý điền câu và focus vào ô nhập, gõ "Tôi bán máy lọc nước, muốn tìm spa sắp khai trương ở Hà Nội" rồi gửi bằng bàn phím → điều kiện "spa · Sắp khai trương · Hà Nội" kèm thông báo trung thực là chưa có bài mẫu. Screenshot: `docs/ux-screenshots/hero-final-*.png|jpg`, `hero-demo-final-1440.png`, `demo-final-390.jpg`.

---

# Vòng 3 — Hero theo câu chuyện tín hiệu kinh doanh (31/10/2026)

**1. Hiểu lại mô hình kinh doanh.** QLead là công cụ phát hiện cơ hội, không phải công cụ tìm bài "hỏi mua". Người sắp mở quán hiếm khi đăng "cần mua phần mềm". Họ đăng tuyển người, báo khai trương, mở chi nhánh, tìm mặt bằng. Người bán hàng cần nhận ra những doanh nghiệp đang ở giai đoạn phù hợp, còn việc có liên hệ hay không vẫn do họ quyết định.

**2. Lỗi UX quan trọng nhất trước vòng này.**
- Thẻ trong Hero biến "quán sắp khai trương" thành "cần phần mềm tính tiền", tức là bịa ra ý định mua.
- Chip "Cần phần mềm / POS" hiện ra chỉ vì bài có nhắc tới chữ "phần mềm".
- Câu trong bài bị dán nhãn "Nhu cầu" dù bài không nêu nhu cầu nào.
- Dữ liệu demo gần như toàn bài hỏi mua trực tiếp, nên không cho thấy được giá trị khác biệt.
- Hero tĩnh, mèo đứng tách khỏi câu chuyện, và không cho thấy một bài đăng bình thường trở thành cơ hội như thế nào.

**3. Các hướng thông điệp đã cân nhắc.**

| Hướng | Headline | Đánh giá |
|---|---|---|
| A (đã chọn) | Khách hàng tiềm năng hiếm khi nói “tôi cần mua”. QLead giúp bạn nhận ra họ sớm. | Nói thẳng insight khác biệt (tín hiệu gián tiếp), tạo cảm giác "mình đang bỏ lỡ". Không hứa độ chính xác. Dùng được cho mọi ngành. |
| B | Cơ hội bán hàng đang nằm trong những bài đăng Facebook mỗi ngày. | Gợi hình nhưng mơ hồ, nghe như công cụ tìm bài. |
| C | Biết quán nào sắp mở, chuỗi nào mở chi nhánh, trước khi bạn phải đi tìm. | Cụ thể nhưng nghiêng hẳn về F&B, dài, và ngầm hứa về tốc độ. |
| Cũ | Tìm đúng lead tiềm năng. Nắm bắt cơ hội sớm hơn. | Rõ ràng nhưng chung chung, sản phẩm nào cũng có thể dùng câu này. |

**4. Lý do chọn A.** Đây là câu duy nhất vừa mô tả đúng giá trị (nhận ra khách chưa lên tiếng) vừa trung thực (nói "nhận ra", không nói "tìm được khách sẽ mua"). Đoạn mô tả bên dưới dùng ba ví dụ ở ba ngành khác nhau để chứng minh câu chữ, và nói rõ lịch quét 30 phút.

**5. Câu chuyện thị giác.** `web/components/hero-scene.tsx` vẽ một khung bảng tin Facebook gồm 3 bài: quán cafe tuyển người trước khai trương, chuỗi trà sữa mở chi nhánh, khách sạn sắp hoạt động. Một dải quét vàng lướt qua, cụm từ tín hiệu trong bài được tô sáng, rồi thẻ "Cơ hội có thể phù hợp" bật ra với Tín hiệu, Ngành, Khu vực, kèm câu "Bài không nói cần mua. Bạn quyết định có nên liên hệ." Mèo nghiêng người khi đang đọc và nhảy lên vẫy tay khi phát hiện. Chip "Tự quét lại mỗi 30 phút" có vòng radar. Một nhãn "Ví dụ minh họa" và 3 nút chấm cho phép xem lại từng ví dụ.

**6. Animation và tương tác.**
- Khi tải trang: các thẻ bài xuất hiện lần lượt, cụm tín hiệu được tô sáng, thẻ cơ hội bật lên, mèo phản ứng.
- Sau đó cảnh tự chuyển qua 2 ví dụ còn lại, mỗi ví dụ có một lượt quét, rồi **dừng hẳn**, không lặp vô hạn.
- Vòng radar chỉ nháy 3 lần.
- Bấm vào nút chấm sẽ chuyển ví dụ và tắt chế độ tự chạy.
- Khi bật `prefers-reduced-motion`: không tự chuyển, mọi hiệu ứng hiện ngay ở trạng thái cuối, và độ trễ animation được đặt về 0.
- Không dùng thư viện mới, chỉ CSS và React state.

**7. Cách thể hiện tín hiệu gián tiếp.** `web/lib/lead-format.ts` có `readLead()` tách ba lớp:
- **Bài đăng nói gì**: câu trích nguyên văn.
- **Tín hiệu**: các nhãn Sắp mở cửa, Mới mở, Mở chi nhánh, Đang tuyển nhân sự, Tìm / thuê mặt bằng, kèm phân loại "Bài nêu rõ nhu cầu" hoặc "Tín hiệu kinh doanh".
- **Vì sao đáng chú ý**: lý do luôn ở dạng khả năng. Với tín hiệu kinh doanh luôn kèm câu "Bài không nói cần mua sản phẩm của bạn".

Đã bỏ các chip dựa trên việc bài nhắc tên sản phẩm. Danh sách lead, panel chi tiết, thẻ demo và ví dụ "Mỗi lead có gì" đều dùng chung mô hình này.

**8. Thay đổi trong demo.**
- 12 bài mẫu, trong đó phần lớn là tín hiệu gián tiếp (tuyển người, mở chi nhánh, thuê mặt bằng, khách sạn sắp hoạt động), một số là bài nêu rõ nhu cầu.
- Thêm nhóm "Phần mềm khách sạn" và gợi ý tương ứng.
- Câu mặc định trong ô nhập chuyển sang mục tiêu tìm khách: "quán F&B sắp khai trương, đang tuyển người hoặc mở chi nhánh".
- FAQ thêm câu "QLead chỉ tìm bài hỏi mua thôi sao?", trong đó nói rõ hiện trạng kỹ thuật.

**9. Kiểm thử.**
- `tsc` sạch, `next build` thành công, unit test 11/11.
- Không tràn ngang ở 390, 768 và 1440px.
- Trên trình duyệt thật: chuỗi ví dụ tự chạy 1 → 2 → 3 rồi dừng; nút chấm chuyển ví dụ đúng; nút CTA hoạt động.
- Screenshot: `docs/ux-screenshots/v3-*`.
- Phần reduced motion được kiểm qua mã (CSS `@media` và kiểm tra `matchMedia`), chưa giả lập được cài đặt này trong trình duyệt.

**10. Khoảng trống còn lại.**
- **Tín hiệu chỉ có ở frontend.** Việc nhận diện tín hiệu hiện chỉ là khớp cụm từ, chạy ở frontend. Backend và Muse vẫn chỉ nhận danh sách từ khóa và khu vực, chưa có xác minh nào cho tìm kiếm theo tín hiệu ngữ nghĩa.
- **Cần làm phía server:**
  - Lưu `signals` kèm bằng chứng vào bản ghi lead.
  - Sinh cụm tìm kiếm theo tín hiệu (ví dụ "tuyển nhân viên quán cafe khai trương").
  - Thêm bộ lọc theo tín hiệu.
- **Heuristic `extractNeedFromPost` bắt nhầm.** Ví dụ "nhân viên tư vấn bán hàng" bị coi là có nhu cầu vì chứa chữ "tư vấn". Cần tinh chỉnh ở backend.

---

# Vòng 4 — Hero gọn lại (31/10/2026)

Phản hồi: Hero vòng 3 quá nhiều chữ, khó hiểu. Đã đổi sang một thông điệp duy nhất: **"Quét lead từ Facebook nhanh và tự động."** kèm một câu mô tả. Minh họa chỉ còn mèo thần tài, chip "Đang quét Facebook · mỗi 30 phút" và 3 thẻ lead một dòng (tên, tín hiệu · khu vực, thời gian) trượt vào lần lượt, mèo vẫy tay sau đó. Bỏ đoạn văn trong thẻ, dải quét, nút chuyển ví dụ và thẻ giải thích; phần giải thích tín hiệu vẫn nằm ở demo bên dưới. Thêm `suppressHydrationWarning` cho `<html>`/`<body>` vì cảnh báo "1 Issue" đến từ tiện ích trình duyệt chèn thuộc tính `bis_register`, `__processed_*` vào trang. Screenshot: `docs/ux-screenshots/v4-hero-*`.

**Vòng 4b.** Bỏ thẻ lead khỏi Hero (che mặt mèo ở màn hình hẹp). Vẽ lại mèo thần tài (đốm cam/đen, vòng cổ đỏ, chuông và thỏi vàng) trong `Cat` của `web/components/visuals.tsx`; Hero có hiệu ứng vẫy tay gọi khách, chớp mắt, đuôi đung đưa, chuông lắc, mèo nhún nhẹ, lấp lánh và đồng xu bay; tất cả tắt khi bật reduced motion.

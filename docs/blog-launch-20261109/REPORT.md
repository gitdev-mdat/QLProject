# Ra mắt Cẩm nang QLead: điều hướng và hoàn thiện Blog

Ngày: 2026-11-09. Nhánh `claude/blog-launch`, tách từ `codex/technical-seo-foundation` tại `bd8d832` (commit đang chạy production). Không merge, không deploy.

## 1. Trạng thái trước khi sửa

- Repo `gitdev-mdat/QLProject`, worktree `C:\WorkspaceLead\qlead-seo-foundation` sạch, đúng `bd8d832`. `main` (d3af393) đang đi sau production: Blog và Technical SEO chỉ nằm trên nhánh Codex.
- `/blog` và `/blog/[slug]` đã có (từ PR #19, Codex đã gộp). Hai bài pilot đều `draft`. Trên production: `/blog` và cả hai bài trả 404, sitemap chỉ có `https://qlead.vn`. Đúng như hợp đồng `docs/blog-technical-contract.md`.
- Landing không có liên kết nào tới Blog. Blog tự gọi mình là "Blog", không phải "Cẩm nang".

## 2. Đã làm

| Hạng mục | Thay đổi |
|---|---|
| Header Landing (desktop) | Thêm `Cẩm nang` → `/blog` sau "So sánh", cùng thẻ và style với các mục khác. Không icon, không CSS mới. |
| Mobile/tablet (≤960px) | Header hiện tại ẩn toàn bộ menu mục và chỉ giữ nút tài khoản; liên kết phụ nằm ở footer. `Cẩm nang` theo đúng pattern đó: có ở footer, không thêm thanh điều hướng. |
| Footer Landing | Thêm `Cẩm nang` đầu nhóm liên kết; đổi `aria-label` của nhóm từ "Tài khoản" thành "Liên kết" cho đúng nội dung. |
| Điều kiện hiện liên kết | Chỉ hiện khi bản deploy có ít nhất một bài được phép hiển thị (`hasVisiblePosts()`). Production chưa có bài published thì liên kết ẩn, nên không bao giờ có link dẫn tới 404. Preview của Vercel hiện liên kết vì bản nháp được xem trước ở đó. |
| Blog | Đổi tên hiển thị "Blog" → "Cẩm nang" ở header Blog, footer Blog, breadcrumb và BreadcrumbList JSON-LD. Trang `/blog`: H1 "Cẩm nang tìm khách hàng", mô tả mới, title "Cẩm nang tìm khách hàng theo tín hiệu kinh doanh \| QLead". URL giữ `/blog`. |
| Bài quán cafe | Bỏ nguồn Toast (trang chặn truy cập tự động, không kiểm chứng được mốc 9/6/3 tháng). Viết lại câu dẫn Sapo cho khớp nội dung thật của trang: mục "Mua phần mềm quản lý quán cafe" nằm trong phần lập kế hoạch khai trương, cùng checklist đào tạo nhân viên trước ngày khai trương. |

Không đổi: Hero, headline, demo, animation, bảng so sánh, CTA, các section khác, design system, cấu hình Technical SEO (robots, sitemap, metadataBase, attribution).

## 3. Hai bài pilot

| Bài | Trạng thái | Ghi chú |
|---|---|---|
| Cách tìm quán cafe sắp khai trương trên Facebook để chào hàng sớm | **Ready for Review** (vẫn `draft`) | Đã sửa nguồn. Không còn tuyên bố chưa kiểm chứng. |
| Cách tìm khách hàng tiềm năng trên Facebook qua tín hiệu kinh doanh | **Ready for Review** (vẫn `draft`) | Không cần sửa. |

Đã đối chiếu lại với code tại `bd8d832`: 6 tín hiệu (`SIGNALS`, `src/search-plan.ts`), bài đăng và Reels (`src/lead-eligibility.ts`), lịch mặc định 30 phút (`src/search-intent.ts`), thứ tự ưu tiên 1/3/7 ngày (`web/lib/lead-ranking.ts`), gợi ý "Phần mềm quán cafe" ở demo (`components/hero-demo.tsx`), "miễn phí" khớp copy hiện có. Không có: real-time, gửi qua Zalo/Messenger, quét mọi nhóm, bảo đảm mua, bảo đảm SĐT chính chủ, chính xác 100%. Mọi ví dụ bài đăng là câu do biên tập viết, có nhãn "Minh họa"; không có dữ liệu cá nhân.

Giữ `draft` vì chủ sản phẩm yêu cầu duyệt nội dung trước khi công khai. Cần chủ sản phẩm quyết:
1. Duyệt nội dung hai bài (đọc bản preview của PR).
2. Tùy chọn: điền `reviewedBy` nếu có người sales đồng ý đứng tên kiểm tra; thay ví dụ minh họa bằng bài thật đã ẩn danh nếu được phép. Không bắt buộc để xuất bản.

Xuất bản = trong mỗi file `web/content/blog/*.tsx` đổi `status: 'published'` và `publishedAt: '<ngày>'`. Khi đó liên kết "Cẩm nang", `/blog` và sitemap tự bật.

## 4. Kiểm thử

Build production `next build --webpack` thành công ở cả hai trạng thái. Script: `web/e2e/blog-launch-qa.mjs <baseUrl> <outDir>`.

**Trạng thái hiện tại (draft, như production sau khi merge):** `/` 200, không có liên kết "Cẩm nang"; `/blog` và hai bài 404; sitemap chỉ có `/`; robots giữ nguyên.

**Trạng thái mô phỏng sau khi duyệt (hai bài published, không commit):**
- `/blog` 200, hai bài 200, slug lạ 404.
- Sitemap: `/`, `/blog`, hai bài với `lastmod`. Không có bản nháp.
- `/blog`: title, description, canonical `https://qlead.vn/blog`, OG/Twitter, không `noindex`.
- Bài: canonical riêng, `og:type=article`, `article:published_time`/`modified_time`, BlogPosting (headline = H1, datePublished, dateModified, author/publisher Organization) và BreadcrumbList QLead › Cẩm nang › bài. Một H1, 9 H2, HTML server-rendered. Liên kết nội bộ chéo hai bài và CTA về `/#demo` với UTM hoạt động.
- Header Landing: cao 69px trước và sau; nút "Đăng nhập" và "Bắt đầu ngay" giữ nguyên tọa độ ở 1440, 1100 và 961px.
- 1440/768/390px cho Landing, `/blog`, hai bài: không cuộn ngang; liên kết footer có ở mọi trang.

Ảnh chụp: `docs/blog-launch-20261109/screenshots/` (thư mục bị git bỏ qua, giữ trên máy).

## 5. Việc còn lại trước khi xuất bản

1. Chủ sản phẩm duyệt hai bài, rồi thêm commit xuất bản.
2. Merge vào nhánh deploy và redeploy (chủ sản phẩm quyết). Lưu ý `main` chưa có `bd8d832`.
3. Sau deploy: gửi lại sitemap trong Search Console, URL Inspection cho `/blog` và hai bài.

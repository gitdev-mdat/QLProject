# Yêu cầu bàn giao cho Codex (Technical SEO và attribution)

Từ: nhánh `claude/blog-pilot`. Claude chỉ làm UI/UX và nội dung blog; không sửa backend, worker, robots, sitemap hay cấu hình chung. Các việc dưới đây cần Codex làm trên nhánh của Codex (`codex/technical-seo-foundation` hoặc nhánh khác).

## Đã kiểm tra trên production (2026-11-09, deployment d3af393)
- `https://qlead.vn/robots.txt` → 404.
- `https://qlead.vn/sitemap.xml` → 404.
- Root layout không có `metadataBase`, canonical, ảnh OG; `twitter:card = summary`.

## Blog đã cung cấp sẵn để nối vào
- `lib/blog/posts.ts` → `publishedBlogEntries(): { path, lastModified }[]`: chỉ trả bài `published`. Bản nháp không bao giờ có trong đây.
- `/blog` chỉ nên vào sitemap khi có ít nhất một bài `published` (`publishedBlogEntries().length > 0`).
- `app/blog/layout.tsx` đặt `metadataBase = https://qlead.vn` riêng cho blog. Khi root layout có `metadataBase`, có thể bỏ dòng này.
- Bản nháp có `robots: noindex, nofollow` và production (`VERCEL_ENV=production`) trả 404 cho bản nháp.
- Link từ blog về sản phẩm mang UTM `utm_source=qlead-blog&utm_medium=article&utm_campaign=<slug>&utm_content=<vị trí>`, và khi bấm thì lưu `localStorage['qlead.blogAttribution'] = { slug, position, at }`.

## Việc đề nghị Codex làm
| # | Việc | Ghi chú |
|---|---|---|
| 1 | `app/robots.ts`: cho phép `/`, `/blog`; chặn `/app`, `/admin`, `/api`; trỏ tới sitemap | `/dang-nhap`, `/dang-ky` nên dùng `noindex` thay vì chặn trong robots |
| 2 | `app/sitemap.ts`: `/` + `/blog` (khi có bài đăng) + `publishedBlogEntries()` | `lastModified` lấy từ entry |
| 3 | `metadataBase` ở root layout; canonical cho `/` | Không đổi giao diện Landing |
| 4 | Ảnh OG mặc định (1200×630) cho site và blog | Blog sẽ dùng chung, không cần ảnh riêng từng bài lúc đầu |
| 5 | Xác nhận redirect `www.qlead.vn` → `qlead.vn` (hoặc ngược lại) | |
| 6 | Attribution: thêm nguồn vào `landing_events` (đọc UTM hoặc `qlead.blogAttribution`) | Không lưu nội dung truy vấn, IP, UA (giữ nguyên chính sách hiện tại) |
| 7 | Attribution: lưu nguồn first-touch khi tạo tài khoản | Cần để đo North Star: đăng ký từ organic → tạo nhu cầu → mở lead trong 7 ngày |
| 8 | Đo lượt xem trang blog (Vercel Web Analytics hoặc sự kiện `blog_view`) và `blog_cta_clicked` | Chủ sản phẩm chọn công cụ |
| 9 | Search Console: xác minh Domain property, gửi sitemap; kiểm tra mục tính năng AI / báo cáo Generative AI | Việc của chủ sản phẩm, Codex hỗ trợ DNS nếu cần |

## Truy vấn kích hoạt (sau khi có cột nguồn)
Người dùng kích hoạt = đăng ký + tạo nhu cầu tìm (`agent_connections.kind = 'search_profile'`) + có `lead_source_opens.first_opened_at` trong 7 ngày kể từ khi đăng ký.

# Audit SEO kỹ thuật QLead — 22/11/2026

Phạm vi: production `https://qlead.vn`, repo `gitdev-mdat/QLProject`, Vercel project `qlead`. Kiểm tra bằng HTTP request trực tiếp (vài chục GET, không đăng nhập) và build local. Không có quyền Google Search Console.

## A. Tóm tắt

- **Production chỉ có đúng 1 URL được phép index: trang chủ.** Sitemap trên production chỉ chứa `https://qlead.vn`, nên Search Console báo "1 trang được phát hiện" là khớp chính xác, không phải lỗi đọc sitemap.
- **Blog chưa chạy trên production.** `/blog` và cả hai bài đều trả 404 + `noindex`. Code blog đã lên production (PR #21 merge vào `codex/technical-seo-foundation`, rồi vào `main` qua PR #22), nhưng cả hai bài vẫn `status: 'draft'`, và thiết kế cố ý ẩn bản nháp trên Vercel production.
- **Không tìm thấy lỗi kỹ thuật nào chặn crawl/index.** Robots, sitemap, canonical, chuyển hướng www/http, noindex cho trang đăng nhập/đăng ký/app/admin, 404 thật, HTML render từ server, JSON-LD đều đúng.
- **Nguyên nhân chính của việc gần như không có traffic organic là nội dung, không phải kỹ thuật:** site chỉ có một trang index được (~580 từ, chủ yếu là trang sản phẩm), domain mới (sitemap gửi 09/11), không có trang nào nhắm vào truy vấn có nhu cầu thực tế.
- **UNVERIFIED:** 19 lượt hiển thị đến từ truy vấn nào, Google đã index URL nào, canonical Google chọn (cần Search Console).

## B. Phát hiện

| ID | Vấn đề | Bằng chứng | Mức độ | Trạng thái | Hướng xử lý |
|---|---|---|---|---|---|
| SEO-01 | Chỉ 1 URL index được trên toàn site | `sitemap.xml` production chỉ có `<loc>https://qlead.vn</loc>`; `/blog`, `/blog/tim-quan-cafe-sap-khai-truong`, `/blog/tim-khach-hang-tiem-nang-tren-facebook` = 404 | Critical | CONFIRMED | Chủ sản phẩm duyệt và xuất bản 2 bài (đổi `status` + `publishedAt` trong `web/content/blog/*.tsx`) |
| SEO-02 | Hai bài blog vẫn là bản nháp | `status: 'draft'`, `publishedAt: null`, `reviewedBy: null` trong `web/content/blog/*.tsx` ở `main` 758ae72; `blogPreviewEnabled()` trả false khi `VERCEL_ENV=production` (`web/lib/blog/site.ts`) | Critical | CONFIRMED | Như trên; đây là quyết định biên tập, không phải lỗi code |
| SEO-03 | Trang chủ mỏng và chung chung cho truy vấn có nhu cầu | ~580 từ hiển thị, H1 "Tìm lead tự động trên Facebook", title nhắm "khách hàng tiềm năng từ Facebook cho đội sales" | High | LIKELY (vấn đề ranking) | Thêm trang nội dung nhắm theo nhu cầu; không sửa landing trong nhiệm vụ này |
| SEO-04 | `qlead.vercel.app` trả 200 cùng nội dung | `curl -I https://qlead.vercel.app/` = 200, canonical trỏ `https://qlead.vn` | Low | CONFIRMED | Canonical đã xử lý; có thể cấu hình redirect domain trong Vercel (thay đổi production, cần chủ sở hữu) |
| SEO-05 | Trang 404 dùng title trang chủ | `/blog` 404 có `<title>QLead — Khách hàng tiềm năng…` | Low | CONFIRMED | Không ảnh hưởng index (404 + noindex); không sửa |
| — | Robots | Cho phép `/`, chặn `/app`, `/admin`, `/api`, trỏ sitemap đúng; không chặn `/_next` | — | NOT AN ISSUE | — |
| — | Hostname | `www` và `http` → 308 về `https://qlead.vn/` | — | NOT AN ISSUE | — |
| — | Trang riêng tư | `/app`, `/admin`, `/bat-dau` 307 về đăng nhập/đăng ký; `/dang-nhap`, `/dang-ky` 200 + `noindex, nofollow` | — | NOT AN ISSUE | — |
| — | Metadata trang chủ | title, description, canonical, OG/Twitter 1200×630 (ảnh 200), `lang="vi"`, 1 H1, JSON-LD Organization + WebSite | — | NOT AN ISSUE | — |
| — | Render | HTML trả từ server có H1/H2 và nội dung chính; UA Googlebot giả lập nhận cùng 40 875 byte (giả lập UA không chứng minh Googlebot thật nhận như vậy) | — | NOT AN ISSUE | — |
| — | Preview deployments | URL deployment Vercel trả `X-Robots-Tag: noindex` + SSO | — | NOT AN ISSUE | — |
| — | Cơ chế sitemap khi xuất bản | Build local với 2 bài đổi sang `published` (tạm thời, đã hoàn tác): sitemap có 4 URL, `/blog` và bài 200, indexable, canonical đúng, BlogPosting + BreadcrumbList, bài ~1 850–2 450 từ render server, trang chủ hiện link "Cẩm nang" | — | NOT AN ISSUE | — |

## C. Thay đổi

- `web/e2e/seo-invariants.mjs` (mới): kiểm thử bất biến SEO chỉ đọc, chạy được với production hoặc build local. Kiểm tra robots, sitemap (XML hợp lệ, đúng origin, không trùng, không URL riêng tư, lastmod không bị đóng dấu "hôm nay"), mỗi URL trong sitemap 200/indexable/canonical tự trỏ, bài indexable phải có trong sitemap, bản nháp phải noindex và không có trong sitemap, trang chủ chỉ link `/blog` khi `/blog` tồn tại, trang riêng tư không index được, URL lạ trả 404.
- Không sửa code ứng dụng: không có lỗi kỹ thuật CONFIRMED nào cần sửa.

## D. QA

| Kiểm thử | Môi trường | Kết quả |
|---|---|---|
| `node e2e/seo-invariants.mjs https://qlead.vn` | Production (main 758ae72, dpl_HLEEVMCuAY2a9hnyNSe8V7ard9NQ) | 30/30 PASS |
| `tsc --noEmit` | Local | PASS |
| `npm run build` (`QLEAD_BLOG_PREVIEW=0`) | Local | PASS |
| seo-invariants, chế độ production | Local build | PASS, sitemap 1 URL |
| seo-invariants, 2 bài giả lập `published` | Local build (đã hoàn tác) | 44/44 PASS, sitemap 4 URL |
| seo-invariants, chế độ preview (`QLEAD_BLOG_PREVIEW=1`) | Local build | PASS với `--expect-drafts`; không có cờ thì FAIL đúng 2 kiểm tra rò rỉ bản nháp |
| ESLint | — | Không áp dụng: repo không có cấu hình ESLint |

Ghi chú: `next build` và `npm audit` báo Next.js 16.4.3 có các advisory mức moderate (bản sửa 16.4.6). Ngoài phạm vi SEO, nên xử lý riêng.

## E. Việc chủ sở hữu cần làm trên Google

1. Search Console → Performance: xem tab Queries và Pages cho 19 lượt hiển thị (thương hiệu hay không).
2. Indexing → Pages: xác nhận trang chủ đã "Indexed"; URL Inspection cho `https://qlead.vn/`.
3. Sau khi xuất bản bài: URL Inspection + Request indexing cho `/blog` và từng bài. Không cần gửi lại sitemap; Google đọc lại `sitemap.xml` cùng địa chỉ.

## F. Bàn giao

- Branch `claude/seo-audit-20261122` (từ `main` 758ae72), chỉ thêm script kiểm thử và báo cáo này.
- Production không thay đổi, chưa merge, chưa deploy.

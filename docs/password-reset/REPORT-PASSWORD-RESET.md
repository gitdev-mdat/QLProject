# Quên mật khẩu (đặt lại mật khẩu qua email)

Nhánh `claude/forgot-password` · migration `026_password_resets.sql` (chỉ thêm bảng) · chưa chạy trên Production.

## Luồng cho khách

1. Trang **Đăng nhập** có link **"Quên mật khẩu?"** ngay dưới ô mật khẩu.
2. `/quen-mat-khau`: khách nhập email đã đăng ký, bấm "Gửi link đặt lại mật khẩu". Màn hình luôn trả lời giống nhau:
   "Nếu <email> có tài khoản QLead, chúng tôi vừa gửi link đặt lại mật khẩu. Link dùng được một lần và hết hạn sau 30 phút."
   Có nhắc xem thư mục Spam, nút "Gửi lại email" (chờ 60 giây giữa hai lần) và "Dùng email khác".
3. Email tiếng Việt "Đặt lại mật khẩu QLead" có nút "Đặt mật khẩu mới" và link dự phòng.
4. Link mở `/dat-lai-mat-khau?ma=…`: hai ô "Mật khẩu mới" và "Nhập lại mật khẩu mới" (ít nhất 8 ký tự, báo ngay nếu chưa khớp).
5. Lưu xong: QLead đăng xuất tài khoản trên mọi thiết bị và chuyển về Đăng nhập với thông báo "Đã đổi mật khẩu. Hãy đăng nhập bằng mật khẩu mới."
6. Link hết hạn, đã dùng, hoặc đã có link mới hơn: trang "Link không còn dùng được" với nút "Gửi link mới".

## Bảo mật

- **Không lộ email có tài khoản hay không**: API `POST /api/auth/forgot-password` luôn trả `202 {"ok":true}`. Việc tìm tài khoản, tạo link và gửi email chạy *sau* khi đã trả lời (`after()` của Next), nên thời gian phản hồi cũng không khác nhau.
- **Link an toàn**: token ngẫu nhiên 32 byte; DB chỉ lưu SHA-256. Hết hạn sau **30 phút**. **Dùng một lần**: tiêu link là một câu `UPDATE … WHERE used_at IS NULL AND expires_at > now()`, nên hai tab bấm cùng lúc chỉ một tab thành công (đã test 4 yêu cầu song song).
- Gửi link mới làm link cũ hết tác dụng. Đổi mật khẩu xong thì mọi link còn lại cũng hết tác dụng.
- Đổi mật khẩu thu hồi **mọi phiên đăng nhập** của tài khoản (và xoá đăng ký Web Push gắn với các phiên đó).
- Link trong email luôn dùng `QLEAD_PUBLIC_URL` (mặc định `https://qlead.vn`), không lấy từ header Host, để không ai chèn tên miền giả vào email thật.
- Trang đặt lại có `<meta name="referrer" content="no-referrer">` và xoá `?ma=` khỏi thanh địa chỉ ngay khi mở.
- Giới hạn: mỗi tài khoản tối đa **3 link/giờ** (lưu trong DB, vượt thì im lặng không gửi, trả lời vẫn giống hệt). Thêm giới hạn trong bộ nhớ: 5 yêu cầu/giờ mỗi email, 10/giờ mỗi IP, 20 lần đặt mật khẩu/15 phút mỗi IP. Cả hai API kiểm tra Origin cùng nguồn.
- Bảng `password_reset_tokens` bật RLS và REVOKE quyền anon/authenticated/service_role như các bảng tài khoản khác; xoá tài khoản thì link bị xoá theo.

## Gửi email: cần cấu hình

QLead **chưa có dịch vụ gửi email** trước thay đổi này. Tôi dùng **Resend** qua HTTP API (chỉ `fetch`, không thêm thư viện). Cần đặt trên Vercel (môi trường Production) cho web app:

| Biến | Giá trị |
|---|---|
| `RESEND_API_KEY` | API key tạo trong Resend |
| `MAIL_FROM` | ví dụ `QLead <no-reply@qlead.vn>` (tên miền `qlead.vn` phải được xác minh trong Resend: thêm các bản ghi DNS SPF/DKIM mà Resend cung cấp) |
| `QLEAD_PUBLIC_URL` | không bắt buộc, mặc định `https://qlead.vn` |

Khi chưa cấu hình: `next dev` in email ra console để thử ở máy; bản production ghi lỗi `[mail] Not sent…` (không ghi email hay nội dung) và không gửi gì, khách vẫn thấy màn hình xác nhận như bình thường. Muốn dùng nhà cung cấp khác (SMTP, SendGrid…) chỉ cần đổi `web/lib/server/mailer.ts`.

## Tệp thay đổi

- `migrations/026_password_resets.sql`, `src/cli.ts` (thêm vào danh sách migrate)
- `src/password-reset.ts`: tạo, kiểm tra, tiêu link
- `web/lib/server/mailer.ts`, `web/lib/server/password-reset.ts`, `web/lib/auth-rate-limit.ts`
- `web/app/api/auth/forgot-password`, `web/app/api/auth/reset-password`
- `web/app/quen-mat-khau`, `web/app/dat-lai-mat-khau`, `web/components/password-reset-forms.tsx`
- `web/components/auth-screen.tsx`: tách khung `AuthShell` dùng chung, thêm link "Quên mật khẩu?" và thông báo đã đổi mật khẩu
- `web/app/globals.css`

## Kiểm thử

- `npm test` (PostgreSQL 16 cô lập): **164 đạt, 0 lỗi**, 5 bỏ qua có sẵn. Mới: `test/password-reset.test.ts` (email lạ, chuẩn hoá email, chỉ lưu hash, link mới thay link cũ, hết hạn, giới hạn 3/giờ, dùng một lần, thu hồi phiên chỉ của đúng tài khoản, 4 yêu cầu song song chỉ 1 thắng, xoá tài khoản) và thêm ca giới hạn trong `test/auth-rate-limit.test.ts`.
- `web/e2e/password-reset-e2e.mts` trên bản production (`next start`) + Chromium + DB test + mock API Resend: **13/13 đạt** (kết quả trong `password-reset-e2e-results.txt`).
- `tsc --noEmit` (backend và web) sạch, `next build` thành công.

## Ảnh chụp (`screenshots/`)

`login-forgot-link-1440/390`, `forgot-1440/390`, `forgot-sent-1440/390`, `email-preview`, `reset-1440/390`, `reset-mismatch-1440`, `login-password-changed-1440`, `reset-link-used-1440`, `reset-link-invalid-390`.

## Cần owner làm

1. Tạo tài khoản Resend, xác minh tên miền `qlead.vn`, đặt `RESEND_API_KEY` và `MAIL_FROM` trên Vercel Production.
2. Review và merge PR.
3. Chạy migration 026 trên Production: `npx tsx ops/production-db.ts check`, `migrate`, `verify`. Nếu deploy code trước migration, yêu cầu quên mật khẩu chỉ ghi lỗi vào log và không gửi email; đăng nhập không bị ảnh hưởng.

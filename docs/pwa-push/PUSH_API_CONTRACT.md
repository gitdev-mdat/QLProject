# QLead Web Push — API contract cho Codex (F03)

Frontend (PR PWA/push của Claude) gọi đúng các endpoint dưới đây. Frontend **không** tạo file nào trong `web/app/api/push/**`, `src/**` hay `migrations/**` — phần đó là của Codex.

Tất cả endpoint: chạy trong Next.js (`web/app/api/push/...`), cần session cookie `qlead_session` (dùng `getSession()`), request thay đổi trạng thái phải qua `isSameOrigin()`. Trả JSON, `Cache-Control: no-store`.

## 1. `GET /api/push/config`
- `200 { "enabled": true, "vapidPublicKey": "<base64url, uncompressed P-256, 87 ký tự>" }`
- `200 { "enabled": false }` khi server chưa có VAPID key (frontend sẽ hiện "Thông báo chưa sẵn sàng", không lỗi).
- `401 { "error": "unauthorized" }` khi chưa đăng nhập.

## 2. `PUT /api/push/subscription` — đăng ký / làm mới thiết bị này
Body:
```json
{
  "subscription": { "endpoint": "https://…", "expirationTime": null, "keys": { "p256dh": "…", "auth": "…" } },
  "platform": "ios" | "android" | "desktop" | "other",
  "standalone": true,
  "origin": "https://qlead.vercel.app"
}
```
- Upsert theo `endpoint` (unique). Nếu endpoint đang thuộc user khác → **chuyển sang user hiện tại** (người đăng nhập sau cùng trên thiết bị đó sở hữu nó).
- Validate: `endpoint` là `https:` URL ≤ 2048 ký tự; `p256dh`, `auth` là base64url; payload ≤ 4 KB.
- `200 { "subscribed": true }`
- `400 { "error": "invalid_request" }`, `401`, `403 { "error": "forbidden" }` (khác origin), `503 { "error": "push_not_configured" }`.
- Frontend gọi lại endpoint này mỗi lần mở app nếu trình duyệt đã có subscription (idempotent, để tự sửa khi key/endpoint đổi).

## 3. `POST /api/push/subscription/status`
Body `{ "endpoint": "https://…" }` → `200 { "subscribed": boolean }`.
`true` chỉ khi endpoint đang active **và thuộc user hiện tại**. Frontend dùng để hiện đúng trạng thái Bật/Tắt sau khi đổi tài khoản.

## 4. `DELETE /api/push/subscription`
Body `{ "endpoint": "https://…" }` → `200 { "subscribed": false }`. Idempotent. Chỉ xoá nếu thuộc user hiện tại (nếu không: vẫn 200, không làm gì).
Frontend gọi khi người dùng bấm "Tắt thông báo" **và trước khi đăng xuất** (sau đó tự `pushSubscription.unsubscribe()` trên trình duyệt).

## 5. `POST /api/push/test`
Body `{ "endpoint": "https://…" }` → gửi 1 push thử **chỉ tới thiết bị này** (endpoint phải thuộc user hiện tại).
- `202 { "sent": true }`
- `404 { "error": "not_subscribed" }` → frontend coi như thiết bị chưa đăng ký.
- `429 { "error": "too_many_requests", "retryAfterSeconds": 30 }` (gợi ý: 1 lần / 30 giây / user).
- `502 { "error": "push_failed" }` (push service lỗi tạm thời).

## 6. Preferences
Phase 1 không cần endpoint preferences riêng: **bật = thiết bị có subscription active**. Nếu Codex vẫn làm `GET/PUT /api/push/preferences { "newLeads": boolean }` thì frontend chưa dùng ở phase này.

## 7. Payload push (JSON, mã hoá aes128gcm theo RFC 8291, VAPID RFC 8292)
```json
{
  "v": 1,
  "kind": "new_leads",
  "title": "QLead tìm thấy 5 cơ hội mới",
  "body": "Quán F&B sắp khai trương — Nhấn để xem bài Facebook mới.",
  "url": "/app/bai-viet",
  "tag": "new-leads",
  "count": 5
}
```
- `kind`: `"new_leads"` hoặc `"test"` (test: title `"QLead"`, body `"Thông báo đã bật trên thiết bị này."`, url `"/app"`).
- `url`: **đường dẫn tương đối bắt đầu bằng `/app`**. 1 lead → `/app/bai-viet/<leadId>`; nhiều lead → `/app/bai-viet`. Service worker từ chối mọi URL khác và rơi về `/app/bai-viet`.
- `tag`: cùng tag thì thông báo mới thay thông báo cũ (gom nhóm). Dùng `"new-leads"`.
- Headers khi gửi: `TTL: 43200` (12 giờ), `Urgency: normal`, `Topic: new-leads`.
- Riêng tư: body chỉ nêu loại tín hiệu/ngành (vd "Quán F&B sắp khai trương"), **không** có tên người đăng, SĐT, nội dung bài, email hay tên khách hàng của user.

## 8. Gửi khi có lead mới (new-lead delivery)
- Gom theo **lượt quét**: khi 1 lượt quét của user lưu ≥1 lead mới đủ điều kiện → 1 push cho tất cả subscription active của user đó, `count` = số lead mới của lượt.
- Giới hạn: tối đa 1 push / user / 15 phút; lead phát sinh trong khoảng chờ cộng dồn vào push kế tiếp.
- Không gửi cho user `lead_monitoring_status = 'suspended'` hay user đã xoá.
- Push service trả `404`/`410` → xoá subscription. `429`/`5xx` → retry có backoff, tối đa 3 lần.
- Không chặn pipeline quét nếu gửi push lỗi.

## 9. Lưu trữ & bảo mật
- Bảng gợi ý `web_push_subscriptions(id, user_id FK ON DELETE CASCADE, endpoint UNIQUE, p256dh, auth, platform, standalone, origin, created_at, updated_at, last_success_at, last_failure_at, failure_count)`.
- Env server-only: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (vd `mailto:…`). **Không** dùng `NEXT_PUBLIC_*` cho private key. Public key được trả qua `/api/push/config`.
- Xoá user (admin) → xoá subscription của user đó.
- Không log `p256dh`/`auth`/endpoint đầy đủ.

## 10. Đổi domain (qlead.vercel.app → qlead.vn)
Subscription gắn với origin. Giữ **cùng cặp VAPID key** cho cả 2 domain. Khi đổi domain, subscription của origin cũ vẫn nhận push cho tới khi user mở app ở domain mới; frontend ở domain mới tự hiện thẻ "Bật lại thông báo". Backend lưu `origin` (chỉ chấp nhận origin trong allowlist, vd `https://qlead.vercel.app`, `https://qlead.vn`): khi user đã có subscription active ở origin mới thì **ngừng gửi** tới subscription origin cũ của user đó để tránh nhận 2 lần. Sau ~30 ngày có thể xoá subscription có endpoint không còn được làm mới (`updated_at` cũ).

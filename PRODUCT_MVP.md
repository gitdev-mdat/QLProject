# QLead — Product & UI MVP plan

## 1. Product summary

QLead helps Vietnamese shop owners find Facebook posts that signal buying intent. A user connects Muse and Facebook once, describes the customers they want with keywords, an area, and sources, then reviews relevant posts in one clear inbox. The product should make the collection status and next action obvious without exposing backend terms.

**MVP promise:** “Nhập điều bạn đang tìm. QLead gom bài đăng phù hợp để bạn chủ động kết nối khách hàng.” Start with a single user workspace, one or more scan filters, a collected-post inbox, saved/read states, and a simple connection checklist.

## 2. Information architecture and sitemap

```text
Public
├── Trang chủ /
├── Đăng nhập /dang-nhap
└── Tạo tài khoản /dang-ky

Signed-in app
├── Tổng quan /app
├── Bài viết /app/bai-viet
│   └── Chi tiết bài /app/bai-viet/[id]
├── Bộ lọc /app/bo-loc
├── Kết nối /app/ket-noi
└── Hướng dẫn bắt đầu /bat-dau
```

## 3. Core user flow

```text
Landing → Đăng ký → Chào mừng → Kết nối Muse → Kết nối Facebook
       → Tạo bộ lọc đầu tiên → Hoàn tất → Tổng quan
Tổng quan → Bài viết → Lọc / tìm → Mở chi tiết → Mở bài gốc / lưu bài
Tổng quan → Bộ lọc → Thêm từ khóa / khu vực / nguồn / tần suất → Bật quét
Tổng quan → Kết nối → Kiểm tra trạng thái / xem hướng dẫn khắc phục
```

## 4. Visual direction

Use a warm ivory canvas, ink-green text, leaf-green actions, and a small marigold accent. The visual anchor is a clean, geometric lucky-cat mascot: cream body, green collar, one raised paw, and a tiny gold coin. Use it as a helpful guide in onboarding, empty, and success states; keep it compact in navigation. Pair friendly Vietnamese copy with clear hierarchy, generous spacing, rounded cards, and small status labels. Avoid dense tables, dark surfaces, and decorative “AI” gradients.

**Name options considered:** QLead is the official product name. Mèo Hút Khách and Lộc Lead were early alternatives; keep the Muse connector name for the existing integration.

## 5. Design system

- **Typography:** Inter/system sans. Display 40/48 desktop, 32/38 mobile; page title 28/34; section title 18/26; body 14/22; helper 12/18.
- **Palette:** cream `#F8F7F2`, white `#FFFFFF`, ink `#1F342C`, muted `#718078`, leaf `#3F795C`, leaf tint `#EAF2EB`, gold `#F2C66D`, gold tint `#FFF5DC`, line `#E8EAE3`, error `#B94C43`.
- **Spacing:** 4 px base; use 8/12/16/24/32/48/64 px. Main content max width 1200 px.
- **Buttons:** 44 px minimum height, 12 px radius; primary leaf fill, secondary white/line, quiet text button. Clear hover/focus/disabled states.
- **Inputs:** 46 px height, 10 px radius, visible label above, helper below; avoid placeholder-only labels.
- **Cards:** white surface, 16 px radius, 1 px line, subtle shadow only on elevated/hovered cards.
- **Status badges:** compact icon + text, pale semantic background, never rely on color alone.
- **Empty states:** mascot illustration, one sentence describing what is missing, one direct next action.
- **Mascot rules:** use one simple pose at a time; keep facial details sparse; use raised paw for welcome/success, sitting pose for no results, no mascot inside dense result rows.

## 6. Page wireframes

### Landing
Top bar [logo + nav + sign in + create account] → Hero [benefit headline + short explanation + CTA] [mascot + sample post inbox card] → three numbered steps → benefits → dashboard preview → short FAQ → CTA/footer.

### Sign in / register
Split page: left warm panel with mascot and one reassurance; right compact form with clear labels, password visibility, primary action, and link to the other auth screen.

### Onboarding
Progress bar and step count → one task per screen → short instruction card → mascot helper → back/continue. Connection steps show “how to connect” with a copyable setup value only if the product API later supports secure credential provisioning. MVP demo has explicit mock controls.

### Dashboard / post inbox
Persistent sidebar → greeting and “thêm bộ lọc” action → four summary cards → search and filter row → readable post cards with author, age, source, excerpt, keywords, save state, and original-link action. Empty, loading, and error variants reuse the same layout.

### Filters
Page heading and explanatory copy → list of saved filter cards with status/toggle → add/edit form for keywords, region, sources, frequency → save confirmation.

### Connections
Connection status cards for Muse and Facebook → plain-language setup steps → last sync and recent scan summary → check status action and helpful recovery copy.

### Post detail
Breadcrumb and back link → post summary with author/time/source → matched terms and saved/read state → original post action → related filter context.

## 7. Frontend structure proposal

Keep the Next.js app under `web/` so it remains independent of the existing Fastify bridge. Suggested boundaries: `app/` routes and layouts, `components/` reusable shell/cards/mascot, `lib/api/` typed client and adapter interface, `lib/demo-data.ts` clearly labeled mock data. The first UI uses a demo adapter; later a production adapter can call a user-facing Fastify API without changing page components. The existing agent-token endpoints are intentionally not called from browser code.

## 8. Current implementation boundary

The repo contains only the Muse agent bridge. Its API has no end-user auth, user CRUD, or browser-safe post endpoints. This MVP implements the navigation and main page states on mock data; real account creation, OAuth/Facebook connection, persistence, and live post retrieval require user-facing backend endpoints and an authentication decision.

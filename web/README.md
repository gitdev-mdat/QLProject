# QLead web

Next.js frontend for QLead. It does not change the Fastify Muse bridge. Design rationale, audit and backend requests: `../UX_REDESIGN.md`.

## Run locally

```powershell
cd web
npm install
npm run dev
```

Open `http://localhost:3000`. `npm run build` + `npm start` for production. To verify a build while another `next start` is serving `.next`, set `QLEAD_DIST_DIR=.next-verify` for the build.

## Routes

- `/` landing page with the interactive lead demo
- `/dang-nhap`, `/dang-ky` preview auth screens (nothing is sent or stored)
- `/bat-dau` onboarding (3 steps)
- `/app` Hôm nay: unseen leads, newest first
- `/app/bai-viet` lead list with detail panel; `/app/bai-viet/[id]` lead detail
- `/app/bo-loc` search intent builder
- `/app/ket-noi` connection status (never shows "connected" without a real check)

## Demo boundary

Sample leads live in `lib/demo-data.ts` (fictional names, 0900 000 xxx numbers, no Facebook URLs) and go through the same `toLeadRecord` extraction as real data. Seen/saved marks are stored in this browser only (`lib/lead-state.ts`). The bridge exposes agent-token routes only, so never pass Muse agent tokens to this frontend; implement the user-authenticated API described in `../UX_REDESIGN.md` §11 and switch to `HttpLeadAdapter`.

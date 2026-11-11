# QLead Blog technical contract

Claude owns Blog UI and editorial content. Codex owns technical metadata, crawl controls, sitemap integration, and first-party measurement. The Blog files from `claude/blog-pilot` are integrated in this branch.

## Publishing and indexing

- `web/lib/blog/posts.ts` is the source of truth. `publishedBlogEntries()` returns only published posts with their `lastModified` date.
- `web/app/sitemap.ts` always lists `/`, and lists `/blog` only when at least one published article exists. Published articles use the entry's `lastModified`. Drafts never enter the sitemap.
- Drafts are preview-only, carry `noindex, nofollow`, and are unavailable when `VERCEL_ENV=production`. The index returns 404 in production while there are no published articles.
- `/blog` and article pages use the shared root `metadataBase` and the default 1200×630 QLead social image. Article canonical URLs and structured data stay in the Blog route.
- `web/app/robots.ts` allows public pages and disallows `/app`, `/admin`, and `/api`. Authentication pages use `noindex` metadata.

## Attribution and analytics

The Blog CTA links include `utm_source=qlead-blog`, `utm_medium=article`, `utm_campaign=<slug>`, and `utm_content=<position>`. Clicking a CTA keeps `qlead.blogAttribution` in local storage and emits `blog_cta_clicked`. The Blog layout emits `blog_view` with the public pathname. These use the existing `/api/landing/events` endpoint and `landing_events` table.

Attribution records only a coarse source (`organic`, `blog`, `campaign`, `referral`, `direct`, or `unknown`), a validated campaign slug, a validated content position, and a public Blog pathname for Blog events. First-touch values are saved on account creation in `users.first_touch_*`. Search text, full referrer URLs, query strings, IP addresses, and User-Agent values are not persisted as attribution data.

The first-touch source is a browser-level signal. Organic referrals are inferred from supported search-engine referrer hosts; this does not identify search queries or provide Google's per-user attribution. Use aggregate Search Console reports for query and landing-page performance.

## Activated-user report

`docs/attribution-activation.sql` counts registered users by first-touch channel whose account has a search profile and whose first lead-source open occurred in the seven days after registration. The report uses completed signup cohorts only.


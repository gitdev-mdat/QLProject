# QLead technical SEO operations

## Search Console setup (product owner)

1. Add the **Domain property** `qlead.vn` in Google Search Console to cover HTTP/HTTPS and `www`/apex.
2. Verify ownership with Google's TXT record at the authoritative DNS provider. The owner should make this change; do not share DNS credentials.
3. After deployment, submit `https://qlead.vn/sitemap.xml` under **Indexing → Sitemaps**.
4. Inspect `https://qlead.vn/` and a published Blog URL with URL Inspection; confirm fetch/render and Google's selected canonical after recrawl.
5. Review sitemap processing, **Indexing → Pages**, crawl stats, and **Performance → Search results (Web)**.
6. Review **Experience → Core Web Vitals** when field data exists. No field data is not a passing score.
7. In Search Console settings, check Search generative AI features and any available AI performance report. Google's AI search features use ordinary Search eligibility; there is no special AI schema or `llms.txt` requirement. Inclusion is not guaranteed. See [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features), [AI optimization guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide), and [Search content controls](https://developers.google.com/search/docs/crawling-indexing/control-what-you-share).

## Crawl and canonical behavior

- `https://qlead.vn` is the canonical host. Production currently redirects `https://www.qlead.vn/` to it with HTTP 308. HTTP apex also redirects to HTTPS apex.
- `robots.txt` allows public pages, disallows `/app`, `/admin`, and `/api`, and points to the sitemap. Login and registration are crawlable but carry `noindex`; robots exclusions are not security controls.
- The sitemap includes `/` and, only when published articles exist, `/blog` and each URL from `publishedBlogEntries()` with its last-modified date. It does not list drafts or private routes.
- Root metadata supplies the canonical origin and the default 1200×630 Open Graph/Twitter image to the homepage and Blog pages.

## Attribution

Migration `024_seo_attribution.sql` adds bounded attribution fields to `landing_events` and first-touch fields to `users`. The payload contains a coarse source and validated campaign/content labels only. It does not save query text, full referrer URLs, IP addresses, or User-Agent values.

Use `docs/attribution-activation.sql` for the seven-day activated-user report. Browser-side organic attribution is inferred from a supported search-engine referrer and cannot replace aggregate Search Console reporting.


// SEO invariants: read-only HTTP checks for robots.txt, sitemap.xml and the indexability of public and private routes.
// Safe against production (a handful of GET requests, no login, no writes).
//
// Usage: node e2e/seo-invariants.mjs <baseUrl> [--expect-drafts]
//   baseUrl          server to check, e.g. https://qlead.vn or http://127.0.0.1:3090
//   --expect-drafts  the server was built with drafts visible (QLEAD_BLOG_PREVIEW=1); drafts must then be noindex
//
// Canonical URLs are always https://qlead.vn, so on a local server they are compared by path.
const args = process.argv.slice(2);
const base = (args.find(a => !a.startsWith('--')) ?? 'http://127.0.0.1:3090').replace(/\/$/, '');
const expectDrafts = args.includes('--expect-drafts');
const ORIGIN = 'https://qlead.vn';
const UA = 'Mozilla/5.0 (compatible; QLead-SEO-check/1.0)';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function get(path) {
  const res = await fetch(base + path, { redirect: 'manual', headers: { 'user-agent': UA } });
  const body = await res.text();
  return { status: res.status, location: res.headers.get('location'), xRobots: res.headers.get('x-robots-tag'), type: res.headers.get('content-type') ?? '', body };
}

const metaRobots = html => html.match(/<meta name="robots" content="([^"]*)"/)?.[1] ?? null;
const canonical = html => html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? null;
const title = html => html.match(/<title>([^<]*)<\/title>/)?.[1] ?? null;
const noindex = page => /noindex/i.test(metaRobots(page.body) ?? '') || /noindex/i.test(page.xRobots ?? '');
const pathOf = url => { const u = new URL(url); return u.pathname === '/' ? '/' : u.pathname.replace(/\/$/, ''); };

// 1. robots.txt
const robots = await get('/robots.txt');
check('robots.txt is 200 text/plain', robots.status === 200 && robots.type.startsWith('text/plain'), `${robots.status} ${robots.type}`);
check('robots.txt points to the production sitemap', robots.body.includes(`Sitemap: ${ORIGIN}/sitemap.xml`));
check('robots.txt does not block the whole site', !/^Disallow:\s*\/\s*$/m.test(robots.body));
for (const path of ['/app', '/admin', '/api']) check(`robots.txt disallows ${path}`, new RegExp(`^Disallow: ${path}$`, 'm').test(robots.body));
check('robots.txt does not block /_next assets', !/^Disallow: \/_next/m.test(robots.body));

// 2. sitemap.xml
const sitemap = await get('/sitemap.xml');
check('sitemap.xml is 200 XML', sitemap.status === 200 && /xml/.test(sitemap.type), `${sitemap.status} ${sitemap.type}`);
check('sitemap.xml is a urlset', sitemap.body.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
const locs = [...sitemap.body.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
console.log(`     sitemap URLs (${locs.length}): ${locs.join(', ')}`);
check('sitemap lists the homepage', locs.includes(ORIGIN) || locs.includes(`${ORIGIN}/`));
check('sitemap uses only the canonical origin', locs.every(loc => loc === ORIGIN || loc.startsWith(`${ORIGIN}/`)));
check('sitemap has no duplicate URLs', new Set(locs.map(pathOf)).size === locs.length);
check('sitemap has no private routes', locs.every(loc => !/^\/(app|admin|api|dang-nhap|dang-ky|bat-dau|mo)(\/|$)/.test(pathOf(loc))));
const today = new Date().toISOString().slice(0, 10);
const lastmods = [...sitemap.body.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)].map(m => m[1].slice(0, 10));
check('sitemap lastmod is not stamped with today on every URL', !(lastmods.length > 1 && lastmods.every(d => d === today)), lastmods.join(', '));

// 3. Every sitemap URL answers 200 directly, is indexable and canonical to itself.
for (const loc of locs) {
  const path = pathOf(loc);
  const page = await get(path);
  const canon = canonical(page.body);
  check(`${path} is 200 without redirect`, page.status === 200, `${page.status}${page.location ? ` → ${page.location}` : ''}`);
  check(`${path} is indexable`, !noindex(page), `meta robots=${metaRobots(page.body)} x-robots-tag=${page.xRobots}`);
  check(`${path} canonical points to itself`, canon !== null && pathOf(canon) === path, String(canon));
  check(`${path} has a title`, Boolean(title(page.body)), String(title(page.body)));
}

// 4. Blog: /blog is listed exactly when it serves indexable content; posts it links to are consistent with the sitemap.
const blog = await get('/blog');
const blogListed = locs.some(loc => pathOf(loc) === '/blog');
const postLinks = [...new Set([...blog.body.matchAll(/href="\/blog\/([a-z0-9-]+)"/g)].map(m => `/blog/${m[1]}`))];
if (blog.status === 404) {
  check('/blog 404 is not in the sitemap and no post is listed', !blogListed && !locs.some(loc => pathOf(loc).startsWith('/blog/')));
} else {
  check('/blog is 200', blog.status === 200, String(blog.status));
  for (const path of postLinks) {
    const post = await get(path);
    const listed = locs.some(loc => pathOf(loc) === path);
    if (noindex(post)) {
      check(`${path} (draft/noindex) is not in the sitemap`, !listed);
      check(`${path} draft is only served on a preview build`, expectDrafts, 'a noindex article was served by a build that should hide drafts');
    } else {
      check(`${path} (indexable) is in the sitemap`, listed);
    }
  }
  if (noindex(blog)) check('/blog (noindex) is not in the sitemap', !blogListed);
  else check('/blog (indexable) is in the sitemap', blogListed);
}

// 5. Homepage links to the guide only when /blog exists, never to a 404.
const home = await get('/');
const homeLinksBlog = /href="\/blog"/.test(home.body);
check('homepage links to /blog only when /blog answers 200', homeLinksBlog === (blog.status === 200), `link=${homeLinksBlog} /blog=${blog.status}`);
check('homepage is lang="vi"', /<html lang="vi"/.test(home.body));
check('homepage has exactly one <h1>', (home.body.match(/<h1[\s>]/g) ?? []).length === 1);
check('homepage has Organization/WebSite JSON-LD', /"@type":"Organization"/.test(home.body) && /"@type":"WebSite"/.test(home.body));

// 6. Private and account routes are never indexable: they redirect to login or carry noindex.
for (const path of ['/app', '/admin', '/dang-nhap', '/dang-ky', '/bat-dau']) {
  const page = await get(path);
  const redirected = page.status >= 300 && page.status < 400;
  check(`${path} is not indexable`, redirected || page.status >= 400 || noindex(page), `${page.status}${page.location ? ` → ${page.location}` : ''} robots=${metaRobots(page.body)}`);
}

// 7. Unknown URLs are real 404s, not soft 404s.
const missing = await get('/khong-ton-tai-seo-check');
check('unknown URL returns 404', missing.status === 404, String(missing.status));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll SEO invariants hold');
process.exit(failed ? 1 : 0);

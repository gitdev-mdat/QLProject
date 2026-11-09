// Blog launch QA: header/footer "Cẩm nang" link, /blog and article at 1440/768/390, no horizontal page scroll.
// Usage: node e2e/blog-launch-qa.mjs <baseUrl> <outDir>
import { chromium } from 'playwright-core';
const [base = 'http://127.0.0.1:3022', out = '../docs/blog-launch-20261109/screenshots'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const pages = [['landing', '/'], ['blog', '/blog'], ['cafe', '/blog/tim-quan-cafe-sap-khai-truong'], ['pillar', '/blog/tim-khach-hang-tiem-nang-tren-facebook']];
const widths = [1440, 768, 390];
let failed = 0;
for (const width of widths) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  for (const [name, path] of pages) {
    await page.goto(base + path, { waitUntil: 'networkidle' });
    const m = await page.evaluate(() => {
      const nav = document.querySelector('.site-nav');
      const navLink = [...document.querySelectorAll('.site-nav nav a')].find(a => a.textContent === 'Cẩm nang');
      const footLink = [...document.querySelectorAll('footer a')].find(a => a.textContent === 'Cẩm nang');
      const cta = document.querySelector('.site-nav-actions .btn-primary');
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        navHeight: nav ? nav.getBoundingClientRect().height : null,
        navLinkVisible: navLink ? navLink.getBoundingClientRect().width > 0 && getComputedStyle(navLink.parentElement).display !== 'none' : null,
        footLink: Boolean(footLink),
        ctaRight: cta ? Math.round(window.innerWidth - cta.getBoundingClientRect().right) : null,
        bodyFont: getComputedStyle(document.querySelector('.blog-prose p') || document.body).fontSize,
      };
    });
    const ok = m.overflow <= 0 && m.footLink;
    if (!ok) failed++;
    console.log(width, name, JSON.stringify(m), ok ? 'OK' : 'FAIL');
    await page.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: false });
  }
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);

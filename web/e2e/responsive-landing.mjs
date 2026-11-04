// Responsive audit of the public landing page in real Chrome.
// Usage: node e2e/responsive-landing.mjs [baseUrl]   (default http://127.0.0.1:3011)
// Env: SHOT_DIR (screenshots + report.json, default e2e/screenshots/responsive), LABEL (filename prefix, default "after"),
//      SWEEP_ONLY=1 skips screenshots and interaction checks.
// Read-only: it only loads "/" and clicks in-page controls of the demo.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3011';
const SHOTS = resolve(process.env.SHOT_DIR ?? 'e2e/screenshots/responsive');
const LABEL = process.env.LABEL ?? 'after';
mkdirSync(SHOTS, { recursive: true });

const presets = [280, 320, 344, 360, 375, 390, 393, 412, 414, 430, 440, 480, 540, 600, 720, 768, 820, 834, 912, 1024, 1152, 1280, 1366, 1440, 1536, 1920, 2560];
// Every 4px through phones/tablets (where content reflows), every 16px above.
const sweep = [...new Set([
  ...Array.from({ length: (1024 - 280) / 4 + 1 }, (_, i) => 280 + i * 4),
  ...Array.from({ length: Math.floor((2560 - 1024) / 16) + 1 }, (_, i) => 1024 + i * 16),
  ...presets,
])].sort((a, b) => a - b);
const heightFor = width => width < 600 ? Math.round(width * 2.17) : width < 1024 ? Math.round(width * 1.33) : Math.round(width * .5625);

const results = [];
function record(group, name, pass, detail = '') { results.push({ group, name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} [${group}] ${name}${detail ? ` — ${detail}` : ''}`); }

/** Runs in the page: returns every layout problem at the current viewport. */
function audit() {
  const vw = document.documentElement.clientWidth;
  const problems = [];
  const describe = el => {
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}${text ? ` "${text}"` : ''}`;
  };
  // Decorations that are meant to bleed out of a clipping section.
  const decorative = el => el.closest('.cta-glow');
  const shown = el => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const ownText = el => [...el.childNodes].some(node => node.nodeType === 3 && node.textContent.trim());
  const meaningful = el => ownText(el) || el.matches('a, button, input, textarea, select, svg, img, .btn');

  if (document.documentElement.scrollWidth > vw) problems.push(`document scrollWidth ${document.documentElement.scrollWidth} > clientWidth ${vw}`);

  const all = [...document.body.querySelectorAll('*')].filter(el => !el.closest('svg') || el.tagName === 'svg');
  for (const el of all) {
    if (decorative(el) || !shown(el) || !meaningful(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.right > vw + 1 || rect.left < -1) { problems.push(`off-screen x [${Math.round(rect.left)}, ${Math.round(rect.right)}] ${describe(el)}`); continue; }
    // Horizontal clipping by any ancestor that hides overflow.
    for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const overflowX = getComputedStyle(parent).overflowX;
      if (overflowX === 'visible') continue;
      const box = parent.getBoundingClientRect();
      if (rect.right > box.right + 1 || rect.left < box.left - 1) problems.push(`clipped by ${describe(parent).slice(0, 40)}: ${describe(el)}`);
      break;
    }
    // Text that overflows its own clipping box horizontally (measured on the text itself, so a decorative
    // pseudo-element such as the button shine does not count).
    if (ownText(el) && !el.matches('textarea') && getComputedStyle(el).overflowX !== 'visible') {
      const range = document.createRange();
      for (const node of el.childNodes) {
        if (node.nodeType !== 3 || !node.textContent.trim()) continue;
        range.selectNodeContents(node);
        const text = range.getBoundingClientRect();
        if (text.right > rect.right + 1 || text.left < rect.left - 1) { problems.push(`text overflows own box: ${describe(el)}`); break; }
      }
    }
    if (ownText(el) && parseFloat(getComputedStyle(el).fontSize) < 12) problems.push(`font < 12px: ${describe(el)}`);
  }

  // Interactive targets: visible links/buttons outside the decorative sample card must be at least 24px (WCAG 2.2 AA).
  for (const el of document.querySelectorAll('main a, main button, header a, header button, footer a, main textarea')) {
    if (!shown(el) || el.closest('[aria-hidden="true"]')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.height < 24 || rect.width < 24) problems.push(`tap target ${Math.round(rect.width)}x${Math.round(rect.height)}: ${describe(el)}`);
  }

  // Nav controls must not overlap each other.
  const navParts = [...document.querySelectorAll('.site-nav .brand, .site-nav nav a, .site-nav-actions .btn')].filter(shown).map(el => [el, el.getBoundingClientRect()]);
  for (let i = 0; i < navParts.length; i += 1) for (let j = i + 1; j < navParts.length; j += 1) {
    const [a, ra] = navParts[i]; const [b, rb] = navParts[j];
    if (ra.left < rb.right - 1 && rb.left < ra.right - 1 && ra.top < rb.bottom - 1 && rb.top < ra.bottom - 1) problems.push(`nav overlap: ${describe(a)} × ${describe(b)}`);
  }
  // Hero overlap: copy and illustration must not intersect when they sit side by side or stacked.
  const copy = document.querySelector('.hero-copy')?.getBoundingClientRect();
  const art = document.querySelector('.hero-art')?.getBoundingClientRect();
  if (copy && art && copy.left < art.right - 1 && art.left < copy.right - 1 && copy.top < art.bottom - 1 && art.top < copy.bottom - 1) problems.push('hero copy overlaps hero illustration');
  // Hero illustration parts must stay inside the scene (absolute layout at wide widths).
  const scene = document.querySelector('.scan-scene')?.getBoundingClientRect();
  for (const el of document.querySelectorAll('.scan-window, .scan-found, .scan-cadence, .scan-caption')) {
    const rect = el.getBoundingClientRect();
    if (scene && (rect.bottom > scene.bottom + 1 || rect.right > scene.right + 1)) problems.push(`hero scene part outside scene: ${describe(el)}`);
  }
  const cadence = document.querySelector('.scan-cadence')?.getBoundingClientRect();
  const found = document.querySelector('.scan-found')?.getBoundingClientRect();
  if (cadence && found && cadence.left < found.right - 1 && found.left < cadence.right - 1 && cadence.top < found.bottom - 1 && found.top < cadence.bottom - 1) problems.push('hero cadence pill overlaps found-leads card');
  return problems;
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  // Scroll through so every [data-reveal] block gets revealed, then back to the top.
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += Math.max(300, innerHeight / 2)) { scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); }
    scrollTo(0, document.documentElement.scrollHeight); await new Promise(r => setTimeout(r, 300));
    scrollTo(0, 0);
  });
  await page.waitForTimeout(900);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const consoleErrors = [];
async function open(width, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: heightFor(width) }, ...options });
  const page = await context.newPage();
  page.on('pageerror', error => consoleErrors.push(`pageerror ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await settle(page);
  return { context, page };
}

// 1. Continuous width sweep, motion on (animations running), portrait-ish heights.
const failing = new Map();
{
  const { context, page } = await open(1440);
  for (const width of sweep) {
    await page.setViewportSize({ width, height: heightFor(width) });
    await page.waitForTimeout(120);
    const problems = await page.evaluate(audit);
    if (problems.length) failing.set(width, problems);
  }
  await context.close();
}
const failingWidths = [...failing.keys()];
record('sweep', `${sweep.length} widths 280–2560px without layout problems`, failingWidths.length === 0,
  failingWidths.length ? `${failingWidths.length} failing: ${failingWidths.slice(0, 30).join(', ')}${failingWidths.length > 30 ? '…' : ''}` : '');
const byProblem = new Map();
for (const [width, problems] of failing) for (const problem of problems) byProblem.set(problem, [...(byProblem.get(problem) ?? []), width]);
for (const [problem, widths] of [...byProblem].slice(0, 60)) console.log(`   ${widths[0]}–${widths.at(-1)}px (${widths.length}×): ${problem}`);

// 2. Landscape phones/tablets and a short laptop window.
for (const [width, height] of [[568, 320], [667, 375], [740, 360], [844, 390], [932, 430], [1024, 768], [1180, 820], [1280, 600]]) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await settle(page);
  const problems = await page.evaluate(audit);
  record('landscape', `${width}×${height}`, problems.length === 0, problems.slice(0, 4).join(' | '));
  await context.close();
}

// 3. Browser zoom 200% at 1280×800 = 640×400 CSS px with DPR 2; 400% at 1280 = 320 CSS px.
for (const [zoom, width, height] of [[2, 640, 400], [4, 320, 200]]) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: zoom });
  const page = await context.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await settle(page);
  const problems = await page.evaluate(audit);
  record('zoom', `${zoom * 100}% of a 1280px window (${width} CSS px)`, problems.length === 0, problems.slice(0, 4).join(' | '));
  if (!process.env.SWEEP_ONLY) await page.screenshot({ path: resolve(SHOTS, `${LABEL}-zoom${zoom * 100}.png`), fullPage: true });
  await context.close();
}

// 4. Reduced motion: everything visible without reveal, still no problems.
for (const width of [360, 1366]) {
  const { context, page } = await open(width, { reducedMotion: 'reduce' });
  const problems = await page.evaluate(audit);
  const hidden = await page.evaluate(() => [...document.querySelectorAll('[data-reveal]')].filter(el => getComputedStyle(el).opacity === '0').length);
  record('reduced-motion', `${width}px: content visible, no problems`, problems.length === 0 && hidden === 0, `${hidden} hidden; ${problems.slice(0, 3).join(' | ')}`);
  await context.close();
}

if (!process.env.SWEEP_ONLY) {
  // 5. Screenshots at representative sizes.
  for (const width of [320, 360, 390, 440, 768, 1024, 1366, 1920, 2560]) {
    const { context, page } = await open(width);
    await page.screenshot({ path: resolve(SHOTS, `${LABEL}-${width}-fold.png`) });
    await page.screenshot({ path: resolve(SHOTS, `${LABEL}-${width}-full.png`), fullPage: true });
    await context.close();
  }
  // Original report: 440 × 956.
  {
    const context = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await settle(page);
    await page.screenshot({ path: resolve(SHOTS, `${LABEL}-440x956-fold.png`) });
    await page.screenshot({ path: resolve(SHOTS, `${LABEL}-440x956-full.png`), fullPage: true });
    const problems = await page.evaluate(audit);
    record('reported', '440×956 mobile (DPR 2, touch)', problems.length === 0, problems.slice(0, 6).join(' | '));
    await context.close();
  }

  // 6. Interactions on a touch phone and a laptop window.
  for (const [width, mobile] of [[360, true], [1280, false]]) {
    const context = await browser.newContext({ viewport: { width, height: heightFor(width) }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await settle(page);
    const g = `interaction ${width}px`;
    const click = async locator => mobile ? locator.tap() : locator.click();
    try {
      const primary = page.locator('.hero-actions a', { hasText: 'Khám phá QLead' });
      await click(primary);
      await page.waitForTimeout(900);
      const demoTop = await page.evaluate(() => document.querySelector('#demo').getBoundingClientRect().top);
      record(g, 'Hero CTA "Khám phá QLead" scrolls to the demo', Math.abs(demoTop) < 120, `demo top ${Math.round(demoTop)}`);
      const signup = page.locator('.hero-actions a', { hasText: 'Bắt đầu ngay' });
      record(g, 'Hero CTA "Bắt đầu ngay" links to /dang-ky', (await signup.getAttribute('href')) === '/dang-ky' && await signup.isVisible());
      const navCta = page.locator('.site-nav-actions .btn-primary');
      record(g, 'Nav "Bắt đầu ngay" visible and reachable', await navCta.isVisible() && (await navCta.boundingBox()).x + (await navCta.boundingBox()).width <= width);
      await click(page.locator('.suggestions button').nth(2));
      await page.waitForTimeout(2600);
      const head = await page.locator('.demo-results-head b').innerText();
      record(g, 'Demo suggestion runs a search and shows sample leads', /lead mẫu|Đã hiểu/.test(head), head);
      const expand = page.locator('.demo-lead-actions button').first();
      if (await expand.count()) {
        await click(expand);
        record(g, 'Demo "Xem bài đầy đủ" expands the post', await page.locator('.demo-lead-post').first().isVisible());
      }
      const textarea = page.locator('#demo-request');
      await textarea.fill('Tôi bán máy in hóa đơn cho cửa hàng tiện lợi mới mở ở Đồng Nai, muốn tìm cửa hàng sắp khai trương — mô tả dài để kiểm tra ngắt dòng.');
      await click(page.locator('.demo-search button[type=submit]'));
      await page.waitForTimeout(1200);
      const problems = await page.evaluate(audit);
      record(g, 'No layout problems after interacting with the demo', problems.length === 0, problems.slice(0, 4).join(' | '));
      // Keyboard: every anatomy field is focusable and shows a focus ring.
      await page.locator('.anatomy-list li').nth(1).focus();
      await page.keyboard.press('Shift+Tab');
      const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
      record(g, 'Anatomy field takes keyboard focus with a visible outline', ring !== 'none', ring);
      if (!process.env.SWEEP_ONLY) await page.screenshot({ path: resolve(SHOTS, `${LABEL}-${width}-demo-interaction.png`), fullPage: false });
    } catch (error) { record(g, 'interaction run', false, error.message.split('\n')[0]); }
    await context.close();
  }
}

await browser.close();
record('console', 'No page errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
const failed = results.filter(r => !r.pass).length;
writeFileSync(resolve(SHOTS, `${LABEL}-report.json`), JSON.stringify({ base: BASE, sweepWidths: sweep.length, failingWidths, problems: Object.fromEntries(byProblem), results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

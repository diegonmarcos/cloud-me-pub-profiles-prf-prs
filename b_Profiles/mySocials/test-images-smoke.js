#!/usr/bin/env node
/* mySocials image smoke test (#1913): headless Chromium via Playwright.
 * Loads every dist page with the media CDN answering 404 (the real state until the media folder
 * is pushed to cloudy_db_assets-cdn) and asserts no visible broken image: every <img> is either
 * naturalWidth > 0 or the inline SVG placeholder. Usage: node test-images-smoke.js [--mutate]
 * --mutate removes the fallback script; the test must then go RED (exit 1 expected by the caller). */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const MUTATE = process.argv.includes('--mutate');
const dist = path.join(__dirname, 'dist');
const pages = fs.readdirSync(dist).filter(f => f.endsWith('.html') && (!MUTATE || /^(instagram-diegonmarcos|facebook)/.test(f)));

(async () => {
  const browser = await chromium.launch();
  let bad = 0, imgs = 0, placeholders = 0;
  for (const p of pages) {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const page = await ctx.newPage();
    await page.route(/^https?:/, r => {
      const u = r.request().url();
      if (/\/b_Media\//.test(u)) return r.fulfill({ status: 404, body: 'not found' });
      return r.abort();
    });
    if (MUTATE) await page.route(/img-fallback\.js$/, r => r.abort());
    await page.goto('file://' + path.join(dist, p), { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    // scroll so lazy images load
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 40)); } });
    await page.waitForTimeout(1500);
    const res = await page.evaluate(() => [...document.images].map(i => ({
      src: i.currentSrc.slice(0, 90), ok: i.complete && i.naturalWidth > 0,
      // broken = errored (complete, no pixels) or visible but never loaded; hidden lazy images that were never requested are not visible
      pending: !i.complete && !(i.getBoundingClientRect().height > 0), ph: i.currentSrc.startsWith('data:image/svg+xml') && i.getAttribute('data-fb') === 'done',
    })));
    const broken = res.filter(r => !r.ok && !r.ph && !r.pending && r.src);
    imgs += res.length; placeholders += res.filter(r => r.ph).length; bad += broken.length;
    console.log(`${broken.length ? 'FAIL' : 'ok  '} ${p}: ${res.length} img, ${res.filter(r => r.ph).length} placeholder, ${broken.length} broken`);
    broken.slice(0, 3).forEach(b => console.log('   broken:', b.src));
    await ctx.close();
  }
  await browser.close();
  console.log(`pages=${pages.length} imgs=${imgs} placeholders=${placeholders} broken=${bad}`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

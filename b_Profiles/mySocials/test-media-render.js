#!/usr/bin/env node
/* mySocials RENDER guard (#1980). References are not enough (#1950 counted refs, the images stayed blank): this loads
 * every page in headless Chromium at 412x915, scrolls ALL of it (window and nested scrollers), waits for the lazy images
 * and fails (exit 1) on
 *   - any <img> with complete && naturalWidth === 0 (the broken-image icon), or still not loaded after the scroll,
 *   - any <img> that only shows the inline placeholder (data-fb="done": the real asset did not load),
 *   - any <img> whose source is a video file, any <img> without width/height,
 *   - any <video> without a poster, or whose poster image does not decode,
 *   - a renderer crash, or a page that does not load.
 * Usage: node test-media-render.js [--dist DIR | --base https://host/mySocials/] [--only a,b] [--out report.json]
 * Default: serves ./dist on a local port (no service worker, analytics blocked: they are not under test). */
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const distDir = path.resolve(arg('--dist', path.join(__dirname, 'dist')));
const baseArg = arg('--base', ''), onlyArg = arg('--only', ''), outFile = arg('--out', '');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const SKIP = /(fonts\.googleapis\.com|fonts\.gstatic\.com|analytics\.diegonmarcos\.com)/;

(async () => {
  let server, base = baseArg;
  if (!base) {
    server = http.createServer((q, r) => {
      const f = path.join(distDir, decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
      if (!f.startsWith(distDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nf'); }
      r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
    }).listen(0);
    base = `http://127.0.0.1:${server.address().port}/`;
  }
  base = base.replace(/\/?$/, '/');
  const pages = fs.readdirSync(distDir).filter(f => /\.html$/.test(f) && !f.startsWith('_'))
    .map(f => f.replace(/\.html$/, '')).filter(f => !onlyArg || onlyArg.split(',').includes(f)).sort();
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const report = {}; let failures = 0;
  for (const p of pages) {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: 'block' });
    await ctx.route(SKIP, r => r.abort());
    const pg = await ctx.newPage();
    const fail = [];
    let crashed = false;
    pg.on('crash', () => { crashed = true; });
    try {
      await pg.goto(base + p + '.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await pg.waitForTimeout(1500);
      await pg.evaluate(async () => {
        const scrollers = () => [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
        const h = () => Math.max(document.body.scrollHeight, ...scrollers().map(e => e.scrollHeight));
        for (let y = 0; y < Math.min(h(), 200000); y += 500) { window.scrollTo(0, y); scrollers().forEach(e => { e.scrollTop = y; }); await new Promise(r => setTimeout(r, 40)); }
        window.scrollTo(0, 0);
      });
      for (let i = 0; i < 30 && !crashed; i++) { // lazy images settle
        const pending = await pg.evaluate(() => [...document.images].filter(i => !i.complete && i.currentSrc && i.checkVisibility && i.checkVisibility() && i.getBoundingClientRect().right > 0 && i.getBoundingClientRect().left < innerWidth).length).catch(() => -1);
        if (pending === 0) break;
        await pg.waitForTimeout(500);
      }
      const dom = await pg.evaluate(async () => {
        const o = { total: 0, broken: [], placeholder: [], videoAsImg: [], noDim: [], pending: [], videos: 0, videoNoPoster: [], posterBad: [] };
        const imgs = [...document.images]; o.total = imgs.length;
        for (const i of imgs) {
          const s = i.currentSrc || i.getAttribute('src') || '';
          if (i.getAttribute('data-fb') === 'done') o.placeholder.push(i.getAttribute('data-fb-src') || s.slice(0, 80));
          else if (i.complete && i.naturalWidth === 0) o.broken.push(s.slice(0, 160) || '(no src)');
          if (/\.(mp4|webm|mov)(\?|$)/i.test(s)) o.videoAsImg.push(s.slice(0, 160));
          if ((i.getAttribute('data-mt') === '1' || /mt-[0-9a-f]{12}\.webp/.test(s)) && (!i.getAttribute('width') || !i.getAttribute('height'))) o.noDim.push(s.slice(0, 100));
          if (!i.complete && s && i.checkVisibility && i.checkVisibility()) { const r = i.getBoundingClientRect(); if (r.right > 0 && r.left < innerWidth) o.pending.push(s.slice(0, 160)); } // off-screen in a horizontal strip: lazy, loads on swipe
        }
        for (const v of document.querySelectorAll('video')) {
          o.videos++;
          const pst = v.getAttribute('poster');
          if (!pst) { o.videoNoPoster.push((v.getAttribute('src') || '').slice(0, 120)); continue; }
          const ok = await new Promise(res => { const im = new Image(); im.onload = () => res(im.naturalWidth > 0); im.onerror = () => res(false); im.src = v.poster; setTimeout(() => res(false), 15000); });
          if (!ok) o.posterBad.push(pst.slice(0, 120));
        }
        return o;
      }).catch(e => { crashed = true; return null; });
      if (dom) {
        if (dom.broken.length) fail.push({ kind: 'broken <img> (naturalWidth 0)', n: dom.broken.length, sample: dom.broken.slice(0, 5) });
        if (dom.placeholder.length) fail.push({ kind: 'placeholder instead of the real image', n: dom.placeholder.length, sample: dom.placeholder.slice(0, 5) });
        if (dom.videoAsImg.length) fail.push({ kind: '<img> pointing at a video file', n: dom.videoAsImg.length, sample: dom.videoAsImg.slice(0, 5) });
        if (dom.noDim.length) fail.push({ kind: 'thumbnail <img> without width/height', n: dom.noDim.length, sample: dom.noDim.slice(0, 5) });
        if (dom.pending.length) fail.push({ kind: 'visible <img> still not loaded after the scroll', n: dom.pending.length, sample: dom.pending.slice(0, 5) });
        if (dom.videoNoPoster.length) fail.push({ kind: '<video> without poster', n: dom.videoNoPoster.length, sample: dom.videoNoPoster.slice(0, 5) });
        if (dom.posterBad.length) fail.push({ kind: '<video> poster does not decode', n: dom.posterBad.length, sample: dom.posterBad.slice(0, 5) });
      }
      report[p] = { images: dom ? dom.total : null, videos: dom ? dom.videos : null };
    } catch (e) {
      fail.push({ kind: 'page did not load', error: String(e).slice(0, 160) });
    }
    if (crashed) fail.push({ kind: 'renderer crashed' });
    report[p] = Object.assign(report[p] || {}, { fail });
    failures += fail.length;
    console.log(`${fail.length ? 'FAIL' : 'ok  '} ${p}: ${report[p].images} img, ${report[p].videos} video` + fail.map(f => `\n     - ${f.kind}${f.n ? ' x' + f.n : ''}${f.sample ? ': ' + JSON.stringify(f.sample[0]) : ''}${f.error ? ': ' + f.error : ''}`).join(''));
    await ctx.close();
  }
  await browser.close();
  if (server) server.close();
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 1));
  console.log(failures ? `\n${failures} failure(s)` : '\nzero broken images, zero crashes');
  process.exit(failures ? 1 : 0);
})();

#!/usr/bin/env node
/* mySocials media link checker (#1950): headless Chromium (Playwright) visits EVERY page at 412x915, scrolls all
 * lazy content and fails (exit 1) on any broken image, video, source, CSS background, stylesheet, script or fetch,
 * and on any image that only shows the placeholder (the real asset is missing). A jsDelivr refusal that the page
 * recovers through its raw.githubusercontent.com second source is not counted (the file is served).
 * #1959: on linkedin it also fetches EVERY image the data names (banner, entry logos, media and YouTube thumbnails), and checks
 * the banner is drawn, every YouTube facade is present with a loaded thumbnail, and the Open to work / Connect block is gone.
 * Usage: node test-media-links.js [--dist DIR | --base https://host/mySocials/] [--out report.json] [--only page,page]
 * Default: serves ./dist on a local port. */
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const distDir = path.resolve(arg('--dist', path.join(__dirname, 'dist')));
const baseArg = arg('--base', ''), outFile = arg('--out', ''), onlyArg = arg('--only', '');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const SKIP_HOST = /(^|\.)analytics\.diegonmarcos\.com$/;
const WATCH = new Set(['image', 'media', 'fetch', 'xhr', 'stylesheet', 'script', 'font']);

const rawOf = u => { const m = /^https:\/\/cdn\.jsdelivr\.net\/gh\/diegonmarcos\/([^@/]+)@main\/(.+)$/.exec(u); return m && `https://raw.githubusercontent.com/diegonmarcos/${m[1]}/main/${m[2]}`; };
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
  const pages = fs.readdirSync(distDir).filter(f => /\.html$/.test(f) && !f.startsWith('_')).map(f => f.replace(/\.html$/, '')).filter(f => !onlyArg || onlyArg.split(',').includes(f)).sort();
  const browser = await chromium.launch(); const report = {}; let total = 0;
  for (const p of pages) {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: 'block' });
    const pg = await ctx.newPage(); const bad = [], ok = new Set();
    const add = (kind, url, status) => bad.push({ kind, url, status });
    pg.on('response', r => { const t = r.request().resourceType(); if (!WATCH.has(t) || SKIP_HOST.test(new URL(r.url()).hostname)) return; if (r.status() >= 400) add(t, r.url(), r.status()); else ok.add(r.url()); });
    pg.on('requestfailed', r => { const t = r.resourceType(); const aborted = t === 'media' && /ERR_ABORTED/.test((r.failure() || {}).errorText || ''); /* a media request the player cancels itself is not a failure; v.error below is */ if (WATCH.has(t) && !aborted && !SKIP_HOST.test(new URL(r.url()).hostname)) add(t, r.url(), 'FAILED ' + ((r.failure() || {}).errorText || '')); });
    await pg.goto(base + p + '.html', { waitUntil: 'load', timeout: 60000 }).catch(e => add('page', base + p + '.html', String(e).slice(0, 80)));
    await pg.waitForTimeout(1500);
    await pg.evaluate(async () => {
      const scrollers = () => [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
      const h = () => Math.max(document.body.scrollHeight, ...scrollers().map(e => e.scrollHeight));
      for (let y = 0; y < Math.min(h(), 60000); y += 500) { window.scrollTo(0, y); scrollers().forEach(e => { e.scrollTop = y; }); await new Promise(r => setTimeout(r, 30)); }
      window.scrollTo(0, 0);
    });
    await pg.waitForTimeout(2500);
    const dom = await pg.evaluate(() => {
      const o = [];
      document.querySelectorAll('img').forEach(i => { if (i.getAttribute('data-fb') === 'done') o.push(['placeholder', i.getAttribute('data-fb-src')]); else if (i.complete && i.naturalWidth === 0 && i.currentSrc) o.push(['img', i.currentSrc]); });
      document.querySelectorAll('video').forEach(v => { if (v.error || v.networkState === 3) o.push(['video', v.currentSrc || v.src]); });
      return o;
    });
    dom.forEach(([k, u]) => add('dom-' + k, u, 'not rendered'));
    if (p === 'linkedin') {
      const li = await pg.evaluate(() => {
        const d = (globalThis.PORTAL_DATA || {}).linkedin; if (!d) return null;
        const urls = [d.profile.banner], yts = [];
        [...d.experience, ...d.education, ...d.projects].forEach(e => { if (e.logo) urls.push(e.logo); if (e.media) { urls.push(e.media.thumb); if (e.media.yt) yts.push(e.media.yt); } });
        const loaded = s => [...document.querySelectorAll(s)].filter(i => i.complete && i.naturalWidth > 0).length;
        return { urls: urls.filter(Boolean), yts, facades: document.querySelectorAll('.li-yt').length, facadeImgs: loaded('.li-yt img'),
          banner: loaded('.li-phead__banner--img img'), openBlock: document.querySelectorAll('.li-phead__open, .li-phead__actions').length,
          fallbackLinks: [...document.querySelectorAll('.li-yt')].filter(b => { const a = b.parentElement.querySelector('a.li-media__title'); return a && /youtube\.com\/watch\?v=/.test(a.href); }).length };
      });
      if (!li) add('li-data', 'PORTAL_DATA.linkedin', 'missing');
      else {
        for (const u of [...new Set(li.urls)]) {
          let r = await ctx.request.get(u).catch(() => null);
          if ((!r || r.status() >= 400) && rawOf(u)) r = await ctx.request.get(rawOf(u)).catch(() => null);
          if (!r || r.status() >= 400 || !/^image\//.test(r.headers()['content-type'] || '')) add('li-asset', u, r ? r.status() : 'no response');
        }
        if (li.banner !== 1) add('li-banner', 'banner not drawn', li.banner);
        if (li.facades !== li.yts.length || li.facades < 8) add('li-facade', `facades ${li.facades} of ${li.yts.length} videos`, 'missing');
        if (li.facadeImgs !== li.facades) add('li-facade', 'facade thumbnail not loaded', `${li.facadeImgs}/${li.facades}`);
        if (li.fallbackLinks !== li.facades) add('li-facade', 'facade without YouTube fallback link', `${li.fallbackLinks}/${li.facades}`);
        if (li.openBlock) add('li-open', 'Open to work / Connect block present', li.openBlock);
        console.log(`   linkedin: ${new Set(li.urls).size} data images fetched, ${li.facades} video facades`);
      }
    }
    // a jsDelivr failure recovered through the raw second source is served: drop it
    const real = bad.filter(b => !(rawOf(b.url) && ok.has(rawOf(b.url)))).filter((b, i, a) => a.findIndex(x => x.kind === b.kind && x.url === b.url) === i)
      .filter(b => !(b.kind === 'dom-placeholder' && ok.has(rawOf(b.url) || '')));
    report[p] = real; total += real.length;
    console.log(`${real.length ? 'FAIL' : 'ok  '} ${p}: ${real.length} broken`);
    real.slice(0, 8).forEach(b => console.log(`   ${b.kind} ${b.status} ${b.url.slice(0, 170)}`));
    await ctx.close();
  }
  await browser.close(); if (server) server.close();
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 1));
  console.log(`TOTAL broken refs: ${total} across ${pages.length} pages`);
  process.exit(total ? 1 : 0);
})();

/* mySocials image fallback (#1913).
 * One declared CDN base for every page of the set. The data files still carry the legacy
 * front-assets-cdn URLs; they are rewritten at load to MYSOCIALS_CDN_BASE, so once the media
 * folder is pushed to cloudy_db_assets-cdn the images light up with no code change.
 * Any image that still fails to load swaps to an inline SVG placeholder (caption initial or
 * camera glyph); the element, caption, counts and links stay. */
(function () {
  'use strict';
  var MYSOCIALS_CDN_BASE = 'https://cdn.jsdelivr.net/gh/diegonmarcos/cloudy_db_assets-cdn@main/b_Media/mySocials/static/media';
  var LEGACY_RE = /^https:\/\/cdn\.jsdelivr\.net\/gh\/diegonmarcos\/(?:front-assets-cdn|cloudy_db_assets-cdn)@main\/b_Media\/mySocials\/static\/media/;
  window.MYSOCIALS_CDN_BASE = MYSOCIALS_CDN_BASE;

  function rebase(url) {
    return url && LEGACY_RE.test(url) ? url.replace(LEGACY_RE, MYSOCIALS_CDN_BASE) : url;
  }

  function placeholder(alt) {
    var c = (alt || '').trim().charAt(0);
    var generic = /^(post|story \d+|post photo|story)$/i.test((alt || '').trim());
    var glyph;
    if (c && !generic && /[0-9A-Za-zÀ-ɏ]/.test(c)) {
      glyph = '<text x="50" y="50" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="44" fill="#9aa3b2">' + c.toUpperCase().replace(/[<>&]/g, '') + '</text>';
    } else {
      glyph = '<g fill="none" stroke="#9aa3b2" stroke-width="4" stroke-linejoin="round"><path d="M28 38h10l4-6h16l4 6h10a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H28a4 4 0 0 1-4-4V42a4 4 0 0 1 4-4z"/><circle cx="50" cy="56" r="10"/></g>';
    }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice"><rect width="100" height="100" fill="#1b2030"/>' + glyph + '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }


  // #1980: same-origin thumbnail layer. gen-media.py writes mt-<hash>.webp next to the page and
  // mysocials-media-manifest.js (window.MYSOCIALS_MEDIA = {t: {"<path under static/media>": "hash,w,h,isVideo"}}).
  // Every <img>, <video poster> and inline background that names a manifest file is served from the page's own origin as a
  // small WebP (lazy, sized); the original stays in data-orig-src for the tap viewers. Viewer images are never swapped.
  try { document.write('<script src="mysocials-media-manifest.js"><\/script>'); } catch (e) { /* async insertion: no thumbs */ }
  var MEDIA_RE = /\/static\/media\/([^"'\s)\\?#]+)/;
  var VIEWER = /(^|\s)(ig-post-modal__img|ig-story-viewer__media)(\s|$)/;
  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  function thumbOf(url) {
    var M = window.MYSOCIALS_MEDIA, m = url && MEDIA_RE.exec(url);
    if (!M || !m) return null;
    var e = M.t[decodeURIComponent(m[1])];
    if (!e) return null;
    var a = e.split(',');
    return { src: 'mt-' + a[0] + '.webp', w: +a[1], h: +a[2], video: a[3] === '1' };
  }
  function thumbImg(img) {
    if (img.getAttribute('data-mt') === '1') return;
    var cls = img.getAttribute('class') || '';
    if (VIEWER.test(cls) || /^ig-(post|story)-img$/.test(img.id)) {
      if (!img.getAttribute('src')) img.setAttribute('src', BLANK); // viewer image before its first tap: not a broken image
      return;
    }
    var s = img.getAttribute('data-orig-src') || img.getAttribute('src');
    var t = thumbOf(s);
    if (!t) {
      if (s && /\.(mp4|webm|mov)(\?|$)/i.test(s)) swap(img); // a video file can never be an <img>: placeholder, never broken
      return;
    }
    img.setAttribute('data-mt', '1');
    img.setAttribute('data-orig-src', s);
    if (!img.getAttribute('width')) img.setAttribute('width', t.w);
    if (!img.getAttribute('height')) img.setAttribute('height', t.h);
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.setAttribute('src', t.src);
  }
  function thumbVideo(v) {
    var t = thumbOf(v.getAttribute('src') || (v.querySelector('source') || {}).src || '');
    if (v.id !== 'ig-story-vid') v.setAttribute('preload', 'none');
    if (t && !v.getAttribute('poster')) v.setAttribute('poster', t.src);
  }
  function thumbBg(el) {
    var st = el.getAttribute && el.getAttribute('style');
    if (!st || st.indexOf('static/media') < 0) return;
    var out = st.replace(/url\((['"]?)([^'")]+)\1\)/g, function (all, q, u) { var t = thumbOf(u); return t ? 'url(' + q + t.src + q + ')' : all; });
    if (out !== st) el.setAttribute('style', out);
  }


  // Rewrite markup BEFORE the parser sees it: a background-image / <img> starts its request the moment the node is styled,
  // earlier than any MutationObserver callback, so the page's own innerHTML / insertAdjacentHTML writes go through here.
  function thumbHtml(h) {
    if (typeof h !== 'string' || h.indexOf('static/media') < 0 || !window.MYSOCIALS_MEDIA) return h;
    h = h.replace(/(<img\b)([^>]*?)(\ssrc=)(["'])([^"']+)\4([^>]*>)/gi, function (all, a, pre, srcEq, q, u, post) {
      if (VIEWER.test(pre + post)) return all;
      var t = thumbOf(u);
      if (!t) return all;
      var dim = (/\swidth=/i.test(pre + post) ? '' : ' width="' + t.w + '"') + (/\sheight=/i.test(pre + post) ? '' : ' height="' + t.h + '"');
      return a + pre + ' data-mt="1" data-orig-src="' + u + '" loading="lazy" decoding="async"' + dim + srcEq + q + t.src + q + post.replace(/\sloading=(["'])[^"']*\1/i, '').replace(/\sdecoding=(["'])[^"']*\1/i, '');
    });
    h = h.replace(/(<video\b)([^>]*?)\ssrc=(["'])([^"']+)\3/gi, function (all, a, pre, q, u) {
      var t = thumbOf(u);
      return t && !/\sposter=/i.test(all) ? a + pre + ' poster="' + t.src + '" preload="none" src=' + q + u + q : all;
    });
    return h.replace(/url\((['"]?)([^'")]+)\1\)/g, function (all, q, u) { var t = thumbOf(u); return t ? 'url(' + q + t.src + q + ')' : all; });
  }
  try {
    var ihd = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    Object.defineProperty(Element.prototype, 'innerHTML', { configurable: true, enumerable: ihd.enumerable, get: ihd.get, set: function (v) { ihd.set.call(this, thumbHtml(v)); } });
    var iah = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function (pos, v) { return iah.call(this, pos, thumbHtml(v)); };
  } catch (e) { /* the observer below still covers it, a little later */ }

  function fix(img) {
    if (!img || img.tagName !== 'IMG' || img.getAttribute('data-fb') === 'done') return;
    var s = img.getAttribute('src');
    var r = rebase(s);
    if (r && r !== s) img.setAttribute('src', r);
    thumbImg(img);
    if (!img.getAttribute('loading') && !VIEWER.test(img.getAttribute('class') || '')) img.setAttribute('loading', 'lazy');
  }

  function swap(img) {
    img.setAttribute('data-fb', 'done');
    img.setAttribute('data-fb-src', img.getAttribute('src') || '');
    img.removeAttribute('srcset');
    img.setAttribute('src', placeholder(img.getAttribute('alt')));
    img.style.objectFit = 'cover';
  }

  // #1950: jsDelivr refuses some objects (files over 20 MB, repo over its package limit). Second source for the same
  // file: raw.githubusercontent.com of the same repo (same path), tried once before the placeholder.
  var JSD_RE = /^https:\/\/cdn\.jsdelivr\.net\/gh\/diegonmarcos\/([^@/]+)@main\/(.+)$/;
  function rawAlt(url) {
    var m = url && JSD_RE.exec(url);
    return m ? 'https://raw.githubusercontent.com/diegonmarcos/' + m[1] + '/main/' + m[2] : '';
  }

  document.addEventListener('error', function (ev) {
    var el = ev.target;
    if (!el) return;
    if (el.tagName === 'VIDEO' || el.tagName === 'SOURCE') {
      var v = el.tagName === 'SOURCE' ? el.parentNode : el;
      var alt = rawAlt(el.getAttribute('src') || '');
      if (alt && el.getAttribute('data-fb-alt') !== '1') {
        el.setAttribute('data-fb-alt', '1');
        el.setAttribute('src', alt);
        if (v && v.load) v.load();
      } else if (v && v.tagName === 'VIDEO' && !v.getAttribute('poster')) {
        v.setAttribute('poster', placeholder(v.getAttribute('aria-label') || v.getAttribute('title') || ''));
      }
      return;
    }
    var img = el;
    if (img.tagName !== 'IMG' || img.getAttribute('data-fb') === 'done') return;
    var src = img.getAttribute('src') || '';
    if (src.indexOf('data:image/svg+xml') === 0) return;
    var a2 = rawAlt(src);
    if (a2 && img.getAttribute('data-fb-alt') !== '1') {
      img.setAttribute('data-fb-alt', '1');
      img.setAttribute('src', a2);
      return;
    }
    swap(img);
  }, true);

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.tagName === 'IMG') fix(root);
    else if (root.tagName === 'VIDEO') thumbVideo(root);
    thumbBg(root);
    var list = root.querySelectorAll ? root.querySelectorAll('img,video,[style*="static/media"]') : [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.tagName === 'IMG') fix(el); else if (el.tagName === 'VIDEO') thumbVideo(el); else thumbBg(el);
    }
  }

  new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      if (m.type === 'attributes') {
        if (m.target.tagName === 'IMG') fix(m.target); else if (m.target.tagName === 'VIDEO') thumbVideo(m.target); else thumbBg(m.target);
      } else m.addedNodes.forEach(scan);
    });
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'style'] });
})();

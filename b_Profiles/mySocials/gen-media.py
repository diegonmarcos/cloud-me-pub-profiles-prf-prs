#!/usr/bin/env python3
"""mySocials media generator (#1980).

Declarative source: every media URL the page data names (src/data/data-*.json.js, jsDelivr or raw
cloudy_db_assets-cdn under b_Media/mySocials/static/media). For each file it produces ONE small same-origin WebP
thumbnail (images: longest side 480 px, hero/cover folders 900 px; videos: the first frame as poster), whatever the
real bytes are (a .webp holding JPEG bytes, a PNG, an .mp4 shown as an image: all decode by content). A file that cannot
be decoded still gets a neutral placeholder thumbnail and is listed under "bad" in the report, so no post or story is
ever dropped and no <img> is ever broken.

Outputs (src/ is the source, dist/ the committed copy; both written identically):
  src/media-t/mt-<sha1(relpath)[:12]>.webp   -> dist/mt-<...>.webp (flat: the engine `copy` mod is flat)
  src/js/mysocials-media-manifest.js         -> dist/mysocials-media-manifest.js   window.MYSOCIALS_MEDIA
  media-report.json                          counts, bad list, bytes
The runtime (src/js/img-fallback.js) swaps every <img>/<video poster>/inline background that names a manifest entry to
the thumbnail, sets width/height, lazy-loads, and leaves the full file for the tap viewer.

Usage: python3 gen-media.py [--limit N] [--force] [--workers 8] [--fetch-base URL]
Needs: Pillow, ffmpeg (CI installs them). Originals are fetched from raw.githubusercontent.com (not jsDelivr: no size
or package limits)."""
import argparse, concurrent.futures as cf, glob, hashlib, json, os, re, shutil, subprocess, sys, tempfile, time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = "https://raw.githubusercontent.com/diegonmarcos/cloudy_db_assets-cdn/main/b_Media/mySocials/static/media/"
URL_RE = re.compile(r'https://(?:cdn\.jsdelivr\.net/gh/diegonmarcos/(?:cloudy_db_assets-cdn|front-assets-cdn)@main|raw\.githubusercontent\.com/diegonmarcos/cloudy_db_assets-cdn/main)/b_Media/mySocials/static/media/([^"\'\s)\\?#]+)')
VIDEO_EXT = {"mp4", "webm", "mov", "mkv", "avi"}
HERO_DIRS = ("profiles/", "linkedin/", "covers/")
THUMB = 480
RETRY = set()  # files the previous run could only placeholder: tried again
HERO = 900


def relpaths():
    out = set()
    for f in sorted(glob.glob(os.path.join(HERE, "src", "data", "data-*.json.js"))):
        with open(f, encoding="utf-8") as fh:
            out.update(URL_RE.findall(fh.read()))
    return sorted(out)


def name_of(rel):
    return "mt-" + hashlib.sha1(rel.encode()).hexdigest()[:12] + ".webp"


def fetch(url, dest, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "mysocials-media-gen"})
            with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as o:
                shutil.copyfileobj(r, o)
            return
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"fetch {url}: {last}")


def placeholder():
    from PIL import Image
    return Image.new("RGB", (THUMB, THUMB), (27, 32, 48))


def first_frame(path, png):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", "0.3", "-i", path, "-frames:v", "1", png],
                   check=True, timeout=180)
    if not os.path.exists(png) or os.path.getsize(png) == 0:  # clips shorter than 0.3 s
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", path, "-frames:v", "1", png], check=True, timeout=180)


def build_one(rel, outdir, base, force):
    force = force or rel in RETRY
    from PIL import Image, ImageOps
    dest = os.path.join(outdir, name_of(rel))
    ext = rel.rsplit(".", 1)[-1].lower()
    is_video = ext in VIDEO_EXT
    side = HERO if rel.startswith(HERO_DIRS) or "/" not in rel else THUMB
    if os.path.exists(dest) and not force:
        with Image.open(dest) as im:
            return rel, im.size, is_video, False
    tmp = tempfile.mkdtemp(prefix="msg-")
    bad = False
    try:
        src = os.path.join(tmp, "orig")
        try:
            fetch(base + rel, src)
            if is_video:
                png = os.path.join(tmp, "f.png")
                first_frame(src, png)
                src = png
            im = Image.open(src)
            im.load()
            im = ImageOps.exif_transpose(im)
        except Exception as e:  # noqa: BLE001
            print(f"BAD {rel}: {str(e)[:120]}", file=sys.stderr)
            im, bad = placeholder(), True
        has_alpha = im.mode in ("RGBA", "LA", "P") and "transparency" in im.info or im.mode in ("RGBA", "LA")
        im = im.convert("RGBA" if has_alpha else "RGB")
        im.thumbnail((side, side), Image.LANCZOS)
        im.save(dest, "WEBP", quality=62 if side == THUMB else 72, method=4)
        return rel, im.size, is_video, bad
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--fetch-base", default=RAW)
    ap.add_argument("--out-src", default=os.path.join(HERE, "src", "media-t"))
    ap.add_argument("--no-dist", action="store_true")
    ap.add_argument("--skip-video", action="store_true", help="images first (fast); videos in a later run")
    a = ap.parse_args()
    try:
        RETRY.update(json.load(open(os.path.join(HERE, "media-report.json")))["bad"])
    except Exception:  # noqa: BLE001
        pass
    rels = relpaths()
    if not a.skip_video and not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is required for the video posters")
    if a.skip_video:
        rels = [r for r in rels if r.rsplit(".", 1)[-1].lower() not in VIDEO_EXT]
    if a.limit:
        rels = rels[:: max(1, len(rels) // a.limit)][: a.limit]
    os.makedirs(a.out_src, exist_ok=True)
    res = {}
    bad = []
    with cf.ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(build_one, r, a.out_src, a.fetch_base, a.force): r for r in rels}
        for i, f in enumerate(cf.as_completed(futs), 1):
            rel, size, vid, b = f.result()
            res[rel] = (size, vid)
            if b:
                bad.append(rel)
            if i % 100 == 0:
                print(f"{i}/{len(rels)}", flush=True)
    # entries for files already on disk but not in this (--limit) run keep the manifest honest: rebuild from disk
    manifest = {}
    from PIL import Image
    for rel in relpaths():
        p = os.path.join(a.out_src, name_of(rel))
        if not os.path.exists(p):
            continue
        if rel in res:
            (w, h), vid = res[rel]
        else:
            with Image.open(p) as im:
                w, h = im.size
            vid = rel.rsplit(".", 1)[-1].lower() in VIDEO_EXT
        manifest[rel] = f"{name_of(rel)[3:-5]},{w},{h},{1 if vid else 0}"
    js = ("/* GENERATED by gen-media.py (#1980), DO NOT EDIT. key = path under static/media, value = hash,w,h,isVideo;\n"
          " * thumbnail = mt-<hash>.webp next to the page. */\n"
          "window.MYSOCIALS_MEDIA=" + json.dumps({"v": 1, "t": manifest}, separators=(",", ":"), ensure_ascii=False) + ";\n")
    srcjs = os.path.join(HERE, "src", "js", "mysocials-media-manifest.js")
    with open(srcjs, "w", encoding="utf-8") as fh:
        fh.write(js)
    total = sum(os.path.getsize(os.path.join(a.out_src, name_of(r))) for r in manifest)
    report = {"referenced": len(relpaths()), "thumbnails": len(manifest), "bad": sorted(bad), "thumb_bytes": total}
    with open(os.path.join(HERE, "media-report.json"), "w") as fh:
        json.dump(report, fh, indent=1)
    if not a.no_dist:
        dist = os.path.join(HERE, "dist")
        for r in manifest:
            shutil.copyfile(os.path.join(a.out_src, name_of(r)), os.path.join(dist, name_of(r)))
        shutil.copyfile(srcjs, os.path.join(dist, "mysocials-media-manifest.js"))
    print(json.dumps({k: (v if k != "bad" else len(v)) for k, v in report.items()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

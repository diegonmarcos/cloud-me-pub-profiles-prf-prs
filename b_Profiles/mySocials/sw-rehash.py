#!/usr/bin/env python3
"""Keep dist/script-service-worker.js honest after gen-media.py / img-fallback.js edits (#1980): recompute the 12-hex
SHA-256 prefix of every asset named in its hash table from the file in dist/, and move the cache name (BUILD_HASH) to a
digest of the table, so clients drop the stale cache. The engine (esbuild_sw) regenerates the same file on a full build."""
import hashlib, os, re, sys
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")
p = os.path.join(D, "script-service-worker.js")
s = open(p, encoding="utf-8").read()
m = re.match(r'(\(\(\)=>\{var o=)(\{.*?\})(;var u=)', s, re.S)
assert m, "hash table not found"
table = dict(re.findall(r'"(\./[^"]+)":"([0-9a-f]{12})"', m.group(2)))
new = {}
for k in table:
    f = os.path.join(D, k[2:])
    new[k] = hashlib.sha256(open(f, "rb").read()).hexdigest()[:12] if os.path.isfile(f) else table[k]
body = "{" + ",".join(f'"{k}":"{v}"' for k, v in new.items()) + "}"
old_build = re.search(r'var l="static-([0-9a-f]{12})"', s).group(1)
build = hashlib.sha256("|".join(f"{k}={v}" for k, v in sorted(new.items())).encode()).hexdigest()[:12]
out = s.replace(m.group(2), body, 1).replace(old_build, build)
if out != s:
    open(p, "w", encoding="utf-8").write(out)
print("sw hash table", "updated" if out != s else "unchanged", build)

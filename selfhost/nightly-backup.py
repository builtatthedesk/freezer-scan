#!/usr/bin/env python3
"""Nightly backup of a self-hosted Freezer Scan: one file in the same format as the
Back up button (public/backup.html), photos included, so it restores on any copy
(website, self-hosted, offline phone). Keeps the newest KEEP files (default 30).

    WRITE_KEY from the repo's .env;  python3 selfhost/nightly-backup.py <out-dir> [url]
    url defaults to http://127.0.0.1:8080 (the compose app).
"""
import base64, datetime, json, os, pathlib, sys, urllib.request

here = pathlib.Path(__file__).resolve().parent.parent
env = dict(l.strip().split("=", 1) for l in open(here / ".env") if "=" in l and not l.lstrip().startswith("#"))
key = env["WRITE_KEY"]
out_dir = pathlib.Path(sys.argv[1]); out_dir.mkdir(parents=True, exist_ok=True)
base = (sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8080").rstrip("/") + "/api/"
keep = int(os.environ.get("KEEP", "30"))

def get(path, raw=False):
    with urllib.request.urlopen(urllib.request.Request(base + path, headers={"x-key": key}), timeout=60) as r:
        return r.read() if raw else json.loads(r.read())

data = get("backup")
data["photos"] = {}
for bin_id, b in data["bins"].items():
    for ph in b.get("photos", []):
        for size in ("full", "thumb"):
            img = get(f"photo/{bin_id}/{ph['id']}?size={size}", raw=True)
            data["photos"][f"{bin_id}/{ph['id']}/{size}"] = "data:image/jpeg;base64," + base64.b64encode(img).decode()

name = out_dir / f"freezer-backup-{datetime.date.today().isoformat()}.json"
tmp = name.with_suffix(".tmp")
tmp.write_text(json.dumps(data), encoding="utf-8")
os.chmod(tmp, 0o600)
tmp.replace(name)
for old in sorted(out_dir.glob("freezer-backup-*.json"))[:-keep]:
    old.unlink()
print(f"{name.name}: {len(data['items'])} labels, {len(data['bins'])} bins, {len(data['photos']) // 2} photos")

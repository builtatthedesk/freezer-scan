#!/usr/bin/env python3
"""Nightly backup of a self-hosted Freezer Scan: one file in the same format as the
Back up button (public/backup.html), photos included, so it restores on any copy
(website, self-hosted, offline phone). Keeps the newest KEEP files (default 30).

    WRITE_KEY from the repo's .env;  python3 selfhost/nightly-backup.py <out-dir> [url]
    url defaults to http://127.0.0.1:8080 (the home compose app; on a VPS pass the site's https address).
"""
import base64, datetime, json, os, pathlib, sys, urllib.error, urllib.request

here = pathlib.Path(__file__).resolve().parent.parent
env = {}
for line in open(here / ".env", encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line: continue
    k, v = line.removeprefix("export ").split("=", 1)
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'": v = v[1:-1]
    else: v = v.split(" #", 1)[0].strip()
    env[k.strip()] = v
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
            try: img = get(f"photo/{bin_id}/{ph['id']}?size={size}", raw=True)
            except urllib.error.HTTPError: continue          # a missing photo: skip it, like the Back up button
            data["photos"][f"{bin_id}/{ph['id']}/{size}"] = "data:image/jpeg;base64," + base64.b64encode(img).decode()

# "nightly" in the name keeps these apart from files saved with the Back up button.
name = out_dir / f"freezer-nightly-{datetime.date.today().isoformat()}.json"
tmp = name.with_suffix(".tmp")
with open(tmp, "w", encoding="utf-8") as f:
    f.write(json.dumps(data)); f.flush(); os.fsync(f.fileno())
os.chmod(tmp, 0o600)
st = out_dir.stat()                                   # run as root: the files belong to the folder's owner
if os.geteuid() == 0: os.chown(tmp, st.st_uid, st.st_gid)
tmp.replace(name)
for old in sorted(out_dir.glob("freezer-nightly-*.json"))[:-keep]:
    old.unlink()
print(f"{name.name}: {len(data['items'])} labels, {len(data['bins'])} bins, {len(data['photos']) // 2} photos")

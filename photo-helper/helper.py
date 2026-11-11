"""Freezer Scan photo helper: photo -> suggested labels, using Claude Code on this PC.

Runs `claude -p` (your Claude subscription, no API key) on a photo the label
page sends, and answers with the foods it sees. Meant to sit behind
`tailscale serve` so only phones on your tailnet can reach it.

    POST /suggest   header x-key: <WRITE_KEY>   body {"image": "data:image/jpeg;base64,..."}
                    -> {"items": [{"name", "count", "date"}]}
    POST /print     header x-key   body {"image": "data:image/png;base64,..."}  (one finished label)
                    optional "printer": one of LABEL_PRINTER (default: the first)
                    -> {"ok": true, "printer": ...}  printed with label-print
    GET  /health    -> {"ok": true, "printer": <first or null>, "printers": [...]}

Settings (environment):
    FREEZER_WRITE_KEY   scanning key; default: WRITE_KEY from ../.keys.env
    HELPER_PORT         default 8795 (binds 127.0.0.1 only)
    HELPER_MODEL        default "sonnet"
    CLAUDE_BIN          default ~/.local/bin/claude.exe
    ALLOWED_ORIGINS     comma list; default https://freezer-scan.netlify.app
    LABEL_PRINT_DIR     label-print checkout; default ../../label-print
    LABEL_PRINTER       its printer profile(s), comma list; default "Garage QL-820NWB" (empty = none)
    PUBLIC_DIR          also serve the site from this folder (its public/), with /api/... passed
                        through to UPSTREAM and /api/config pointing at this helper. Lets the
                        pages run from an always-on box with no Netlify deploy (see README).
    UPSTREAM            default https://freezer-scan.netlify.app (where the list lives)
    KEEP_AWAKE_SECS     poke the printer this often; default 60 (0 = off). The QL-820NWB's
                        network ports drop into standby after ~3 idle minutes and then
                        barely answer, so a poke inside that window keeps it reachable.
"""
from __future__ import annotations

import base64
import datetime as dt
import hmac
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("HELPER_PORT", "8795"))
MODEL = os.environ.get("HELPER_MODEL", "sonnet")
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", str(Path.home() / ".local" / "bin" / ("claude.exe" if os.name == "nt" else "claude")))
ORIGINS = [o.strip() for o in os.environ.get(
    "ALLOWED_ORIGINS", "https://freezer-scan.netlify.app").split(",") if o.strip()]
MAX_BODY = 3_000_000
TIMEOUT = 150
ONE_AT_A_TIME = threading.Lock()
LP_DIR = Path(os.environ.get("LABEL_PRINT_DIR", HERE.parent.parent / "label-print"))
LP_PYTHON = LP_DIR / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
# Optional: also serve the site itself, so it can be used without a Netlify deploy.
# PUBLIC_DIR = the site's public/ folder; UPSTREAM = the Netlify site whose /api holds the
# list (same data as the public site). /api/config is answered here, pointing at this helper.
PUBLIC_DIR = Path(os.environ["PUBLIC_DIR"]).resolve() if os.environ.get("PUBLIC_DIR") else None
UPSTREAM = os.environ.get("UPSTREAM", "https://freezer-scan.netlify.app").rstrip("/")
MAX_PROXY_BODY = 12_000_000


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):   # never carry the key to another address
        return None


NO_REDIRECT = urllib.request.build_opener(_NoRedirect)
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
         ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
         ".json": "application/json", ".jpg": "image/jpeg", ".txt": "text/plain; charset=utf-8"}
PRINTERS = [p.strip() for p in os.environ.get("LABEL_PRINTER", "Garage QL-820NWB").split(",")
            if p.strip()] if (LP_DIR / "labelprint.py").exists() else []
PRINTER = PRINTERS[0] if PRINTERS else ""   # the default
PRINT_LOCK = threading.Lock()   # one job at a time, in order
KEEP_AWAKE_SECS = int(os.environ.get("KEEP_AWAKE_SECS", "60"))
# Under pythonw (autostart) every child would otherwise flash a console window.
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def printer_addr(printer: str = ""):
    """(host, port) of a printer profile's net:// transport in label-print's config, or None."""
    try:
        cfg = json.loads((LP_DIR / "config.json").read_text(encoding="utf-8-sig"))
        t = (cfg.get("printers") or {}).get(printer or PRINTER, {}).get("transport", "")
    except (OSError, ValueError):
        return None
    m = re.fullmatch(r"net://([^:/]+)(?::(\d+))?", t)
    return (m.group(1), int(m.group(2) or 9100)) if m else None


def poke(addr, timeout=3.0) -> bool:
    """Open and close a connection to the print port: wakes it, sends nothing."""
    try:
        socket.create_connection(addr, timeout=timeout).close()
        return True
    except OSError:
        return False


def wake(addr, within=20.0) -> bool:
    end = time.monotonic() + within
    while True:
        if poke(addr):
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(2)


def keep_awake(printer: str):
    addr, was = printer_addr(printer), None
    if not addr or KEEP_AWAKE_SECS <= 0:
        return
    while True:
        if not PRINT_LOCK.locked():
            up = poke(addr)
            if up != was:   # log changes only
                log(f"printer {addr[0]} {'answering' if up else 'not answering (off or asleep)'}")
                was = up
        time.sleep(KEEP_AWAKE_SECS)


def write_key() -> str:
    k = os.environ.get("FREEZER_WRITE_KEY")
    if k:
        return k
    env = HERE.parent / ".keys.env"
    if env.exists():
        for line in env.read_text(encoding="utf-8-sig").splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "WRITE_KEY":
                return value.strip().strip('"')
    sys.exit("No scanning key: set FREEZER_WRITE_KEY or put WRITE_KEY in ../.keys.env")


KEY = write_key()

PROMPT = """Read the photo at {path}. It shows food going into (or found in) a home freezer, most of it not yet labelled.
List each distinct food so a label can be printed for it.
- name: what a person would write on the label, 1-4 words, plain and specific ("Ground beef", "Chicken soup", "Blueberries"). Brand or product name only if that's how people would know it. Never a sentence.
- count: how many separate packs/bags/containers of that same food you can see (at least 1).
- date: only if a date is actually written or printed on the pack as a packed, frozen or made-on date (handwriting counts), as YYYY-MM-DD; a best-by/use-by date or no date at all -> null. If a handwritten date has no year, assume {year}.
Skip things that are not food. If you can't tell what something is, give a plain best guess ("Leftovers", "Frozen meat").
Reply with ONLY this JSON, nothing else: {{"items": [{{"name": "...", "count": 1, "date": null}}]}}"""


def origin_ok(origin: str) -> bool:
    # The live site, plus its Netlify draft/preview URLs (<id>--freezer-scan.netlify.app).
    if origin in ORIGINS:
        return True
    return any(re.fullmatch(r"https://[\w-]+--" + re.escape(o.split("://", 1)[1]), origin or "")
               for o in ORIGINS if o.startswith("https://"))


LABEL_SIZES = {"29x90", "23x23"}   # the page's long label and small square (DK-1201, DK-1221)


def print_label(png: bytes, printer: str, size: str = "") -> None:
    addr = printer_addr(printer)
    if addr and not wake(addr):
        raise RuntimeError(f"{addr[0]} not answering after 20 s")
    with tempfile.TemporaryDirectory(prefix="freezer-label-") as tmp:
        path = Path(tmp) / "label.png"
        path.write_bytes(png)
        # 9100 on the QL-8xx never answers a status request, hence --no-verify.
        cmd = [str(LP_PYTHON), "labelprint.py", "--printer", printer, "--no-verify", "image", str(path)]
        if size:
            cmd[-2:-2] = ["--label", size]
        proc = subprocess.run(cmd, cwd=str(LP_DIR), capture_output=True, text=True,
                              encoding="utf-8", timeout=60, stdin=subprocess.DEVNULL,
                              creationflags=NO_WINDOW)
    if proc.returncode != 0 or "sent " not in proc.stdout:
        raise RuntimeError(f"labelprint exit {proc.returncode}: {(proc.stderr or proc.stdout)[-300:]}")


def ask_claude(jpeg: bytes) -> list[dict]:
    with tempfile.TemporaryDirectory(prefix="freezer-photo-") as tmp:
        photo = Path(tmp) / "photo.jpg"
        photo.write_bytes(jpeg)
        cmd = [CLAUDE_BIN, "-p", PROMPT.format(path=photo, year=dt.date.today().year),
               "--allowedTools", "Read", "--model", MODEL,
               "--output-format", "json", "--no-session-persistence"]
        proc = subprocess.run(cmd, cwd=tmp, capture_output=True, text=True,
                              encoding="utf-8", timeout=TIMEOUT, stdin=subprocess.DEVNULL,
                              creationflags=NO_WINDOW)
    if proc.returncode != 0:
        raise RuntimeError(f"claude exit {proc.returncode}: {(proc.stderr or '')[:300]}")
    envelope = json.loads(proc.stdout)
    if envelope.get("is_error"):
        raise RuntimeError(f"claude error: {str(envelope.get('result'))[:300]}")
    text = str(envelope.get("result", ""))
    m = re.search(r"\{.*\}", text, re.DOTALL)
    data = json.loads(m.group(0) if m else text)
    out = []
    for i in (data.get("items") or [])[:20]:
        name = re.sub(r"\s+", " ", str(i.get("name") or "")).strip()[:60]
        if not name or re.match(r"^(LOC|CMD|BIN):", name, re.I):
            continue
        try:
            count = min(50, max(1, int(i.get("count") or 1)))
        except (TypeError, ValueError):
            count = 1
        date = i.get("date") if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(i.get("date") or "")) else None
        out.append({"name": name, "count": count, "date": date})
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "freezer-photo-helper"

    def cors(self):
        origin = self.headers.get("Origin", "")
        if origin_ok(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "x-key, content-type")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")

    def reply(self, status: int, body: dict):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.rstrip("/").endswith("/health"):
            return self.reply(200, {"ok": True, "printer": PRINTER or None, "printers": PRINTERS})
        if PUBLIC_DIR and path == "/api/config" and self.key_ok():
            host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host", "")
            return self.reply(200, {"suggestUrl": f"https://{host}" if host else None})
        if PUBLIC_DIR and path.startswith("/api/"):
            return self.proxy()
        if PUBLIC_DIR:
            return self.static(path)
        self.reply(404, {"error": "not found"})

    def do_PUT(self):
        return self.proxy() if PUBLIC_DIR and self.path.startswith("/api/") else self.reply(404, {"error": "not found"})

    do_DELETE = do_PUT

    def key_ok(self) -> bool:
        return hmac.compare_digest(self.headers.get("x-key", "").encode(), KEY.encode())

    def static(self, path: str):
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        f = (PUBLIC_DIR / rel).resolve()
        if f.is_dir():
            f = f / "index.html"
        if PUBLIC_DIR not in f.parents or not f.is_file():
            return self.reply(404, {"error": "not found"})
        raw = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(f.suffix.lower(), "application/octet-stream"))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def proxy(self):
        """Pass /api/... through to the Netlify site, so this copy shares its list."""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.reply(400, {"error": "Bad request."})
        if n > MAX_PROXY_BODY:
            return self.reply(413, {"error": "Too big."})
        body = self.rfile.read(n) if n else None
        headers = {h: self.headers[h] for h in ("x-key", "content-type", "accept") if self.headers.get(h)}
        req = urllib.request.Request(UPSTREAM + self.path, data=body, method=self.command, headers=headers)
        try:
            with NO_REDIRECT.open(req, timeout=60) as r:
                status, rh, raw = r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:   # includes 3xx, passed back as-is
            status, rh, raw = e.code, e.headers, e.read()
        except Exception as e:  # noqa: BLE001 - bad path, upstream gone, truncated body
            log(f"proxy failed: {self.command} {self.path.split('?')[0]}: {e}")
            return self.reply(502, {"error": "Can't reach the freezer list right now. Try again."})
        self.send_response(status)
        for h in ("Content-Type", "Cache-Control"):
            if rh.get(h):
                self.send_header(h, rh[h])
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        if PUBLIC_DIR and self.path.startswith("/api/"):
            return self.proxy()
        # tailscale serve may or may not strip its mount path, so match the tail.
        route = self.path.split("?")[0].rstrip("/").rsplit("/", 1)[-1]
        if route not in ("suggest", "print"):
            return self.reply(404, {"error": "not found"})
        if not self.key_ok():
            return self.reply(401, {"error": "This link is missing its key."})
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.reply(400, {"error": "Bad request."})
        if n <= 0 or n > MAX_BODY:
            return self.reply(413, {"error": "That image is too big."})
        if route == "print":
            return self.do_print(n)
        try:
            body = json.loads(self.rfile.read(n))
            m = re.fullmatch(r"data:image/jpeg;base64,([A-Za-z0-9+/=]+)", body.get("image", ""))
            jpeg = base64.b64decode(m.group(1)) if m else b""
        except Exception:
            jpeg = b""
        if jpeg[:2] != b"\xff\xd8":
            return self.reply(400, {"error": "That photo did not come through (JPEG only)."})
        if not ONE_AT_A_TIME.acquire(timeout=TIMEOUT):
            return self.reply(503, {"error": "Busy with another photo. Try again in a minute."})
        try:
            items = ask_claude(jpeg)
        except Exception as e:  # noqa: BLE001 - any failure is a "try again"
            log(f"suggest failed: {type(e).__name__}: {e}")
            return self.reply(502, {"error": "Couldn't read the photo just now. Try again, or type it in."})
        finally:
            ONE_AT_A_TIME.release()
        log(f"suggest ok: {len(items)} item(s)")
        self.reply(200, {"items": items})

    def do_print(self, n: int):
        if not PRINTER:
            return self.reply(501, {"error": "This computer has no label printer set up."})
        try:
            body = json.loads(self.rfile.read(n))
            m = re.fullmatch(r"data:image/png;base64,([A-Za-z0-9+/=]+)", body.get("image", ""))
            png = base64.b64decode(m.group(1)) if m else b""
            printer = body.get("printer", PRINTER)
            size = body.get("label", "")
        except Exception:
            png, printer, size = b"", PRINTER, 
        if png[:4] != b"\x89PNG":
            return self.reply(400, {"error": "That label did not come through (PNG only)."})
        if printer not in PRINTERS:
            return self.reply(400, {"error": "This computer doesn't know that printer."})
        if size and size not in LABEL_SIZES:
            return self.reply(400, {"error": "This computer doesn't know that label size."})
        with PRINT_LOCK:
            try:
                print_label(png, printer, size)
            except Exception as e:  # noqa: BLE001
                log(f"print failed on {printer}: {type(e).__name__}: {e}")
                return self.reply(502, {"error": f"The {printer} didn't take it. Is it on? Try again."})
        log(f"print ok on {printer}" + (f" ({size})" if size else ""))
        self.reply(200, {"ok": True, "printer": printer})

    def log_message(self, fmt, *args):
        if os.environ.get("HELPER_DEBUG"):
            log(f"req {self.command} {self.path} origin={self.headers.get('Origin')} -> {args[1] if len(args) > 1 else ''}")


def log(msg: str):
    line = f"{dt.datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    print(line, flush=True)
    try:
        with open(HERE / "helper.log", "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


if __name__ == "__main__":
    log(f"listening on 127.0.0.1:{PORT}, model {MODEL}, printers {', '.join(PRINTERS) or 'none'}")
    for p in PRINTERS:
        threading.Thread(target=keep_awake, args=(p,), daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

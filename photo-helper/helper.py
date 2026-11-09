"""Freezer Scan photo helper: photo -> suggested labels, using Claude Code on this PC.

Runs `claude -p` (your Claude subscription, no API key) on a photo the label
page sends, and answers with the foods it sees. Meant to sit behind
`tailscale serve` so only phones on your tailnet can reach it.

    POST /suggest   header x-key: <WRITE_KEY>   body {"image": "data:image/jpeg;base64,..."}
                    -> {"items": [{"name", "count", "date"}]}
    POST /print     header x-key   body {"image": "data:image/png;base64,..."}  (one finished label)
                    -> {"ok": true, "printer": ...}  printed with label-print on LABEL_PRINTER
    GET  /health    -> {"ok": true, "printer": <name or null>}

Settings (environment):
    FREEZER_WRITE_KEY   scanning key; default: WRITE_KEY from ../.keys.env
    HELPER_PORT         default 8795 (binds 127.0.0.1 only)
    HELPER_MODEL        default "sonnet"
    CLAUDE_BIN          default ~/.local/bin/claude.exe
    ALLOWED_ORIGINS     comma list; default https://freezer-scan.netlify.app
    LABEL_PRINT_DIR     label-print checkout; default ../../label-print
    LABEL_PRINTER       its printer profile; default "Garage QL-820NWB" (empty = no printing)
"""
from __future__ import annotations

import base64
import datetime as dt
import hmac
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("HELPER_PORT", "8795"))
MODEL = os.environ.get("HELPER_MODEL", "sonnet")
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", str(Path.home() / ".local" / "bin" / "claude.exe"))
ORIGINS = [o.strip() for o in os.environ.get(
    "ALLOWED_ORIGINS", "https://freezer-scan.netlify.app").split(",") if o.strip()]
MAX_BODY = 3_000_000
TIMEOUT = 150
ONE_AT_A_TIME = threading.Lock()
LP_DIR = Path(os.environ.get("LABEL_PRINT_DIR", HERE.parent.parent / "label-print"))
LP_PYTHON = LP_DIR / ".venv" / "Scripts" / "python.exe"
PRINTER = os.environ.get("LABEL_PRINTER", "Garage QL-820NWB") if (LP_DIR / "labelprint.py").exists() else ""
PRINT_LOCK = threading.Lock()   # one job at a time, in order


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


def print_label(png: bytes) -> None:
    with tempfile.TemporaryDirectory(prefix="freezer-label-") as tmp:
        path = Path(tmp) / "label.png"
        path.write_bytes(png)
        # 9100 on the QL-8xx never answers a status request, hence --no-verify.
        cmd = [str(LP_PYTHON), "labelprint.py", "--printer", PRINTER, "--no-verify", "image", str(path)]
        proc = subprocess.run(cmd, cwd=str(LP_DIR), capture_output=True, text=True,
                              encoding="utf-8", timeout=60)
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
                              encoding="utf-8", timeout=TIMEOUT)
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
        if self.path.rstrip("/").endswith("/health"):
            return self.reply(200, {"ok": True, "printer": PRINTER or None})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        # tailscale serve may or may not strip its mount path, so match the tail.
        route = self.path.split("?")[0].rstrip("/").rsplit("/", 1)[-1]
        if route not in ("suggest", "print"):
            return self.reply(404, {"error": "not found"})
        if not hmac.compare_digest(self.headers.get("x-key", ""), KEY):
            return self.reply(401, {"error": "This link is missing its key."})
        n = int(self.headers.get("Content-Length") or 0)
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
            m = re.fullmatch(r"data:image/png;base64,([A-Za-z0-9+/=]+)", json.loads(self.rfile.read(n)).get("image", ""))
            png = base64.b64decode(m.group(1)) if m else b""
        except Exception:
            png = b""
        if png[:4] != b"\x89PNG":
            return self.reply(400, {"error": "That label did not come through (PNG only)."})
        with PRINT_LOCK:
            try:
                print_label(png)
            except Exception as e:  # noqa: BLE001
                log(f"print failed: {type(e).__name__}: {e}")
                return self.reply(502, {"error": f"The {PRINTER} didn't take it. Is it on? Try again."})
        log("print ok")
        self.reply(200, {"ok": True, "printer": PRINTER})

    def log_message(self, fmt, *args):
        pass


def log(msg: str):
    line = f"{dt.datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    print(line, flush=True)
    try:
        with open(HERE / "helper.log", "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


if __name__ == "__main__":
    log(f"listening on 127.0.0.1:{PORT}, model {MODEL}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

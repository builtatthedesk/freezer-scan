// Self-hosted Freezer Scan: serves public/ and runs the same API code Netlify runs
// (netlify/functions/api.mjs), with @netlify/blobs swapped for files in DATA_DIR.
// Plain HTTP on PORT (default 8080). Put HTTPS in front (Caddy, Tailscale, Cloudflare):
// phone cameras only work on https pages.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import api from "./netlify/functions/api.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 5e6;   // a bin photo is at most ~2 MB once base64'd
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };
// The same headers netlify.toml sets.
const PRIVATE = new Set(["/index.html", "/list.html", "/bins.html", "/label.html", "/backup.html"]);
const BASE = { "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) throw Object.assign(new Error("too big"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const KEYS = [process.env.WRITE_KEY, process.env.READ_KEY, process.env.DEMO === "1" ? "demo" : null].filter(Boolean);

async function handleApi(req, res) {
  // Reject keyless requests before reading any body, so strangers can't make us buffer uploads.
  if (!KEYS.includes(req.headers["x-key"]) && KEYS.length === (process.env.DEMO === "1" ? 3 : 2)) {
    res.writeHead(401, { ...BASE, "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "This link is missing its key. Ask for the link again." }));
    return;
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const request = new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body });
  const out = await api(request);
  res.writeHead(out.status, { ...BASE, ...Object.fromEntries(out.headers) });
  res.end(Buffer.from(await out.arrayBuffer()));
}

async function handleStatic(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); }
  catch { res.writeHead(400).end(); return; }
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(400).end(); return; }
  let data;
  try { data = await fs.readFile(file); }
  catch { res.writeHead(404, { ...BASE, "content-type": "text/plain" }).end("Not found"); return; }
  const headers = { ...BASE, "content-type": TYPES[path.extname(file)] || "application/octet-stream" };
  if (PRIVATE.has(p)) headers["x-robots-tag"] = "noindex, nofollow";
  headers["cache-control"] = p.endsWith(".html") ? "no-cache" : "public, max-age=86400";
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : data);
}

// docker stop sends SIGTERM; writes are atomic renames, so exiting at once is safe.
process.on("SIGTERM", () => process.exit(0));

http.createServer(async (req, res) => {
  try {
    if (req.url === "/api" || req.url.startsWith("/api/")) await handleApi(req, res);
    else if (req.method === "GET" || req.method === "HEAD") await handleStatic(req, res);
    else res.writeHead(405).end();
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) res.writeHead(e.status || 500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.status === 413 ? "too big" : "server error" }));
  }
}).listen(PORT, () => console.log(`Freezer Scan on port ${PORT}, data in ${process.env.DATA_DIR || "/data"}`));

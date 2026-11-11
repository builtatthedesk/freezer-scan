// Freezer Scan, offline edition: the "server" that lives on the phone.
// The pages are the same as the website's. They call /api/...; this service worker
// answers those calls from the phone's own storage (IndexedDB) instead of the
// internet, and serves the pages themselves from its cache, so after the first
// visit the app works with no connection at all.
//
// Same routes as netlify/functions/api.mjs, minus keys (one phone, one owner),
// plus two of its own for the Share & back up page:
//   GET  /api/backup             everything except photo data, as one JSON object
//                                (the page adds the photos one by one; see share.html)
//   POST /api/restore            merge a backup's labels, bins and counters in
//   PUT  /api/restore-photo/:bin/:pid/:size   one photo from a backup, if missing here
// Every saved item gets a "modAt" stamp, so a restore can tell which copy of a label
// was changed last, even for changes that aren't scans (marked used, moved freezer).
"use strict";
const VERSION = "__VERSION__";            // filled in by build.mjs; a new value = an update
const CACHE = "freezer-offline-" + VERSION;
const FILES = __FILES__;                   // the app's files, filled in by build.mjs

self.addEventListener("install", (e) => {
  // cache:"reload" skips the browser's HTTP cache, so an update never stores old files.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith("freezer-offline-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;            // fonts etc.: the browser's business
  const scope = new URL(self.registration.scope).pathname;
  if (url.pathname.startsWith(scope + "api/")) {
    e.respondWith(api(e.request, url, url.pathname.slice(scope.length + 4)).catch(err =>
      json(500, { error: "Phone storage problem: " + (err && err.message || err) })));
    return;
  }
  if (e.request.method !== "GET") return;
  // The app's own files: from the cache (works offline); anything else from the network.
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});

// ------------------------------------------------------------------ storage
// One IndexedDB database: "kv" holds the items and bins objects and the daily
// label counters; "photos" holds bin photos as Blobs; "log" the last scans.
let dbp = null;
function db(){
  return dbp || (dbp = new Promise((ok, bad) => {
    const r = indexedDB.open("freezer-offline", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("kv");
      d.createObjectStore("photos");
      d.createObjectStore("log", { autoIncrement: true });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => { dbp = null; bad(r.error); };
  }));
}
const done = (req) => new Promise((ok, bad) => { req.onsuccess = () => ok(req.result); req.onerror = () => bad(req.error); });
async function tx(stores, mode, fn){
  const t = (await db()).transaction(stores, mode);
  const end = new Promise((ok, bad) => { t.oncomplete = ok; t.onerror = t.onabort = () => bad(t.error); });
  const out = await fn(t);
  await end;
  return out;
}
const kvGet = (key) => tx("kv", "readonly", t => done(t.objectStore("kv").get(key)));
// Read-modify-write inside one transaction, so two quick scans can't lose each other.
// fn changes the value in place and may return a Response to stop without saving.
function kvUpdate(key, fn){
  return tx("kv", "readwrite", async (t) => {
    const s = t.objectStore("kv");
    const cur = (await done(s.get(key))) || {};
    const stop = fn(cur);
    if (stop) return stop;
    s.put(cur, key);
    return null;
  });
}

// ------------------------------------------------------------------ helpers
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const readJson = (req) => req.json().catch(() => undefined);
const ID_RE = /^[\w.:-]{1,80}$/;
const ITEM_FIELDS = ["text", "labelId", "printed", "shelf", "status", "inAt", "outAt", "firstSeen", "lastScan"];
function cleanItem(body){
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const out = {};
  for (const k of ITEM_FIELDS) {
    const v = body[k];
    if (v == null) continue;
    if (typeof v !== "string" || v.length > 200) return null;
    out[k] = v;
  }
  if (!out.text || (out.status !== "in" && out.status !== "out")) return null;
  return out;
}
const MAX_PHOTOS = 30, MAX_PHOTO_BYTES = 1.5e6, MAX_THUMB_BYTES = 150e3, MAX_LOG = 500;
function jpegFrom(dataUrl, max){
  const m = typeof dataUrl === "string" && dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const bin = atob(m[1]);
  if (bin.length > max || bin.charCodeAt(0) !== 0xff || bin.charCodeAt(1) !== 0xd8) return null;
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new Blob([a], { type: "image/jpeg" });
}
const photoKeys = (bin, pid) => [`${bin}/${pid}/full`, `${bin}/${pid}/thumb`];
const dropPhotos = (bin, pids) => tx("photos", "readwrite", (t) => { for (const pid of pids) for (const k of photoKeys(bin, pid)) t.objectStore("photos").delete(k); });
// Today on this phone's clock, as the server would date a label ID.
function localDay(){ const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); }
// Label IDs count from 5001, like the website, so they never meet the desktop tool's 001, 002...
const WEB_ID_START = 5001;

// ------------------------------------------------------------------ the API
async function api(req, url, rest){
  const path = rest.split("/").filter(Boolean).map(decodeURIComponent);
  const M = req.method, now = new Date().toISOString();

  if (M === "GET" && path[0] === "items" && !path[1])
    return json(200, { items: (await kvGet("items")) || {}, at: now, canWrite: true });
  if (M === "GET" && path[0] === "bins" && !path[1])
    return json(200, { bins: (await kvGet("bins")) || {}, at: now, canWrite: true });
  if (M === "GET" && path[0] === "photo" && ID_RE.test(path[1] || "") && ID_RE.test(path[2] || "") && !path[3]) {
    const size = url.searchParams.get("size") === "full" ? "full" : "thumb";
    const b = await tx("photos", "readonly", t => done(t.objectStore("photos").get(`${path[1]}/${path[2]}/${size}`)));
    return b ? new Response(b, { headers: { "content-type": "image/jpeg" } }) : json(404, { error: "no such photo" });
  }
  // One phone, one list: the "share" key is just a marker the pages carry around.
  if (M === "GET" && path[0] === "share") return json(200, { readKey: "local" });
  if (M === "GET" && path[0] === "config") return json(200, { suggestUrl: null, offline: true });
  if (M === "POST" && path[0] === "suggest")
    return json(501, { error: "Photo suggestions need the internet, so they aren't in the offline edition. Type the name in." });

  if (path[0] === "items" && path[1] && ID_RE.test(path[1]) && !path[2] && (M === "PUT" || M === "DELETE")) {
    const body = M === "PUT" ? cleanItem(await readJson(req)) : null;
    if (M === "PUT" && !body) return json(400, { error: "bad item" });
    if (body) body.modAt = now;
    await kvUpdate("items", (items) => { if (body) items[path[1]] = body; else delete items[path[1]]; });
    return json(200, { ok: true });
  }

  if (path[0] === "bins" && ID_RE.test(path[1] || "")) {
    const id = path[1];
    if (!path[2] && M === "PUT") {
      const b = await readJson(req);
      const name = b && typeof b.name === "string" ? b.name.replace(/\s+/g, " ").trim() : "";
      const notes = b && typeof b.notes === "string" ? b.notes.slice(0, 2000) : undefined;
      if (!name || name.length > 80) return json(400, { error: "A bin needs a name (80 letters at most)." });
      await kvUpdate("bins", (bins) => {
        const old = bins[id] || { notes: "", photos: [], createdAt: now };
        bins[id] = Object.assign({}, old, { name, notes: notes === undefined ? old.notes : notes, updatedAt: now });
      });
      return json(200, { ok: true });
    }
    if (!path[2] && M === "DELETE") {
      let pids = [];
      await kvUpdate("bins", (bins) => { pids = ((bins[id] || {}).photos || []).map(p => p.id); delete bins[id]; });
      await dropPhotos(id, pids);
      return json(200, { ok: true });
    }
    if (path[2] === "photos" && !path[3] && M === "POST") {
      const b = await readJson(req);
      const full = jpegFrom(b && b.full, MAX_PHOTO_BYTES), thumb = jpegFrom(b && b.thumb, MAX_THUMB_BYTES);
      if (!full || !thumb) return json(400, { error: "That photo did not come through (JPEG, 1.5 MB at most)." });
      const pid = now.replace(/[^0-9]/g, "").slice(0, 14) + Math.random().toString(36).slice(2, 6);
      const [kf, kt] = photoKeys(id, pid);
      await tx("photos", "readwrite", (t) => { t.objectStore("photos").put(full, kf); t.objectStore("photos").put(thumb, kt); });
      const stop = await kvUpdate("bins", (bins) => {
        if (!bins[id]) return json(404, { error: "No such bin. Make its label first." });
        if ((bins[id].photos || []).length >= MAX_PHOTOS) return json(400, { error: "This bin has as many photos as it can hold. Delete an old one first." });
        bins[id].photos = [{ id: pid, at: now }].concat(bins[id].photos || []);
        bins[id].updatedAt = now;
      });
      if (stop) { await dropPhotos(id, [pid]); return stop; }
      return json(200, { ok: true, photo: { id: pid, at: now } });
    }
    if (path[2] === "photos" && ID_RE.test(path[3] || "") && M === "DELETE") {
      const pid = path[3];
      const stop = await kvUpdate("bins", (bins) => {
        if (!bins[id]) return json(404, { error: "No such bin." });
        bins[id].photos = (bins[id].photos || []).filter(p => p.id !== pid);
        bins[id].updatedAt = now;
      });
      if (stop) return stop;
      await dropPhotos(id, [pid]);
      return json(200, { ok: true });
    }
  }

  if (M === "POST" && path[0] === "ids") {
    const n = Math.max(1, Math.min(50, Number(((await readJson(req)) || {}).n) || 1));
    const today = localDay(), day = today.slice(2).replace(/-/g, "");
    let first = 0;
    await kvUpdate("ids", (c) => { first = c[day] || WEB_ID_START; c[day] = first + n; });
    return json(200, { ids: Array.from({ length: n }, (_, k) => day + "-" + (first + k)), date: today });
  }

  if (M === "POST" && path[0] === "log") {
    const e = await readJson(req);
    if (!e || typeof e !== "object" || JSON.stringify(e).length > 2000) return json(400, { error: "bad log entry" });
    await tx("log", "readwrite", async (t) => {
      const s = t.objectStore("log");
      s.add(Object.assign({ at: now }, e));
      const keys = await done(s.getAllKeys());
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_LOG))) s.delete(k);
    });
    return json(200, { ok: true });
  }

  if (M === "GET" && path[0] === "backup" && !path[1]) return json(200, await backup(now));
  if (M === "POST" && path[0] === "restore" && !path[1]) {
    const b = await readJson(req);
    if (!b || b.app !== "freezer-scan" || typeof b.items !== "object")
      return json(400, { error: "That file isn't a Freezer Scan backup." });
    return json(200, await restore(b));
  }
  if (M === "PUT" && path[0] === "restore-photo" && ID_RE.test(path[1] || "") && ID_RE.test(path[2] || "") && (path[3] === "full" || path[3] === "thumb") && !path[4]) {
    const k = `${path[1]}/${path[2]}/${path[3]}`;
    const bins = (await kvGet("bins")) || {};
    if (!((bins[path[1]] || {}).photos || []).some(p => p.id === path[2])) return json(404, { error: "no such photo in this bin" });
    const blob = jpegFrom(((await readJson(req)) || {}).data, path[3] === "full" ? MAX_PHOTO_BYTES : MAX_THUMB_BYTES);
    if (!blob) return json(400, { error: "bad photo" });
    const added = await tx("photos", "readwrite", async (t) => {
      const s = t.objectStore("photos");
      if ((await done(s.getKey(k))) !== undefined) return false;
      s.put(blob, k);
      return true;
    });
    return json(200, { ok: true, added });
  }
  return json(404, { error: "not found" });
}

// ------------------------------------------------------------------ backup / restore
async function backup(now){
  const [items, bins, ids] = await Promise.all([kvGet("items"), kvGet("bins"), kvGet("ids")]);
  return { app: "freezer-scan", kind: "backup", version: 1, at: now, items: items || {}, bins: bins || {}, ids: ids || {} };
}

// Merge, never wipe: a label already on this phone keeps whichever copy was changed
// last (modAt, else its last scan; on a tie this phone's copy stays). Bins keep the
// newest edit and gain any photos they were missing. Restoring twice changes nothing.
// Everything is checked before anything is saved, so a bad file changes nothing.
function cleanBin(bin){
  if (!bin || typeof bin !== "object" || typeof bin.name !== "string") return null;
  const name = bin.name.replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) return null;
  const str = (v) => typeof v === "string" ? v.slice(0, 40) : undefined;
  const photos = (Array.isArray(bin.photos) ? bin.photos : [])
    .filter(p => p && typeof p === "object" && ID_RE.test(p.id || ""))
    .map(p => ({ id: p.id, at: str(p.at) || "" })).slice(0, MAX_PHOTOS);
  return { name, notes: typeof bin.notes === "string" ? bin.notes.slice(0, 2000) : "", photos,
           createdAt: str(bin.createdAt) || "", updatedAt: str(bin.updatedAt) || "" };
}
const stampOf = (it) => String((it && (it.modAt || it.lastScan)) || "");
async function restore(b){
  const inItems = [], inBins = [];
  for (const [id, raw] of Object.entries(b.items || {})) {
    const it = ID_RE.test(id) && cleanItem(raw);
    if (!it) continue;
    if (typeof raw.modAt === "string" && raw.modAt.length <= 40) it.modAt = raw.modAt;
    inItems.push([id, it]);
  }
  for (const [id, raw] of Object.entries(b.bins && typeof b.bins === "object" ? b.bins : {})) {
    const bin = ID_RE.test(id) && cleanBin(raw);
    if (bin) inBins.push([id, bin]);
  }
  let added = 0, updated = 0, binsAdded = 0;
  await kvUpdate("items", (items) => {
    for (const [id, it] of inItems) {
      if (!items[id]) { items[id] = it; added++; }
      else if (stampOf(it) > stampOf(items[id])) { items[id] = it; updated++; }
    }
  });
  await kvUpdate("bins", (bins) => {
    for (const [id, bin] of inBins) {
      const have = bins[id];
      if (!have) { binsAdded++; bins[id] = bin; continue; }
      const merged = Object.assign({}, String(bin.updatedAt) > String(have.updatedAt || "") ? bin : have);
      const ids = new Set((have.photos || []).map(p => p.id));
      merged.photos = (have.photos || []).concat(bin.photos.filter(p => !ids.has(p.id))).slice(0, MAX_PHOTOS);
      bins[id] = merged;
    }
  });
  // Label counters never go backwards, so new labels can't reuse a restored ID.
  await kvUpdate("ids", (c) => { for (const [d, n] of Object.entries(b.ids || {})) if (/^\d{6}$/.test(d) && Number(n) > (c[d] || 0)) c[d] = Number(n); });
  return { ok: true, added, updated, binsAdded };
}

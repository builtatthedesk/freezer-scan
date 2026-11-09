// Freezer list API. The whole list is one JSON blob ({ id: item }), updated with
// compare-and-swap on its etag so two phones scanning at once can't lose a write.
//   GET    /api/items          read key or write key -> { items, at, canWrite }
//   PUT    /api/items/:id      write key, body = item
//   DELETE /api/items/:id      write key
//   POST   /api/ids            write key, body { n } -> { ids } fresh label IDs
//   POST   /api/log            write key, body = scan-log entry (append-only)
//   GET    /api/share          write key -> { readKey } for the family-list link
//   POST   /api/suggest        write key, body { image } JPEG data URL -> { items: [{ name, count, date }] },
//                               suggested labels for the food in a photo (netlify/lib/label-ai.mjs)
// Storage bins (attic boxes): one JSON blob { id: bin }, photos as separate blobs.
//   GET    /api/bins                     read key -> { bins, canWrite }
//   PUT    /api/bins/:id                 write key, body { name, notes } (creates or renames)
//   DELETE /api/bins/:id                 write key, removes the bin and its photos
//   POST   /api/bins/:id/photos          write key, body { full, thumb } as JPEG data URLs
//   DELETE /api/bins/:id/photos/:pid     write key
//   GET    /api/photo/:id/:pid?size=thumb|full   read key -> image/jpeg
// Keys come from the READ_KEY / WRITE_KEY env vars and arrive in the x-key header.
// With DEMO=1 the key "demo" opens a separate sample list anyone may scan into;
// it is reset to the sample food whenever it is more than a day old.
import { getStore } from "@netlify/blobs";
import { suggestLabels, labelAiReady } from "../lib/label-ai.mjs";

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

// An item as the pages write it: known fields only, all short strings.
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
const readJson = (req) => req.json().catch(() => undefined);
const ID_RE = /^[\w.:-]{1,80}$/;

// Read-modify-write a JSON blob with compare-and-swap; fn returns a Response to stop early.
async function updateJson(store, key, fn){
  for (let i = 0; i < 8; i++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    if (cur && !cur.etag) return json(500, { error: "storage gave no version tag" });
    const data = (cur && cur.data) || {};
    const stop = fn(data);
    if (stop) return stop;
    const opts = cur ? { onlyIfMatch: cur.etag, metadata: cur.metadata } : { onlyIfNew: true };
    const res = await store.setJSON(key, data, opts);
    if (res.modified) return null;
  }
  return json(409, { error: "busy, try again" });
}

const MAX_PHOTOS = 30, MAX_PHOTO_BYTES = 1.5e6, MAX_THUMB_BYTES = 150e3;
function jpegFrom(dataUrl, max){
  const m = typeof dataUrl === "string" && dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > max || buf[0] !== 0xff || buf[1] !== 0xd8) return null;   // JPEG starts FF D8
  return buf;
}
async function dropPhotos(store, binId, pids){
  await Promise.all(pids.flatMap(pid => [store.delete(`photo/${binId}/${pid}/full`), store.delete(`photo/${binId}/${pid}/thumb`)]));
}

// Keys must survive the trip through a link (#w=...), so: letters, digits, _ and -,
// at least 16 long, and the two must differ.
function keyProblem(){
  const ok = (k) => typeof k === "string" && /^[\w-]{16,}$/.test(k);
  if (!ok(process.env.WRITE_KEY) || !ok(process.env.READ_KEY))
    return "WRITE_KEY and READ_KEY must each be at least 16 letters, numbers, _ or - (set them in Netlify or your .env file, then redeploy or restart).";
  if (process.env.WRITE_KEY === process.env.READ_KEY) return "WRITE_KEY and READ_KEY must be different.";
  return null;
}

// Web-made label IDs count from 5001 so they never meet the desktop label
// tool's own daily counter (001, 002, ...).
const WEB_ID_START = 5001;

function demoItems(){
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const yymmdd = (d) => d.slice(2).replace(/-/g, "");
  const rows = [
    ["Chicken thighs", 12, "Garage freezer"], ["Chicken thighs", 12, "Garage freezer"],
    ["Meatloaf", 40, "Kitchen freezer"], ["Beef stew", 95, "Basement freezer"],
    ["Blueberries", 200, "Kitchen freezer"], ["Pork chops", 3, "Garage freezer"],
    ["Pizza dough", 60, "Kitchen freezer"], ["Salmon fillets", 150, "Basement freezer"],
    ["Chicken soup", 25, "Basement freezer"], ["Ground beef", 7, "Garage freezer"],
  ];
  const items = {};
  rows.forEach(([text, age, shelf], i) => {
    const d = day(age), id = yymmdd(d) + "-" + String(i + 1).padStart(3, "0");
    const at = d + "T18:00:00.000Z";
    items[id] = { text, printed: d, labelId: id, shelf, status: "in", firstSeen: at, inAt: at, lastScan: at };
  });
  return items;
}

function demoBins(){
  const at = new Date().toISOString();
  const bins = {};
  [["Christmas 1", "Lights, extension cords"], ["Christmas 2", "Ornaments (glass, wrapped)"], ["Camping gear", "Tent, two sleeping bags, lantern"]]
    .forEach(([name, notes], i) => { bins["000000-" + (9001 + i)] = { name, notes, photos: [], createdAt: at, updatedAt: at }; });
  return bins;
}
async function readBins(store, demo){
  if (!demo) return (await store.get("bins", { type: "json" })) || {};
  const cur = await store.getWithMetadata("bins", { type: "json" });
  if (cur && Date.now() - Date.parse((cur.metadata && cur.metadata.seeded) || 0) < 864e5) return cur.data;
  const { blobs } = await store.list({ prefix: "photo/" });       // yesterday's demo photos go too
  for (const b of blobs) await store.delete(b.key);
  const bins = demoBins();
  await store.setJSON("bins", bins, { metadata: { seeded: new Date().toISOString() } });
  return bins;
}

async function readItems(store, demo){
  if (!demo) return (await store.get("items", { type: "json" })) || {};
  const cur = await store.getWithMetadata("items", { type: "json" });
  const fresh = cur && cur.metadata && Date.now() - Date.parse(cur.metadata.seeded || 0) < 864e5;
  if (fresh) return cur.data;
  const items = demoItems();
  await store.setJSON("items", items, { metadata: { seeded: new Date().toISOString() } });
  return items;
}

export default async (req) => {
  const key = req.headers.get("x-key") || "";
  const problem = keyProblem();
  if (problem) return json(500, { error: "Setup problem: " + problem });
  const demo = process.env.DEMO === "1" && key === "demo";
  const canWrite = demo || (!!process.env.WRITE_KEY && key === process.env.WRITE_KEY);
  const canRead = canWrite || (!!process.env.READ_KEY && key === process.env.READ_KEY);
  if (!canRead) return json(401, { error: "This link is missing its key. Ask for the link again." });

  const store = getStore({ name: demo ? "freezer-demo" : "freezer", consistency: "strong" });
  const path = new URL(req.url).pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);

  if (req.method === "GET" && path[0] === "items" && !path[1]) {
    const items = await readItems(store, demo);
    return json(200, { items, at: new Date().toISOString(), canWrite, demo });
  }
  if (req.method === "GET" && path[0] === "bins" && !path[1]) {
    return json(200, { bins: await readBins(store, demo), at: new Date().toISOString(), canWrite, demo });
  }
  if (req.method === "GET" && path[0] === "photo" && ID_RE.test(path[1] || "") && ID_RE.test(path[2] || "") && !path[3]) {
    const size = new URL(req.url).searchParams.get("size") === "full" ? "full" : "thumb";
    const buf = await store.get(`photo/${path[1]}/${path[2]}/${size}`, { type: "arrayBuffer" });
    if (!buf) return json(404, { error: "no such photo" });
    return new Response(buf, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } });
  }
  if (!canWrite) return json(403, { error: "This link can only view the list." });

  if (req.method === "GET" && path[0] === "share") {
    if (demo) return json(200, { readKey: "demo" });
    return json(200, { readKey: process.env.READ_KEY });
  }

  if (path[0] === "items" && path[1] && /^[\w.:-]{1,80}$/.test(path[1]) && (req.method === "PUT" || req.method === "DELETE")) {
    const id = path[1];
    const body = req.method === "PUT" ? cleanItem(await readJson(req)) : null;
    if (req.method === "PUT" && !body) return json(400, { error: "bad item" });
    for (let i = 0; i < 8; i++) {
      const cur = await store.getWithMetadata("items", { type: "json" });
      const items = (cur && cur.data) || {};
      if (body) {
        if (demo && !items[id] && Object.keys(items).length >= 200) return json(400, { error: "The demo list is full." });
        items[id] = body;
      } else delete items[id];
      if (cur && !cur.etag) return json(500, { error: "storage gave no version tag" });
      const opts = cur ? { onlyIfMatch: cur.etag, metadata: cur.metadata } : { onlyIfNew: true };
      const res = await store.setJSON("items", items, opts);
      if (res.modified) return json(200, { ok: true });
    }
    return json(409, { error: "busy, try again" });
  }

  if (path[0] === "bins" && ID_RE.test(path[1] || "")) {
    const id = path[1], now = new Date().toISOString();
    if (demo) await readBins(store, demo);
    if (!path[2] && req.method === "PUT") {
      const b = await readJson(req);
      const name = b && typeof b.name === "string" ? b.name.replace(/\s+/g, " ").trim() : "";
      const notes = b && typeof b.notes === "string" ? b.notes.slice(0, 2000) : undefined;
      if (!name || name.length > 80) return json(400, { error: "A bin needs a name (80 letters at most)." });
      const stop = await updateJson(store, "bins", (bins) => {
        if (demo && !bins[id] && Object.keys(bins).length >= 40) return json(400, { error: "The demo has enough bins." });
        const old = bins[id] || { notes: "", photos: [], createdAt: now };
        bins[id] = Object.assign({}, old, { name, notes: notes === undefined ? old.notes : notes, updatedAt: now });
      });
      return stop || json(200, { ok: true });
    }
    if (!path[2] && req.method === "DELETE") {
      let pids = [];
      const stop = await updateJson(store, "bins", (bins) => { pids = ((bins[id] || {}).photos || []).map(p => p.id); delete bins[id]; });
      if (stop) return stop;
      await dropPhotos(store, id, pids);
      return json(200, { ok: true });
    }
    if (path[2] === "photos" && !path[3] && req.method === "POST") {
      if (demo) return json(403, { error: "Photos are turned off in the demo. On your own copy, this is where the photo goes." });
      const b = await readJson(req);
      const full = jpegFrom(b && b.full, MAX_PHOTO_BYTES), thumb = jpegFrom(b && b.thumb, MAX_THUMB_BYTES);
      if (!full || !thumb) return json(400, { error: "That photo did not come through (JPEG, 1.5 MB at most)." });
      const pid = now.replace(/[^0-9]/g, "").slice(0, 14) + Math.random().toString(36).slice(2, 6);
      const cur = (await readBins(store, demo))[id];
      if (!cur) return json(404, { error: "No such bin. Make its label first." });
      if ((cur.photos || []).length >= MAX_PHOTOS) return json(400, { error: "This bin has as many photos as it can hold. Delete an old one first." });
      await store.set(`photo/${id}/${pid}/full`, full);
      await store.set(`photo/${id}/${pid}/thumb`, thumb);
      const stop = await updateJson(store, "bins", (bins) => {
        if (!bins[id]) return json(404, { error: "No such bin." });
        if ((bins[id].photos || []).length >= MAX_PHOTOS) return json(400, { error: "This bin has as many photos as it can hold. Delete an old one first." });
        bins[id].photos = [{ id: pid, at: now }].concat(bins[id].photos || []);
        bins[id].updatedAt = now;
      });
      if (stop) { await dropPhotos(store, id, [pid]); return stop; }
      return json(200, { ok: true, photo: { id: pid, at: now } });
    }
    if (path[2] === "photos" && ID_RE.test(path[3] || "") && req.method === "DELETE") {
      const pid = path[3];
      const stop = await updateJson(store, "bins", (bins) => {
        if (!bins[id]) return json(404, { error: "No such bin." });
        bins[id].photos = (bins[id].photos || []).filter(p => p.id !== pid);
      });
      if (stop) return stop;
      await dropPhotos(store, id, [pid]);
      return json(200, { ok: true });
    }
  }

  if (req.method === "POST" && path[0] === "suggest" && !path[1]) {
    if (!canWrite) return json(403, { error: "This link can only view the list." });
    if (demo) return json(403, { error: "Photo suggestions are turned off in the demo. On your own copy, set ANTHROPIC_API_KEY to turn them on." });
    if (!labelAiReady()) return json(501, { error: "Photo suggestions aren't set up on this copy (ANTHROPIC_API_KEY is missing)." });
    const b = await readJson(req);
    const img = jpegFrom(b && b.image, MAX_PHOTO_BYTES);
    if (!img) return json(400, { error: "That photo did not come through (JPEG, 1.5 MB at most)." });
    try {
      return json(200, { items: await suggestLabels(img.toString("base64")) });
    } catch (e) {
      console.error("suggest failed", e);
      return json(502, { error: "Couldn't read the photo just now. Try again, or type it in." });
    }
  }
  if (req.method === "POST" && path[0] === "ids") {
    const n = Math.max(1, Math.min(50, Number(((await readJson(req)) || {}).n) || 1));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ_NAME || "UTC" });
    const day = today.slice(2).replace(/-/g, "");
    for (let i = 0; i < 8; i++) {
      const cur = await store.getWithMetadata("ids/" + day, { type: "json" });
      const next = (cur && cur.data && cur.data.next) || WEB_ID_START;
      const opts = cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true };
      const res = await store.setJSON("ids/" + day, { next: next + n }, opts);
      if (res.modified) return json(200, { ids: Array.from({ length: n }, (_, k) => day + "-" + (next + k)), date: today });
    }
    return json(409, { error: "busy, try again" });
  }

  if (req.method === "POST" && path[0] === "log") {
    if (demo) return json(200, { ok: true });
    const e = await readJson(req);
    if (!e || typeof e !== "object" || JSON.stringify(e).length > 2000) return json(400, { error: "bad log entry" });
    const id = new Date().toISOString().replace(/[^0-9]/g, "") + "-" + Math.random().toString(36).slice(2, 6);
    await getStore("scanlog").setJSON(id, e);
    return json(200, { ok: true });
  }
  return json(404, { error: "not found" });
};

export const config = { path: ["/api/*"] };

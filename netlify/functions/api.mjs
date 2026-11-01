// Freezer list API. The whole list is one JSON blob ({ id: item }), updated with
// compare-and-swap on its etag so two phones scanning at once can't lose a write.
//   GET    /api/items          read key or write key -> { items, at, canWrite }
//   PUT    /api/items/:id      write key, body = item
//   DELETE /api/items/:id      write key
//   POST   /api/ids            write key, body { n } -> { ids } fresh label IDs
//   POST   /api/log            write key, body = scan-log entry (append-only)
// Keys come from the READ_KEY / WRITE_KEY env vars and arrive in the x-key header.
// With DEMO=1 the key "demo" opens a separate sample list anyone may scan into;
// it is reset to the sample food whenever it is more than a day old.
import { getStore } from "@netlify/blobs";

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

// Keys must survive the trip through a link (#w=...), so: letters, digits, _ and -,
// at least 16 long, and the two must differ.
function keyProblem(){
  const ok = (k) => typeof k === "string" && /^[\w-]{16,}$/.test(k);
  if (!ok(process.env.WRITE_KEY) || !ok(process.env.READ_KEY))
    return "WRITE_KEY and READ_KEY must each be at least 16 letters, numbers, _ or - (set them in Netlify, then redeploy).";
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
  if (!canWrite) return json(403, { error: "This link can only view the list." });

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

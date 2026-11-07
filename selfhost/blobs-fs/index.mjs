// Stand-in for @netlify/blobs when self-hosting: the calls netlify/functions/api.mjs
// makes, stored as plain files under DATA_DIR (default /data).
//   <DATA_DIR>/<store>/<key>        the value (keys are URL-encoded, so "photo/a/b" is one file)
//   <DATA_DIR>/<store>/<key>.meta   { etag, metadata }
// One server process owns the folder, so a per-key queue is enough to make
// onlyIfMatch / onlyIfNew (compare-and-swap) safe.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.env.DATA_DIR || "/data";
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return run;
}
const missing = (e) => e && e.code === "ENOENT";
async function writeAtomic(file, data) {
  const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export function getStore(opts) {
  const name = typeof opts === "string" ? opts : opts.name;
  const dir = path.join(ROOT, encodeURIComponent(name));
  const file = (key) => path.join(dir, encodeURIComponent(key));
  const ready = fs.mkdir(dir, { recursive: true });
  ready.catch(() => {});   // callers that await it still see the error

  async function readMeta(key) {
    try { return JSON.parse(await fs.readFile(file(key) + ".meta", "utf8")); }
    catch (e) { if (missing(e)) return null; throw e; }
  }
  async function read(key, type) {
    let buf;
    try { buf = await fs.readFile(file(key)); } catch (e) { if (missing(e)) return null; throw e; }
    if (type === "json") return JSON.parse(buf.toString("utf8"));
    if (type === "arrayBuffer") return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    return buf.toString("utf8");
  }

  const store = {
    async get(key, o = {}) { await ready; return read(key, o.type); },
    async getWithMetadata(key, o = {}) {
      await ready;
      return withLock(file(key), async () => {
        const data = await read(key, o.type);
        if (data === null) return null;
        const meta = (await readMeta(key)) || {};
        return { data, etag: meta.etag || "none", metadata: meta.metadata || {} };
      });
    },
    async set(key, value, o = {}) {
      await ready;
      return withLock(file(key), async () => {
        let exists = true;
        try { await fs.access(file(key)); } catch { exists = false; }
        const meta = exists ? (await readMeta(key)) || {} : null;
        if (o.onlyIfNew && exists) return { modified: false };
        if (o.onlyIfMatch && (!exists || (meta.etag || "none") !== o.onlyIfMatch)) return { modified: false };
        const etag = crypto.randomUUID();
        await writeAtomic(file(key), typeof value === "string" ? value : Buffer.from(value));
        await writeAtomic(file(key) + ".meta", JSON.stringify({ etag, metadata: o.metadata || {} }));
        return { modified: true, etag };
      });
    },
    setJSON(key, value, o) { return store.set(key, JSON.stringify(value), o); },
    async delete(key) {
      await ready;
      return withLock(file(key), async () => {
        await fs.rm(file(key), { force: true });
        await fs.rm(file(key) + ".meta", { force: true });
      });
    },
    async list(o = {}) {
      await ready;
      const prefix = o.prefix || "";
      const keys = (await fs.readdir(dir))
        .filter((f) => !f.endsWith(".meta") && !f.endsWith(".tmp"))
        .map((f) => decodeURIComponent(f))
        .filter((k) => k.startsWith(prefix));
      return { blobs: keys.map((key) => ({ key })) };
    },
  };
  return store;
}

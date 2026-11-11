// Builds the offline edition into dist-offline/: the website's pages (public/) plus
// the on-phone server (sw.js), the Share & back up page and the install files.
// Host dist-offline/ at the ROOT of any static https site (the pages call /api/...):
// a phone opens it once, installs it, and never needs the internet again.
//   node offline/build.mjs
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-offline");
const PAGES = ["index.html", "list.html", "label.html", "bins.html"];         // from public/
const SHARED = ["qrcode.js", "jsqr.js"];                                     // from public/
const OWN = ["share.html", "edition.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];   // from offline/

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const HEAD = '<head>\n<script src="edition.js"></script>\n<link rel="manifest" href="manifest.webmanifest">\n'
  + '<link rel="apple-touch-icon" href="icon-192.png">';
const hash = createHash("sha256");
for (const f of PAGES.concat(["share.html"])) {
  const src = join(root, f === "share.html" ? "offline" : "public", f);
  const html = readFileSync(src, "utf8");
  if (!/<head>/i.test(html)) throw new Error(f + " has no <head>");
  const page = html.replace(/<head>/i, HEAD);
  writeFileSync(join(out, f), page);
  hash.update(page);
}
for (const f of SHARED) { cpSync(join(root, "public", f), join(out, f)); hash.update(readFileSync(join(out, f))); }
for (const f of OWN.filter(f => f !== "share.html")) { cpSync(join(root, "offline", f), join(out, f)); hash.update(readFileSync(join(out, f))); }

// The service worker lists every file to keep on the phone; its version is a hash of
// them all, so any change to a page makes phones pick up the update when next online.
const files = ["./"].concat(PAGES, ["share.html"], SHARED, OWN.filter(f => f !== "share.html"));
let sw = readFileSync(join(root, "offline", "sw.js"), "utf8");
hash.update(sw);
const version = hash.digest("hex").slice(0, 12);
sw = sw.replace('"__VERSION__"', JSON.stringify(version)).replace("__FILES__", JSON.stringify(files));
writeFileSync(join(out, "sw.js"), sw);
console.log(`dist-offline/ built: ${files.length} files, version ${version}`);

// Builds the offline edition into dist-offline/: the website's pages (public/) plus
// the on-phone server (sw.js), the Share & back up page and the install files.
// Host dist-offline/ on any static https site, at its root or in a sub-folder:
// a phone opens it once, installs it, and never needs the internet again.
//   node offline/build.mjs
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-offline");
const PAGES = ["index.html", "list.html", "label.html", "bins.html"];         // from public/
const SHARED = ["qrcode.js", "jsqr.js"];                                     // from public/
const OWN = ["share.html", "edition.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];   // from offline/

// Empty it rather than delete it: on Windows a folder a server is running in can't be removed.
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) rmSync(join(out, f), { recursive: true, force: true });
const HEAD = '<head>\n<script src="edition.js"></script>\n<link rel="manifest" href="manifest.webmanifest">\n'
  + '<link rel="apple-touch-icon" href="icon-192.png">';
const hash = createHash("sha256");
for (const f of PAGES.concat(["share.html"])) {
  const src = join(root, f === "share.html" ? "offline" : "public", f);
  const html = readFileSync(src, "utf8");
  if (!/<head>/i.test(html)) throw new Error(f + " has no <head>");
  // The website calls "/api/..."; relative "api/..." lets the app live in a sub-folder
  // too (e.g. GitHub Pages: user.github.io/freezer-scan/), where sw.js still answers it.
  const page = html.replace(/<head>/i, HEAD).replace(/(["'`])\/api\//g, "$1api/");
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

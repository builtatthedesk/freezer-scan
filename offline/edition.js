// Freezer Scan, offline edition: loaded first on every page (build.mjs puts it at the
// top of <head>). It installs the on-phone "server" (sw.js) and adjusts the website's
// pages for a phone that keeps its own list: no keys, no family link, no photo AI.
(function () {
  "use strict";
  window.FREEZER_OFFLINE = true;
  const LS = { get(k){ try { return localStorage.getItem(k); } catch (e) { return null; } },
               set(k, v){ try { localStorage.setItem(k, v); } catch (e) {} } };
  // The pages want a key before they talk to /api. On this phone there is nothing to
  // protect from, so every page gets the same stand-in.
  if (!LS.get("fs.key")) LS.set("fs.key", "local");
  if (!LS.get("fl.key")) LS.set("fl.key", "local");

  const style = document.createElement("style");
  style.textContent = [
    "#photo-row{display:none!important}",                       // photo suggestions need the internet
    "#offline-bar{font:600 14px system-ui,sans-serif;background:#1f6feb;color:#fff;padding:8px 12px;text-align:center}",
    "#offline-bar a{color:#fff}",
    "body::after{display:none!important}",                       // the website's room for Netlify's badge
  ].join("");
  document.head.appendChild(style);

  if (!("serviceWorker" in navigator)) {
    document.addEventListener("DOMContentLoaded", () => bar("This browser is too old to keep the list on the phone. Use Chrome."));
    return;
  }
  // The first visit has no server yet: hide the page, install it, then reload once so
  // every /api call goes to the phone. Later visits are controlled from the start.
  // A load that skipped it (shift-reload) is reloaded once, so it is controlled too.
  let cover = null;
  if (!navigator.serviceWorker.controller) {
    cover = document.createElement("style");
    cover.textContent = 'body{visibility:hidden}html::before{content:"Setting up Freezer Scan on this phone…";display:block;padding:24px;font:600 18px system-ui,sans-serif}';
    document.head.appendChild(cover);
    navigator.serviceWorker.addEventListener("controllerchange", () => location.reload());
    navigator.serviceWorker.getRegistration().then((r) => {
      if (r && r.active && !sessionStorage.getItem("fo.reloaded")) { sessionStorage.setItem("fo.reloaded", "1"); location.reload(); }
    }).catch(() => {});
    setTimeout(() => {                                // never leave the page covered
      if (navigator.serviceWorker.controller || !cover) return;
      cover.remove();
      bar("Still setting up the list on this phone. Wait a moment, then reload.");
    }, 10000);
  } else { try { sessionStorage.removeItem("fo.reloaded"); } catch (e) {} }
  navigator.serviceWorker.register("sw.js").catch((e) => {
    if (cover) cover.remove();
    document.addEventListener("DOMContentLoaded", () => bar("Couldn't set up the list on this phone (" + e.message + "). Open it over https or from localhost."));
  });
  // Ask Android to keep the list even when the phone runs low on space.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  function bar(html){
    let b = document.getElementById("offline-bar");
    if (!b) { b = document.createElement("div"); b.id = "offline-bar"; document.body.prepend(b); }
    b.innerHTML = html;
  }

  document.addEventListener("DOMContentLoaded", () => {
    // Scanning page: "Send the family list" becomes the Share & back up page. The
    // website's version sends a link to a live list, which a phone on its own has not got.
    const share = document.getElementById("share-link");
    if (share) {
      const a = share.cloneNode(true);                  // drops the website's click handler
      a.href = "share.html"; a.textContent = "Share & back up";
      share.replaceWith(a);
    }
    // "Print the list" on the website builds an address from the site root, which is
    // wrong when the app lives in a sub-folder (GitHub Pages).
    const print = document.getElementById("print-link");
    if (print) { const a = print.cloneNode(true); a.href = "list.html#k=local&print"; print.replaceWith(a); }
    // Nudge towards a backup: the list only lives on this phone.
    const last = Date.parse(LS.get("fo.backupAt") || "");
    const page = location.pathname.split("/").pop() || "index.html";
    if (page === "index.html" || page === "list.html") {
      const daysSince = Number.isFinite(last) ? Math.floor((Date.now() - last) / 864e5) : null;
      if (daysSince === null && LS.get("fo.used")) bar('Your list is only on this phone. <a href="share.html">Back it up</a> so a lost phone doesn\'t lose it.');
      else if (daysSince !== null && daysSince >= 14) bar('Last backup ' + daysSince + ' days ago. <a href="share.html">Back up now</a>.');
    }
    LS.set("fo.used", "1");
  });
})();

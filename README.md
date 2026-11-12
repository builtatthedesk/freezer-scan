# Freezer Scan

Know what's in your freezers. Put a QR label on the food, scan it in and out with
the phone's camera (or a Bluetooth barcode scanner), and everyone in the house sees
the list on their phone. Labels print on plain paper or a Brother label printer.

**See it and try the demo:** https://freezer-scan.netlify.app/how.html

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/builtatthedesk/freezer-scan)

## What's in here

| Path | What it is |
|---|---|
| `public/index.html` | Scanning page. A Bluetooth scanner types each QR code like a keyboard (the page tells labels apart by the pause after a scan), or tap **Scan with camera** to use the phone's camera. |
| `public/list.html` | Read-only family list: search, sort, filter by freezer. |
| `public/label.html` | Label maker: a sheet of cut-out labels on plain paper (14 per page; bin labels twice as big), 29 × 90 mm labels for a Brother DK-1201 roll, or 23 × 23 mm squares for a DK-1221 roll (the code plus a short name). |
| `public/bins.html` | Storage bins: scan a bin label to see its photos and notes; add a photo of what's inside. Search across all bins. |
| `public/backup.html` | Share & back up: a dated read-only copy of the list to send, a backup file (everything, photos included), and restore. The same file works on every copy: website, self-hosted, offline phone. |
| `public/how.html` | The plain-English how-to page. |
| `netlify/functions/api.mjs` | The only server code: stores the list in Netlify Blobs. |

## Labels

A food label's QR code holds three lines:

```
Chicken soup
Printed: 2026-10-31
ID: 261031-5001
```

The ID makes every pack unique. A freezer label holds `LOC: Garage freezer`, and
a take-out label holds `CMD: TAKE OUT`. A storage-bin label holds `BIN: Christmas 1`
then `ID: 261102-5001`; the bin's name, notes and photos live in Netlify Blobs
(`bins`, and `photo/<id>/<photo>/full|thumb` as JPEGs shrunk on the phone to
1600 px and 400 px).

## Keys

The site is private by link. When you deploy it, Netlify asks for two values:

- `WRITE_KEY` is the scanning password. Open `https://<your-site>/#w=<WRITE_KEY>` to scan and make labels.
- `READ_KEY` is the family-list password. Open `https://<your-site>/list.html#k=<READ_KEY>` to view only.

Use letters, numbers, `_` and `-`, at least 16 characters, and make the two
different; the API refuses to run otherwise. The key travels after `#`, so it is
never sent in a page request; the page sends it to the API in a header. It does
stay in the address bar so a home-screen icon keeps it, so share only the
family-list link.

## Labels from a photo (optional)

On **Make labels**, **📷 From a photo** sends one photo of unlabelled food to
Claude and offers a label for each food it sees (name, how many packs, and the
date if one is written on the pack; otherwise today). Tap one to fill in the
form. To turn it on, add an `ANTHROPIC_API_KEY` environment variable (Netlify:
Site configuration → Environment variables; self-hosted: `.env`). Each photo is
one API call, about a cent. Without the key the button explains it isn't set up.
The model call lives in `netlify/lib/label-ai.mjs`, so it can be pointed at a
local vision model later (`LABEL_AI`, `LABEL_AI_MODEL`).

**No API key?** `photo-helper/` runs the same job on your own computer with
Claude Code (`claude -p`, your Claude subscription). Run
`photo-helper/install-autostart.ps1` once (starts it at log on and puts it on your
Tailscale HTTPS name), then set the site's `SUGGEST_URL` to the address it prints.
The page then sends photos straight to that computer: the phone needs Tailscale on
and the computer must be awake. It takes about half a minute per photo.

The helper can also print each finished label on network label printers
(`LABEL_PRINTER`, a comma list of [label-print](https://github.com/builtatthedesk/ql-label-print)
profiles; the page shows one print button per printer), and with `PUBLIC_DIR` set it serves the pages too, passing `/api/...` on to
the Netlify site, so an always-on Linux box can run the label page (photo, print) with
no Netlify deploy. A systemd unit plus `tailscale serve --https=8443` is enough; on
Linux, log Claude Code in once as the service user for photo suggestions.

Optional settings:

- `TZ_NAME` is the time zone used to date label IDs, e.g. `America/New_York`. Default: `UTC`.
- `DEMO=1` opens a shared sample list under the key `demo`, reset daily. The how-to page's demo buttons point at the original site's demo.

## Scan log

Every scan's raw text, its outcome and the phone's browser name are kept in a
separate Netlify Blobs store, `scanlog`, so a bad scan can be looked into later.

## Run it yourself

Needs [Netlify CLI](https://docs.netlify.com/cli/get-started/):

```bash
npm install
netlify dev
```

### Self-host without Netlify

`Dockerfile` + [`selfhost/`](selfhost/README.md) run the same pages and API in one
container, storing the list as files. Guides for a VPS (Caddy HTTPS) and a home
server (Tailscale HTTPS) are in [selfhost/README.md](selfhost/README.md).
`selfhost/nightly-backup.py <dir>` saves one backup file a night (same file as the
Back up button, photos included, newest 30 kept); run it from cron or a systemd timer
(on a VPS, pass the site's https address as the second argument).

## Offline edition (one phone, no server)

`offline/` turns the same pages into an app that keeps the list on one Android
phone and never needs the internet after the first visit. A service worker
(`offline/sw.js`) answers the pages' `/api/...` calls from the phone's own storage
(IndexedDB), and caches the pages, so it works in airplane mode.

```bash
node offline/build.mjs      # -> dist-offline/
```

Host `dist-offline/` on any static https site, at its root or in a sub-folder
(Netlify, GitHub Pages, ...); no functions or keys. This repo publishes it on every change to
`main` (`.github/workflows/offline-pages.yml`): https://builtatthedesk.github.io/freezer-scan/ On the phone: open it once
in Chrome, then **Install app** / **Add to Home screen**.

- Scanning, the list, label making (plain paper, Brother roll or 23 mm squares),
  storage bins and their photos all work offline. Label IDs come from a counter on the phone, numbered from 7001 so they never meet the website's (5001 up).
- **Share & back up** (`public/backup.html`, the same page the website has):
  - **Share the list** sends a single web page with the list built in, dated, read-only: it opens in any browser and says how old it is.
  - **Back up** saves one JSON file with everything, photos included.
  - **Restore** merges a backup in: nothing is deleted, the most recent change to each label wins, and doing it twice changes nothing.
  - Backups move both ways: back up the website and restore on a phone, or the other way round.
- Not in this edition: the live family list (send a copy instead), photo → label
  suggestions (need the internet), and one-tap printing. Print through Brother's
  iPrint&Label app over Bluetooth or the printer's Wi-Fi Direct, using **Save images**.
- The list belongs to the web address it was installed from, and clearing Chrome's
  data for that site deletes it, so back up.

## Licence

MIT. Built at the Desk.

Bundled: `public/qrcode.js` ([qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator), MIT) and
`public/jsqr.js` ([jsQR](https://github.com/cozmo/jsQR), Apache-2.0).

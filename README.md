# Freezer Scan

Know what's in your freezers. Put a QR label on the food, scan it in and out with
a Bluetooth barcode scanner, and everyone in the house sees the list on their phone.

**See it and try the demo:** https://freezer-scan.netlify.app/how.html

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/builtatthedesk/freezer-scan)

## What's in here

| Path | What it is |
|---|---|
| `public/index.html` | Scanning page. The scanner types each QR code like a keyboard; the page tells labels apart by the pause after a scan. |
| `public/list.html` | Read-only family list: search, sort, filter by freezer. |
| `public/label.html` | Label maker for 29 × 90 mm labels (Brother DK-1201). Print from a computer or save images. |
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
a take-out label holds `CMD: TAKE OUT`.

## Keys

The site is private by link. When you deploy it, Netlify asks for two values:

- `WRITE_KEY` is the scanning password. Open `https://<your-site>/#w=<WRITE_KEY>` to scan and make labels.
- `READ_KEY` is the family-list password. Open `https://<your-site>/list.html#k=<READ_KEY>` to view only.

Use letters, numbers, `_` and `-`, at least 16 characters, and make the two
different; the API refuses to run otherwise. The key travels after `#`, so it is
never sent in a page request; the page sends it to the API in a header. It does
stay in the address bar so a home-screen icon keeps it, so share only the
family-list link.

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

## Licence

MIT. Built at the Desk.

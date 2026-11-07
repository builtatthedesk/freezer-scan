# Self-hosting Freezer Scan

The Netlify version is two parts: the pages in `public/` and one API function,
`netlify/functions/api.mjs`, which keeps the list in Netlify Blobs. To self-host,
this folder runs **the same API code** in a small Node server, with Netlify Blobs
swapped for plain files (`blobs-fs/`). Nothing in `public/` or `api.mjs` changes.

| File | What it is |
| --- | --- |
| `../Dockerfile` | Builds the app image (Node 22, no npm install needed) |
| `server.mjs` | Serves `public/`, sends `/api/*` to `api.mjs`, sets the same headers as `netlify.toml` |
| `blobs-fs/` | File-backed stand-in for `@netlify/blobs` (compare-and-swap included) |
| `docker-compose.vps.yml` + `Caddyfile` | VPS with a domain name, HTTPS from Caddy / Let's Encrypt |
| `docker-compose.home.yml` | Small server at home, HTTPS from Tailscale, no open ports |
| `env.example` | The settings: `WRITE_KEY`, `READ_KEY`, `TZ_NAME`, `DOMAIN` |

**HTTPS is not optional.** Phone browsers only allow the camera on `https://`
pages, so a plain `http://192.168.x.x:8080` link loads but can't scan with the camera.

## Option A: a VPS (reachable from anywhere)

Any small Linux VPS works (1 CPU, 512 MB RAM is plenty). You need a domain name.

1. Install Docker: `curl -fsSL https://get.docker.com | sh`
2. Point a DNS **A record** (e.g. `freezer.example.com`) at the VPS's IP address.
3. Get the code and settings:
   ```bash
   git clone https://github.com/builtatthedesk/freezer-scan && cd freezer-scan
   cp selfhost/env.example .env && nano .env
   ```
4. Start it:
   ```bash
   docker compose -f selfhost/docker-compose.vps.yml --env-file .env up -d --build
   ```
5. Open `https://freezer.example.com/#w=<WRITE_KEY>` on your phone.

Firewall: open ports 80 and 443 only (80 is needed for the certificate).

`env.example` leaves both passwords blank on purpose: the app refuses to run until you set them.

## Option B: a little server at home (Pi, NAS, old PC, Proxmox LXC)

Nothing is opened to the internet. [Tailscale](https://tailscale.com) (free for
personal use) gives the server a private HTTPS address that only your devices reach.

1. Install Docker and Tailscale on the server, then `sudo tailscale up`.
   In the Tailscale admin console, turn on **MagicDNS** and **HTTPS certificates**.
2. Get the code and settings (as in Option A; `DOMAIN` isn't used).
3. Start it and put HTTPS in front:
   ```bash
   docker compose -f selfhost/docker-compose.home.yml --env-file .env up -d --build
   sudo tailscale serve --bg 8080
   ```
4. `tailscale serve status` shows your address, like `https://pi.tail1234.ts.net`.
   Your scanning link is that address + `/#w=<WRITE_KEY>`.
5. Every phone that uses it (yours and the family's) needs the Tailscale app,
   signed in to your tailnet. To share with someone outside it, use Tailscale's
   "Share" on that one machine.

Rather not install Tailscale on family phones? Use a **Cloudflare Tunnel**
instead (free; needs a domain on Cloudflare): `cloudflared` on the server
publishes `https://freezer.yourdomain.com` → `http://localhost:8080` without opening
any ports.

## Backups

The whole list (food, bins, bin photos) lives in the `freezer_data` Docker volume.
Copy it out nightly (cron), using the compose file you started with:

```bash
docker compose -f selfhost/docker-compose.home.yml cp app:/data ./backup-$(date +%F)
```

To restore, copy it back, give the files to the app's user, and restart:

```bash
F=selfhost/docker-compose.home.yml
docker compose -f $F cp ./backup-2026-11-07/. app:/data
docker compose -f $F exec -u root app chown -R node:node /data
docker compose -f $F restart app
```

## Updating

```bash
git pull && docker compose -f selfhost/docker-compose.<vps|home>.yml --env-file .env up -d --build
```

## Moving from Netlify

There's no export button yet. With the Netlify CLI, logged in and linked to your
site, download the list:

```bash
mkdir -p move/freezer && netlify blobs:get freezer items > move/freezer/items
```

then copy `move/.` into the volume with the restore commands above. That moves the
food list. Storage bins and their photos (`bins` and the `photo/...` blobs) are
not covered; re-create bins, or fetch each blob the same way (on disk, the slashes
in a key are written as `%2F`, e.g. `photo%2F<bin>%2F<id>%2Ffull`). Or just start
fresh: the labels already on packs still scan, and each pack is added back the
next time it's scanned.

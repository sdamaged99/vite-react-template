# Self-hosting on an Ubuntu 24.04 LXC

The same app, run by Node instead of Cloudflare Workers. Cloudflare stays in front for DNS, TLS to visitors and Access on `/admin/`; Nginx Proxy Manager (NPM) forwards to the LXC.

```
visitor → Cloudflare (proxied DNS, Access on /admin/*) → NPM :443 → LXC :8787 (node dist/server/server.js) → /srv/sparkle/data/sparkle.db
```

What changes: D1 becomes a SQLite file (`node:sqlite`, built into Node 22.13+), Workers Static Assets becomes a small static file server, `cloudflare:sockets` becomes Node `net`/`tls`, the cron trigger becomes a systemd timer. The Worker code in `worker/` is shared and unchanged apart from SMTP socket injection, so the Cloudflare build keeps working for rollback.

No runtime npm packages are needed on the LXC: the build bundles everything into `dist/server/server.js`.

## 1. LXC packages

```bash
apt update && apt install -y curl ca-certificates sqlite3 rsync
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v   # must be v22.13 or later
```

## 2. User and folders

```bash
useradd --system --home /srv/sparkle --shell /usr/sbin/nologin sparkle
mkdir -p /srv/sparkle/{app,data,backups} /etc/sparkle
chown -R sparkle:sparkle /srv/sparkle/data /srv/sparkle/backups
chmod 750 /srv/sparkle/data /srv/sparkle/backups
```

## 3. Build and copy the app

On any machine with Node 22 and the repo:

```bash
npm install
npm run build:node        # → dist/client (pages) + dist/server/server.js
rsync -a --relative dist db/migrations root@LXC:/srv/sparkle/app/
```

The LXC needs `/srv/sparkle/app/dist/` and `/srv/sparkle/app/db/migrations/`. Nothing else.

## 4. Move the data out of D1

Do this at cutover, after the last enquiry you care about:

```bash
npx wrangler d1 export sparkle-carpets --remote --output=sparkle.sql
scp sparkle.sql root@LXC:/tmp/
# on the LXC:
sudo -u sparkle sqlite3 /srv/sparkle/data/sparkle.db < /tmp/sparkle.sql
sudo -u sparkle sqlite3 /srv/sparkle/data/sparkle.db "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1; SELECT COUNT(*) FROM enquiries;"
rm /tmp/sparkle.sql
```

The export includes wrangler's `d1_migrations` table, so the Node app sees every migration as applied. For a fresh empty database skip this; the app creates and migrates it on first start.

## 5. Settings and service

```bash
cp deploy/sparkle.env.example /etc/sparkle/sparkle.env   # then fill it in
chown root:sparkle /etc/sparkle/sparkle.env && chmod 640 /etc/sparkle/sparkle.env
cp deploy/sparkle*.service deploy/sparkle*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sparkle sparkle-backup.timer
# reminders stay off unless you want them (also gated by the admin setting):
# systemctl enable --now sparkle-reminders.timer
journalctl -u sparkle -n 20
curl -s localhost:8787/api/pricing | head -c 200
```

`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are the same values the Worker had (Zero Trust → Access → Applications → the app → Overview → Application Audience tag). With them blank, admin returns 503.

SMTP: port 465 uses implicit TLS, any other port STARTTLS. Certificates are verified. If NethServer uses a self-signed certificate, put its CA in `/etc/sparkle/mail-ca.pem` and set `SMTP_CA_FILE`.

## 6. NPM proxy host

- Domain names: `sparklecarpets.im`, `www.sparklecarpets.im`
- Forward: `http://<LXC IP>:8787`
- Block common exploits: on. Websockets: not needed.
- SSL: Let's Encrypt via DNS challenge (Cloudflare API token, Zone:DNS:Edit), Force SSL on, HTTP/2 on.

NPM passes Cloudflare's headers through untouched, including `Cf-Access-Jwt-Assertion` and `CF-Connecting-IP`, which the app relies on.

## 7. Cloudflare cutover

1. Workers & Pages → `sparkle-carpets` → Settings → Domains & Routes: remove the custom domains `sparklecarpets.im` and `www`.
2. DNS: add `A sparklecarpets.im → <your public IP>` and `CNAME www → sparklecarpets.im`, both **Proxied** (orange cloud).
3. SSL/TLS → Overview: **Full (strict)**.
4. Zero Trust → Access: leave the `/admin/*` and `/api/admin/*` application as it is. It works on any proxied hostname.
5. Optional: on the router/NPM, only accept 443 from Cloudflare's IP ranges (cloudflare.com/ips). Admin is still safe without this because the app verifies the Access token itself, but it stops people bypassing Cloudflare for the public pages.

Smoke test: home page, terms, submit a test enquiry (email arrives, row in admin), `/admin/` prompts for Access login, then delete the test enquiry.

## Rollback

Re-add the custom domains on the Worker (step 7.1 in reverse) and delete the A record. D1 still holds the data from before the export; enquiries taken on the LXC in the meantime need re-entering or importing by hand.

## Day to day

- Logs: `journalctl -u sparkle -f`
- Backups: `/srv/sparkle/backups/sparkle-YYYY-MM-DD.db.gz`, 30 days kept. Copy them off the box (e.g. to the NAS) as well.
- Restore: `systemctl stop sparkle; gunzip -c backup.db.gz > /srv/sparkle/data/sparkle.db; chown sparkle: …; systemctl start sparkle`
- Query: `sudo -u sparkle sqlite3 /srv/sparkle/data/sparkle.db` (the housekeeping SQL in OPERATIONS.md works unchanged).
- Deploy a new version: build, copy `dist/` and `db/migrations/`, `systemctl restart sparkle`. Pending migrations apply automatically on start. `.gitea/workflows/deploy.yml` automates this once the repo is on Gitea with a runner and a `deploy` user on the LXC allowed `sudo systemctl restart sparkle` only.

## Tests

```bash
node --experimental-transform-types --no-warnings --import ./tests/harness/register.mjs tests/node_server.test.ts
```

Covers the SQLite adapter (D1 semantics, all-or-nothing batch), migrations on a fresh and a D1-exported database, static serving (redirects, cache headers, 404, path traversal), the real API through Node's HTTP server, persistence across restart, request size limit, and SMTP over real TLS with STARTTLS, certificate verification and an untrusted certificate being refused before the password is sent.

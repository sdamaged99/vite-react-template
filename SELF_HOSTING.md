# Self-hosting on the LXC container

The site runs as one Node process: the Hono API plus the built pages, with a
SQLite file in place of D1. Cloudflare stays in front, and the existing Nginx
Proxy Manager at 81.88.168.10 forwards to the container at 10.100.40.134.
Cloudflare Access keeps protecting the admin page.

    Visitor -> Cloudflare (TLS, Access) -> Nginx Proxy Manager -> 10.100.40.134:8787 (Node)

Commands assume Debian or Ubuntu, run as root.

## 1. Install on the container

```sh
apt update
apt install -y curl ca-certificates xz-utils rsync sqlite3 openssl openssh-server
```

Node 24, using the official build (x64; use `linux-arm64` on ARM):

```sh
V=v24.22.2
curl -fsSLO https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz
tar -xJf node-$V-linux-x64.tar.xz -C /usr/local --strip-components=1
rm node-$V-linux-x64.tar.xz
node -v
```

## 2. Prepare the app's home

```sh
useradd --system --home /opt/sparkle-carpets --shell /usr/sbin/nologin sparkle
mkdir -p /opt/sparkle-carpets /etc/sparkle-carpets /var/lib/sparkle-carpets
chown sparkle:sparkle /opt/sparkle-carpets /var/lib/sparkle-carpets
```

Add your laptop's SSH key to `/root/.ssh/authorized_keys`.

## 3. First deploy, from the laptop

```sh
deploy/deploy.sh root@CONTAINER
```

The restart at the end fails this first time because the service isn't
installed yet. On the container:

```sh
cd /opt/sparkle-carpets/deploy
cp sparkle-carpets.service sparkle-backup.service sparkle-backup.timer /etc/systemd/system/
install -o root -g sparkle -m 640 env.example /etc/sparkle-carpets/env
nano /etc/sparkle-carpets/env
systemctl daemon-reload
systemctl enable --now sparkle-carpets sparkle-backup.timer
curl -s http://127.0.0.1:8787/api/pricing | head -c 200
```

Migrations run automatically at startup. Later deploys are just the
`deploy/deploy.sh` command.

## 4. Finish the proxy

The DNS records are already right: the apex points at Nginx Proxy Manager and
`www` follows it. Keep both proxied. Leave the mail records alone.

In Nginx Proxy Manager, edit the existing `www.sparklecarpets.im` proxy host:

- Add `sparklecarpets.im` as a second domain name. It is missing today, which is
  why the apex returns 525.
- Keep the destination `http://10.100.40.134:8787`.
- On the SSL tab, request a new certificate covering both names. The current one
  covers only `www`.

Then in Cloudflare, under SSL/TLS -> Overview, use Full (strict) so Cloudflare
checks that certificate.

The proxy's "Online" badge doesn't test the destination. `www` returns 502 until
the app is running.

Port 8787 is open to anything that can reach the container. If you want it
limited, allow only Nginx Proxy Manager's internal address in the container's
firewall.

## 5. Protect the admin page

Zero Trust -> Access -> Applications -> Add -> Self-hosted, for
`sparklecarpets.im` with paths `admin` and `api/admin`. Policy: Allow, emails
for Amanda and you, login by one-time PIN. Put the Audience tag and team domain
into `/etc/sparkle-carpets/env`, then `systemctl restart sparkle-carpets`.

## 6. Mail

Create the `website@sparklecarpets.im` mailbox on the NethServer and put its
password in the env file. From the container, confirm the route is open:

```sh
openssl s_client -starttls smtp -connect mail.demanufactured.co.uk:587 -verify_return_error </dev/null | grep -E 'Verification|Verify return'
```

Mail DNS already allows the NethServer to send, so no record changes are needed.

## 7. Check it

```sh
curl -I https://sparklecarpets.im/
journalctl -u sparkle-carpets -n 50
```

The laptop needs `rsync` and `ssh` for deploys.

Then do the live smoke test: enquiry, both emails, record acceptance, confirm,
handover, return, refund, and delete the test rows.

## Backups

`sparkle-backup.timer` writes a checked, compressed copy to
`/var/lib/sparkle-carpets/backups` nightly and keeps 30 days. Moving off D1
loses its point-in-time recovery, and these copies sit on the same disk, so
copy that folder off the container as well.

To restore: stop the service, `gunzip` a backup over `sparkle.db`, delete
`sparkle.db-wal` and `sparkle.db-shm`, fix ownership, start the service.

## Differences from the Worker

- Reminders stay off. The cron trigger is gone; turning them on needs a daily
  timer added here as well as `reminders_enabled='1'`.
- The Worker code in `worker/` is unchanged and still deploys to Cloudflare on
  every push to `main` until Workers Builds is disconnected.
- The site now depends on the container, Nginx Proxy Manager and your internet
  connection all being up.
- The proxy is reachable directly at its public address, bypassing Cloudflare.
  The admin API stays safe because the app verifies the Access token itself.

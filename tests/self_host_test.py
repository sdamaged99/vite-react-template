"""End-to-end check of the self-hosted server, using the built bundle.

Unlike the harness tests, this uses real HTTP, a real SQLite file and real TLS
to a local SMTP server. Needs `npm run build && npm run build:server`, and the
openssl command. Run: python3 tests/self_host_test.py
"""
import datetime as dt
import json
import os
import socket
import socketserver
import sqlite3
import ssl
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

PORT, HTTP = 8795, "http://127.0.0.1:8795"
failed = 0


def check(name, ok, detail=""):
    global failed
    failed += 0 if ok else 1
    print(("PASS  " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))


class Smtp(socketserver.StreamRequestHandler):
    def reply(self, text):
        self.wfile.write((text + "\r\n").encode())
        self.wfile.flush()

    def handle(self):
        srv = self.server
        rfile, wfile = self.rfile, self.wfile
        if srv.implicit:
            sock = srv.ctx.wrap_socket(self.connection, server_side=True)
            self.rfile, self.wfile = sock.makefile("rb"), sock.makefile("wb")
        else:
            sock = self.connection
        self.reply("220 test ESMTP")
        in_data = False
        while True:
            line = self.rfile.readline()
            if not line:
                return
            text = line.decode("utf8", "replace").rstrip("\r\n")
            if in_data:
                if text == ".":
                    in_data = False
                    srv.messages.append(srv.buf)
                    srv.buf = ""
                    self.reply("250 queued")
                else:
                    srv.buf += text + "\n"
                continue
            cmd = text.split(" ")[0].upper()
            if cmd == "EHLO":
                self.reply("250-test\r\n250-STARTTLS\r\n250 AUTH PLAIN")
            elif cmd == "STARTTLS":
                self.reply("220 go")
                sock = srv.ctx.wrap_socket(self.connection, server_side=True)
                self.rfile, self.wfile = sock.makefile("rb"), sock.makefile("wb")
                srv.upgraded = True
            elif cmd == "AUTH":
                self.reply("235 ok")
            elif cmd in ("MAIL", "RCPT"):
                self.reply("250 ok")
            elif cmd == "DATA":
                in_data = True
                self.reply("354 go")
            elif cmd == "QUIT":
                self.reply("221 bye")
                return
            else:
                self.reply("502 no")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def mail_server(port, implicit, ctx):
    s = Server(("127.0.0.1", port), Smtp)
    s.implicit, s.ctx, s.messages, s.buf, s.upgraded = implicit, ctx, [], "", False
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


def cert(directory, name):
    key, crt = f"{directory}/{name}.key", f"{directory}/{name}.crt"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "2",
         "-subj", f"/CN={name}", "-addext", f"subjectAltName=DNS:{name}"],
        check=True, capture_output=True,
    )
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(crt, key)
    return crt, ctx


def start(tmp, db, smtp_port, extra_ca):
    env = {
        "PATH": os.environ["PATH"], "APP_DIR": ".", "PORT": str(PORT), "DATABASE_PATH": db,
        "SMTP_HOST": "localhost", "SMTP_PORT": str(smtp_port), "SMTP_USER": "u", "SMTP_PASS": "p",
        "MAIL_FROM": "Sparkle Carpets <website@sparklecarpets.im>", "MAIL_TO": "bookings@sparklecarpets.im",
        "NODE_EXTRA_CA_CERTS": extra_ca,
    }
    p = subprocess.Popen(["node", "--no-warnings", "dist/server/index.mjs"], env=env,
                         stdout=open(f"{tmp}/server.log", "a"), stderr=subprocess.STDOUT)
    for _ in range(50):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", PORT)) == 0:
                return p
        time.sleep(0.1)
    raise SystemExit("server did not start: " + open(f"{tmp}/server.log").read())


def stop(p):
    p.terminate()
    p.wait(10)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def get(path):
    try:
        r = urllib.request.build_opener(NoRedirect).open(HTTP + path)
        return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def enquire(start_date):
    body = json.dumps({
        "name": "Test Person", "email": "test@example.com", "phone": "01624 000000", "preferred_start": start_date,
        "rate_plan_code": "48h", "fulfilment": "self", "terms_acknowledged": True, "extras": [],
    }).encode()
    req = urllib.request.Request(HTTP + "/api/enquiry", data=body, headers={"content-type": "application/json"})
    try:
        r = urllib.request.urlopen(req)
        return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


date = (dt.date.today() + dt.timedelta(days=30)).isoformat()
with tempfile.TemporaryDirectory() as tmp:
    db = f"{tmp}/data/sparkle.db"
    good_crt, good_ctx = cert(tmp, "localhost")
    wrong_crt, wrong_ctx = cert(tmp, "wrong.example.test")
    both = f"{tmp}/ca.pem"
    open(both, "w").write(open(good_crt).read() + open(wrong_crt).read())

    # STARTTLS (587-style), certificate matches.
    starttls = mail_server(8796, False, good_ctx)
    p = start(tmp, db, 8796, both)
    check("Home page is served", get("/")[0] == 200 and b"Sparkle Carpets" in get("/")[2])
    status, headers, _ = get("/admin")
    check("/admin redirects to /admin/", status == 301 and headers["location"] == "/admin/", str(status))
    check("/admin/ page is served", get("/admin/")[0] == 200)
    check("Static files are served", get("/robots.txt")[0] == 200)
    check("Unknown path is a 404", get("/nope")[0] == 404)
    check("Path traversal is refused", b"DATABASE" not in get("/..%2f..%2fserver%2fd1.ts")[2] and get("/..%2fpackage.json")[0] == 404)
    pricing = json.loads(get("/api/pricing")[2])
    check("Migrations ran: prices come from SQLite", len(pricing["rates"]) == 5 and pricing["rates"][0]["price_pence"] == 3000)
    check("Admin API stays closed without Access vars", get("/api/admin/today")[0] == 503)
    status, body = enquire(date)
    check("Enquiry accepted and emailed over STARTTLS", status == 200 and body.get("emailed") is True, str(body))
    check("STARTTLS upgrade really happened", starttls.upgraded)
    check("Both emails reached the mail server", len(starttls.messages) == 2, str(len(starttls.messages)))
    stop(p)

    # Restart: data survives and migrations aren't reapplied.
    p = start(tmp, db, 8796, both)
    time.sleep(0.2)
    log = open(f"{tmp}/server.log").read()
    check("Migrations run once only", log.count("migration applied: 0001") == 1)
    rows = sqlite3.connect(db).execute("SELECT count(*) FROM enquiries").fetchone()[0]
    check("Enquiry survives a restart", rows == 1, str(rows))
    stop(p)

    # Implicit TLS, port must be 465 for the client to choose it, so this path
    # is checked only if the port can be bound (needs privilege otherwise).
    try:
        implicit = mail_server(465, True, good_ctx)
    except OSError:
        implicit = None
        print("SKIP  Implicit TLS on 465 (port needs privilege here)")
    if implicit:
        p = start(tmp, db, 465, both)
        status, body = enquire((dt.date.today() + dt.timedelta(days=40)).isoformat())
        check("Enquiry emailed over implicit TLS", body.get("emailed") is True, str(body))
        stop(p)

    # A certificate for another hostname must be rejected, and the enquiry kept.
    wrong = mail_server(8794, False, wrong_ctx)
    p = start(tmp, db, 8794, both)
    status, body = enquire((dt.date.today() + dt.timedelta(days=50)).isoformat())
    check("Wrong-hostname certificate is rejected, nothing sent", body.get("emailed") is False and not wrong.messages, str(body))
    conn = sqlite3.connect(db)
    err = conn.execute("SELECT email_error FROM enquiries ORDER BY id DESC LIMIT 1").fetchone()[0]
    check("Failed send is stored for the admin retry", status == 200 and bool(err), str(err))
    print("      stored error:", err)
    stop(p)

print("\nall passed" if not failed else f"\n{failed} failed")
raise SystemExit(1 if failed else 0)

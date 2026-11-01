// Self-hosted (Node) server tests: SQLite adapter, migrations, static serving,
// the real Worker routes through Node's HTTP server, persistence across a
// restart, and SMTP over REAL TLS (implicit and STARTTLS) against a local
// test mail server with a throwaway certificate.
// Run: node --experimental-transform-types --no-warnings --import ./tests/harness/register.mjs tests/node_server.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = mkdtempSync(join(tmpdir(), "sparkle-node-"));
process.env.DB_PATH = join(work, "sparkle.db");

// Throwaway CA-less self-signed certificate for "localhost".
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
  "-addext", "subjectAltName=DNS:localhost", "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem")], { stdio: "ignore" });
const KEY = readFileSync(join(work, "key.pem"));
const CERT = readFileSync(join(work, "cert.pem"));

const { SqliteD1 } = await import("../server/sqlite-d1.ts");
const { applyMigrations } = await import("../server/migrate.ts");
const { makeHandler, buildEnv } = await import("../server/node.ts");

const results: { name: string; ok: boolean; detail?: string }[] = [];
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, detail: String((e as Error).message ?? e).slice(0, 400) }); }
}

/* ------------------------------------------------------------ SQLite ---- */
await test("Migrations: fresh database gets 0001-0011; a second run applies nothing", () => {
  const db = new SqliteD1(join(work, "fresh.db"));
  const applied = applyMigrations(db, "db/migrations", () => {});
  assert.equal(applied.length, 11);
  assert.deepEqual(applyMigrations(db, "db/migrations", () => {}), []);
  const names = (db.raw.prepare("SELECT name FROM d1_migrations ORDER BY id").all() as any[]).map((r) => r.name);
  assert.equal(names[0], "0001_init.sql"); assert.equal(names.at(-1), "0011_prepared_features.sql");
  db.close();
});

await test("Migrations: a database exported from D1 (wrangler's d1_migrations table, all applied) needs nothing", () => {
  const db = new SqliteD1(join(work, "exported.db"));
  db.raw.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const f of execFileSync("ls", ["db/migrations"]).toString().trim().split("\n")) {
    db.raw.exec(readFileSync(join("db/migrations", f), "utf8"));
    db.raw.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(f);
  }
  assert.deepEqual(applyMigrations(db, "db/migrations", () => {}), []);
  db.close();
});

await test("Adapter: D1 semantics (first/column, booleans to 0/1, undefined to NULL, run meta, RETURNING)", async () => {
  const db = new SqliteD1(":memory:");
  await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b INTEGER)");
  const r = await db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").bind(undefined, true).run();
  assert.equal(r.meta.changes, 1); assert.equal(r.meta.last_row_id, 1);
  assert.deepEqual(await db.prepare("SELECT a, b FROM t WHERE id = ?1").bind(1).first(), { a: null, b: 1 });
  assert.equal(await db.prepare("SELECT b FROM t").first("b"), 1);
  assert.equal(await db.prepare("SELECT b FROM t WHERE id = 99").first("b"), null);
  const ret = await db.prepare("INSERT INTO t (a) VALUES (?) RETURNING id").bind("x").first<{ id: number }>();
  assert.equal(ret?.id, 2);
  const all = await db.prepare("SELECT id FROM t ORDER BY id").all();
  assert.deepEqual(all.results, [{ id: 1 }, { id: 2 }]);
});

await test("Adapter: batch() is all-or-nothing, like D1", async () => {
  const db = new SqliteD1(":memory:");
  await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT NOT NULL)");
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO t (a) VALUES (?)").bind("ok"),
    db.prepare("INSERT INTO t (a) VALUES (?)").bind(null), // violates NOT NULL
  ]));
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM t").first("n"), 0, "first insert rolled back");
  const out = await db.batch([db.prepare("INSERT INTO t (a) VALUES ('x')"), db.prepare("SELECT a FROM t")]);
  assert.deepEqual(out[1]!.results, [{ a: "x" }]);
});

/* ------------------------------------------------- HTTP: static + API ---- */
const client = join(work, "client");
mkdirSync(join(client, "terms"), { recursive: true });
mkdirSync(join(client, "assets"), { recursive: true });
writeFileSync(join(client, "index.html"), "<!doctype html><title>Home</title>");
writeFileSync(join(client, "terms", "index.html"), "<!doctype html><title>Terms</title>");
writeFileSync(join(client, "assets", "main-abc123.js"), "console.log(1)");
writeFileSync(join(client, "404.html"), "<!doctype html><title>Not found</title>");
writeFileSync(join(work, "secret.txt"), "do not serve");

let db = new SqliteD1(process.env.DB_PATH!);
applyMigrations(db, "db/migrations", () => {});
const smtpLog: { mode: string; lines: string[]; data: string[] }[] = [];

function startHttp(d: InstanceType<typeof SqliteD1>, extraEnv: Record<string, string> = {}) {
  Object.assign(process.env, extraEnv);
  const { handler } = makeHandler(buildEnv(d), client);
  const srv = createServer(handler);
  return new Promise<{ port: number; close: () => Promise<void> }>((res) =>
    srv.listen(0, "127.0.0.1", () => res({ port: (srv.address() as net.AddressInfo).port, close: () => new Promise((r) => srv.close(() => r())) })),
  );
}
function req(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, any>; text: string }>((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const r = httpRequest({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", ...(data ? { "content-length": data.length } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

let http = await startHttp(db);

await test("Static: pages, folder redirect, cache headers, 404 page, no path escape, methods", async () => {
  const home = await req(http.port, "GET", "/");
  assert.equal(home.status, 200); assert.match(home.headers["content-type"], /text\/html/); assert.equal(home.headers["cache-control"], "no-cache");
  assert.equal(home.headers["x-content-type-options"], "nosniff");
  const redir = await req(http.port, "GET", "/terms");
  assert.equal(redir.status, 301); assert.equal(redir.headers.location, "/terms/");
  assert.match((await req(http.port, "GET", "/terms/")).text, /Terms/);
  const asset = await req(http.port, "GET", "/assets/main-abc123.js");
  assert.equal(asset.status, 200); assert.match(asset.headers["cache-control"], /immutable/); assert.match(asset.headers["content-type"], /javascript/);
  const miss = await req(http.port, "GET", "/no-such-page");
  assert.equal(miss.status, 404); assert.match(miss.text, /Not found/);
  for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt"]) {
    const r = await req(http.port, "GET", p);
    assert.ok(!r.text.includes("do not serve"), `escaped via ${p}`);
  }
  assert.equal((await req(http.port, "POST", "/", "x")).status, 405);
  const head = await req(http.port, "HEAD", "/");
  assert.equal(head.status, 200); assert.equal(head.text, "");
});

const enquiry = (o: Record<string, unknown> = {}) => ({
  name: "Node Tester", email: "node@example.com", phone: "07624 111222",
  preferred_start: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10),
  rate_plan_code: "48h", fulfilment: "both", area: "Douglas, Braddan, Onchan", address: "1 Test St",
  extras: ["solution"], message: "", terms_acknowledged: true, website: "", ...o,
});

await test("API through Node: pricing from SQLite; an enquiry is validated, priced and stored", async () => {
  const p = await req(http.port, "GET", "/api/pricing");
  assert.equal(p.status, 200);
  const body = JSON.parse(p.text);
  assert.equal(body.rates.length, 5); assert.equal(body.settings.deposit_pence, "7500");
  assert.equal((await req(http.port, "POST", "/api/enquiry", enquiry({ terms_acknowledged: false }))).status, 400);
  const ok = await req(http.port, "POST", "/api/enquiry", enquiry());
  assert.equal(ok.status, 200, ok.text);
  const res = JSON.parse(ok.text);
  assert.equal(res.ok, true); assert.equal(res.emailed, false, "no SMTP configured yet");
  const row = db.raw.prepare("SELECT estimate_total_pence AS t, terms_version AS v FROM enquiries WHERE id = ?").get(res.id) as any;
  assert.equal(row.t, 4500 + 4000 + 500 + 7500); assert.equal(row.v, "1.1");
  assert.equal((await req(http.port, "GET", "/api/admin/today")).status, 503, "admin stays fail-closed without Access settings");
  assert.equal((await req(http.port, "GET", "/api/nope")).status, 404);
});

await test("Oversized request bodies are refused (413)", async () => {
  const r = await req(http.port, "POST", "/api/enquiry", "x".repeat(300 * 1024));
  assert.equal(r.status, 413);
});

await test("Data survives a restart (SQLite file on disk)", async () => {
  await http.close();
  db.close();
  db = new SqliteD1(process.env.DB_PATH!);
  http = await startHttp(db);
  const n = (db.raw.prepare("SELECT COUNT(*) AS n FROM enquiries").get() as any).n;
  assert.equal(n, 1);
});

/* -------------------------------------------------- SMTP over real TLS ---- */
function smtpServer(mode: "implicit" | "starttls") {
  const ctx = tls.createSecureContext({ key: KEY, cert: CERT });
  const entry = { mode, lines: [] as string[], data: [] as string[] };
  smtpLog.push(entry);
  const speak = (sock: net.Socket, isTls: boolean, upgrade: (s: net.Socket) => void) => {
    let buf = "", inData = false, data = "";
    const send = (s: string) => sock.write(s + "\r\n");
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === ".") { inData = false; entry.data.push(data); data = ""; send("250 queued"); } else data += line + "\n"; continue; }
        entry.lines.push(line);
        const cmd = line.split(" ")[0]!.toUpperCase();
        if (cmd === "EHLO") send(isTls ? "250-localhost\r\n250 AUTH PLAIN" : "250-localhost\r\n250-STARTTLS\r\n250 AUTH PLAIN");
        else if (cmd === "STARTTLS") { send("220 go ahead"); sock.off("data", onData); upgrade(sock); return; }
        else if (cmd === "AUTH") send(isTls ? "235 ok" : "538 encryption required");
        else if (cmd === "MAIL" || cmd === "RCPT") send("250 ok");
        else if (cmd === "DATA") { inData = true; send("354 go"); }
        else if (cmd === "QUIT") { send("221 bye"); sock.end(); }
        else send("502 no");
      }
    };
    sock.on("data", onData);
    sock.on("error", () => {});
  };
  const upgradeFn = (raw: net.Socket) => {
    const secure = new tls.TLSSocket(raw, { isServer: true, secureContext: ctx });
    speak(secure, true, () => {});
  };
  const srv = mode === "implicit"
    ? tls.createServer({ key: KEY, cert: CERT }, (s) => { s.write("220 localhost ESMTP\r\n"); speak(s, true, () => {}); })
    : net.createServer((s) => { s.write("220 localhost ESMTP\r\n"); speak(s, false, upgradeFn); });
  return new Promise<{ port: number; entry: typeof entry; close: () => void }>((res) =>
    srv.listen(0, "127.0.0.1", () => res({ port: (srv.address() as net.AddressInfo).port, entry, close: () => srv.close() })));
}

for (const mode of ["implicit", "starttls"] as const) {
  await test(`SMTP over real TLS (${mode}): ${mode === "starttls" ? "certificate verified, AUTH only after encryption, both emails delivered" : "TLS-only server on a non-465 port fails cleanly, enquiry still saved"}`, async () => {
    const s = await smtpServer(mode);
    await http.close();
    http = await startHttp(db, {
      SMTP_HOST: "localhost", SMTP_PORT: String(s.port), SMTP_USER: "website@sparklecarpets.im", SMTP_PASS: "pw",
      MAIL_FROM: "Sparkle Carpets <website@sparklecarpets.im>", MAIL_TO: "bookings@sparklecarpets.im",
      SMTP_CA_FILE: join(work, "cert.pem"),
    });
    // implicit TLS is chosen by port 465 in the client; map the test port by pretending it's 465 when implicit
    const r = await req(http.port, "POST", "/api/enquiry", enquiry({ name: `TLS ${mode}` }));
    const res = JSON.parse(r.text);
    s.close();
    if (mode === "implicit") {
      // The client only uses implicit TLS on port 465; on any other port it starts with STARTTLS.
      // So an implicit-TLS server on a random port must fail cleanly and be reported, not crash.
      assert.equal(res.ok, true); assert.equal(res.emailed, false);
      return;
    }
    assert.equal(res.emailed, true, JSON.stringify(res) + JSON.stringify(s.entry.lines));
    const auth = s.entry.lines.findIndex((l) => l.startsWith("AUTH"));
    const st = s.entry.lines.findIndex((l) => l.startsWith("STARTTLS"));
    assert.ok(st >= 0 && st < auth, "STARTTLS before AUTH");
    assert.equal(s.entry.data.length, 2, "notification + acknowledgement");
    assert.ok(s.entry.data.some((d) => d.includes("TLS starttls")));
  });
}

await test("SMTP: implicit TLS on port 465 path works through the Node socket adapter", async () => {
  const { nodeConnect } = await import("../server/sockets-node.ts");
  const s = await smtpServer("implicit");
  process.env.SMTP_CA_FILE = join(work, "cert.pem");
  const sock = nodeConnect({ hostname: "localhost", port: s.port }, { secureTransport: "on", allowHalfOpen: false });
  const reader = sock.readable.getReader();
  const writer = sock.writable.getWriter();
  const read = async () => new TextDecoder().decode((await reader.read()).value);
  assert.match(await read(), /^220/);
  await writer.write(new TextEncoder().encode("EHLO x\r\n"));
  assert.match(await read(), /250/);
  await sock.close();
  s.close();
});

await test("SMTP: an untrusted certificate is rejected (no silent downgrade)", async () => {
  const s = await smtpServer("starttls");
  await http.close();
  http = await startHttp(db, { SMTP_HOST: "localhost", SMTP_PORT: String(s.port), SMTP_CA_FILE: "" });
  delete process.env.SMTP_CA_FILE;
  const r = JSON.parse((await req(http.port, "POST", "/api/enquiry", enquiry({ name: "Untrusted" }))).text);
  s.close();
  assert.equal(r.ok, true, "enquiry still saved");
  assert.equal(r.emailed, false);
  assert.ok(!s.entry.lines.some((l) => l.startsWith("AUTH")), "password never sent");
  const err = (db.raw.prepare("SELECT email_error AS e FROM enquiries WHERE name = 'Untrusted'").get() as any).e;
  assert.match(err, /certificate|self.signed|unable to verify/i);
});

await test("--run-reminders path: does nothing while switched off", async () => {
  const { runReminders } = await import("../worker/lib/reminders.ts");
  const r = await runReminders(buildEnv(db));
  assert.equal(r.enabled, false);
});

await http.close();
db.close();
let fail = 0;
for (const r of results) { if (!r.ok) fail++; console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      -> ${r.detail}`}`); }
console.log(`\n${results.length - fail}/${results.length} passed`);
process.exit(fail ? 1 : 0);

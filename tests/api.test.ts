// End-to-end API tests: the REAL Worker code (routes, notify, SMTP client,
// Access JWT check, terms) running against the REAL D1 migrations in SQLite.
// Run: node --experimental-transform-types --no-warnings --import ./tests/harness/register.mjs tests/api.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { makeD1 } from "./harness/d1.ts";
import { smtpState } from "./harness/sockets.ts";

const RealDate = Date;
let fixedNow: number | null = null;
class FakeDate extends RealDate {
  constructor(...a: any[]) {
    if (a.length === 0 && fixedNow !== null) super(fixedNow);
    else super(...(a as []));
  }
  static now() {
    return fixedNow ?? RealDate.now();
  }
}
(globalThis as any).Date = FakeDate;

const worker = (await import("../worker/index.ts")).default;
const { CURRENT_TERMS, TERMS_VERSIONS } = await import("../worker/lib/terms.ts");

/* ---------------------------------------------------------- Access JWT ---- */
const TEAM = "test.cloudflareaccess.com";
const AUD = "aud-test";
const kp = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const pubJwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", alg: "RS256" };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  if (url === `https://${TEAM}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [pubJwk] }));
  return realFetch(input, init);
}) as typeof fetch;
const b64u = (b: Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? b : b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
async function jwt(claims: Record<string, unknown>) {
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1" }));
  const p = b64u(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64u(sig)}`;
}
const now = () => Math.floor(RealDate.now() / 1000);
const goodJwt = await jwt({ aud: [AUD], email: "amanda@example.com", iss: `https://${TEAM}`, exp: now() + 3600, iat: now() });

/* --------------------------------------------------------------- setup ---- */
let DB = makeD1("db/migrations");
const baseEnv = () => ({
  DB,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  SMTP_HOST: "mail.example.test",
  SMTP_PORT: "465",
  SMTP_USER: "website@sparklecarpets.im",
  SMTP_PASS: "pässword-ü",
  MAIL_FROM: "Sparkle Carpets <website@sparklecarpets.im>",
  MAIL_TO: "bookings@sparklecarpets.im",
});
let env: any = baseEnv();

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await worker.fetch(
    new Request(`https://sparklecarpets.im${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    {} as any,
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const admin = (method: string, path: string, body?: unknown) =>
  call(method, `/api/admin${path}`, body, { "Cf-Access-Jwt-Assertion": goodJwt });

const results: { area: string; name: string; ok: boolean; detail?: string }[] = [];
async function test(area: string, name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ area, name, ok: true });
  } catch (e) {
    results.push({ area, name, ok: false, detail: String((e as Error).message ?? e).slice(0, 300) });
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => iso(new RealDate(RealDate.now() + n * 86400000));
function nextFriday(fromDays: number) {
  for (let i = fromDays; i < fromDays + 7; i++) {
    const d = daysFromNow(i);
    if (new RealDate(d + "T12:00:00Z").getUTCDay() === 5) return d;
  }
  throw new Error("no friday");
}
const enquiry = (o: Record<string, unknown> = {}) => ({
  name: "Test Customer",
  email: "customer@example.com",
  phone: "07624 123456",
  preferred_start: daysFromNow(30),
  rate_plan_code: "48h",
  fulfilment: "self",
  area: "",
  address: "",
  extras: [],
  message: "",
  terms_acknowledged: true,
  website: "",
  ...o,
});
const row = (id: number) => DB.raw.prepare("SELECT * FROM enquiries WHERE id = ?").get(id) as any;
const lastId = () => (DB.raw.prepare("SELECT max(id) AS m FROM enquiries").get() as any).m as number;

/* ------------------------------------------------------------- 13 pricing - */
const PLANS: Record<string, number> = { "24h": 3000, "48h": 4500, weekend: 5500, "3day": 6000, week: 9500 };
const ZONES: [string, number][] = [
  ["Castletown", 500],
  ["Ballasalla, Derbyhaven", 750],
  ["Port Erin, Port St Mary, Colby", 1000],
  ["Ballabeg, Santon", 1500],
  ["Douglas, Braddan, Onchan", 2000],
  ["Peel, St John's, Laxey", 2500],
  ["Kirk Michael, Sulby, Ballaugh", 3500],
  ["Ramsey, Andreas, Jurby", 4000],
];
const DEPOSIT = 7500;
smtpState.mode = "ok";

await test("13 Pricing", "GET /api/pricing serves the published packages, zones and settings", async () => {
  const r = await call("GET", "/api/pricing");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.fromEntries(r.body.rates.map((x: any) => [x.code, x.price_pence])), PLANS);
  assert.deepEqual(r.body.delivery_zones.map((z: any) => [z.areas, z.one_way_pence]), ZONES);
  for (const z of r.body.delivery_zones) assert.equal(z.both_pence, z.one_way_pence * 2, z.areas);
  assert.deepEqual(r.body.addons.map((a: any) => a.code), ["solution"], "upholstery addon must be inactive");
  assert.equal(r.body.settings.deposit_pence, "7500");
  assert.equal(r.body.settings.extra_day_pence, "1500");
  assert.equal(r.body.settings.cleaning_charge_pence, "1000");
});

let pricedCount = 0;
await test("13 Pricing", "Every package x every transport option x every zone stores the correct total due", async () => {
  env = { ...baseEnv(), SMTP_HOST: undefined }; // emails off for bulk runs
  const fridays = nextFriday(40);
  for (const [plan, hire] of Object.entries(PLANS)) {
    const start = plan === "weekend" ? fridays : daysFromNow(40);
    const cases: [string, string, number][] = [["self", "", 0]];
    for (const [area, one] of ZONES) {
      cases.push(["deliver_only", area, one], ["collect_only", area, one], ["both", area, one * 2]);
    }
    for (const [fulfilment, area, transport] of cases) {
      for (const extras of [[], ["solution"]]) {
        const r = await call(
          "POST",
          "/api/enquiry",
          enquiry({ rate_plan_code: plan, preferred_start: start, fulfilment, area, address: area ? "1 Test Street" : "", extras }),
        );
        assert.equal(r.status, 200, `${plan}/${fulfilment}/${area}: ${JSON.stringify(r.body)}`);
        const expected = hire + transport + (extras.length ? 500 : 0) + DEPOSIT;
        assert.equal(row(lastId()).estimate_total_pence, expected, `${plan}/${fulfilment}/${area}/${extras}`);
        pricedCount++;
      }
    }
  }
  assert.equal(pricedCount, 5 * 25 * 2);
});

await test("13 Pricing", "Unlisted area is never priced from free text (transport quoted, total null)", async () => {
  const r = await call("POST", "/api/enquiry", enquiry({ fulfilment: "both", area: "Maughold", address: "Somewhere 1" }));
  assert.equal(r.status, 200);
  assert.equal(row(lastId()).estimate_total_pence, null);
});

await test("13 Pricing", "Inactive upholstery addon sent by a stale page is ignored, not charged", async () => {
  const r = await call("POST", "/api/enquiry", enquiry({ extras: ["upholstery_tool", "solution"] }));
  assert.equal(r.status, 200);
  const q = row(lastId());
  assert.deepEqual(JSON.parse(q.extras), ["solution"]);
  assert.equal(q.estimate_total_pence, 4500 + 500 + DEPOSIT);
});

/* --------------------------------------------------- validation / terms -- */
await test("15 Terms", "Enquiry without the read-terms acknowledgement is rejected server-side", async () => {
  for (const v of [false, "on", 1, undefined]) {
    const r = await call("POST", "/api/enquiry", enquiry({ terms_acknowledged: v }));
    assert.equal(r.status, 400, `value ${String(v)}`);
  }
});

await test("15 Terms", "Acknowledgement stores the current version, timestamp and its hash; formal acceptance left empty", async () => {
  const r = await call("POST", "/api/enquiry", enquiry());
  assert.equal(r.status, 200);
  const q = row(lastId());
  assert.equal(q.terms_version, CURRENT_TERMS.version);
  assert.match(q.terms_acknowledged_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const sha = createHash("sha256").update(readFileSync(`terms/versions/v${CURRENT_TERMS.version}.txt`, "utf8")).digest("hex");
  assert.equal(q.terms_hash, sha);
  assert.equal(q.accepted_at, null);
  assert.equal(q.accepted_terms_version, null);
  assert.equal(q.acceptance_method, null);
});

await test("15 Terms", "Generated terms module matches the canonical files (hashes and text)", () => {
  for (const [v, file] of [["1.1", "v1.1.txt"], ["1.0", "v1.0.txt"], ["0.2-draft", "v0.2.txt"]] as const) {
    const text = readFileSync(`terms/versions/${file}`, "utf8");
    assert.equal(TERMS_VERSIONS[v]!.text, text);
    assert.equal(TERMS_VERSIONS[v]!.sha256, createHash("sha256").update(text).digest("hex"));
  }
  assert.equal(CURRENT_TERMS.version, "1.1");
  assert.equal(TERMS_VERSIONS["1.0"]!.sha256, "14a20772cc7ea5c5566a66bfd3e092b4c01a66284f95f5ee1c136b6b5ea701ce", "v1.0 must never change");
});

await test("Content", "Published terms page carries exactly the current version's clauses (no clause missing or altered)", () => {
  const html = readFileSync("terms/index.html", "utf8");
  const pageText = html
    .replace(/<\/?(a|strong|span)\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  const canon = readFileSync(`terms/versions/v${CURRENT_TERMS.version}.txt`, "utf8");
  const clauses = canon.match(/^\d+\.\d+\. .+$/gm)!;
  assert.equal(clauses.length, 79);
  for (const c of clauses) assert.ok(pageText.includes(c.replace(/\s+/g, " ").replace(/:$/, ":")), `missing on page: ${c.slice(0, 60)}`);
  assert.ok(!/<li>\s*\d+\.\d+\./.test(html), "clause numbers must not sit inside list items (double numbering)");
});

/* ------------------------------------------------- 11 overlap detection -- */
await test("11 Overlap", "Server rejects enquiries whose span touches a confirmed booking or block (inclusive ends)", async () => {
  env = { ...baseEnv(), SMTP_HOST: undefined };
  const b = await admin("POST", "/diary", { start_date: daysFromNow(60), end_date: daysFromNow(62), kind: "blocked", note: "test" });
  assert.equal(b.status, 200);
  const cases: [string, string, number][] = [
    ["24h", daysFromNow(60), 409], // first blocked day
    ["24h", daysFromNow(62), 409], // last blocked day
    ["48h", daysFromNow(59), 409], // runs into the start
    ["week", daysFromNow(55), 409], // spans across
    ["24h", daysFromNow(63), 200], // day after
    ["48h", daysFromNow(58), 200], // ends the day before
  ];
  for (const [plan, start, expect] of cases) {
    const r = await call("POST", "/api/enquiry", enquiry({ rate_plan_code: plan, preferred_start: start }));
    assert.equal(r.status, expect, `${plan} from ${start}`);
  }
});

await test("11 Overlap", "Pending enquiries do not block availability", async () => {
  const d = daysFromNow(70);
  assert.equal((await call("POST", "/api/enquiry", enquiry({ preferred_start: d }))).status, 200);
  assert.equal((await call("POST", "/api/enquiry", enquiry({ preferred_start: d }))).status, 200);
  const u = await call("GET", "/api/unavailable");
  assert.ok(!u.body.unavailable.some((r: any) => r.start_date <= d && r.end_date >= d));
});

/* ------------------------------------------ 12 weekend and IoM timezone -- */
await test("12 Weekend/TZ", "Weekend hire must start on a Friday (server)", async () => {
  const fri = nextFriday(80);
  for (let k = 1; k <= 6; k++) {
    const d = iso(new RealDate(new RealDate(fri + "T12:00:00Z").getTime() + k * 86400000));
    const r = await call("POST", "/api/enquiry", enquiry({ rate_plan_code: "weekend", preferred_start: d }));
    assert.equal(r.status, 400, `weekend starting ${d}`);
  }
  assert.equal((await call("POST", "/api/enquiry", enquiry({ rate_plan_code: "weekend", preferred_start: fri }))).status, 200);
});

await test("12 Weekend/TZ", "Weekend span includes the Monday return day: a Monday booking blocks the weekend before", async () => {
  const fri = nextFriday(90);
  const mon = iso(new RealDate(new RealDate(fri + "T12:00:00Z").getTime() + 3 * 86400000));
  await admin("POST", "/diary", { start_date: mon, end_date: mon, kind: "booking", name: "Monday hire" });
  const r = await call("POST", "/api/enquiry", enquiry({ rate_plan_code: "weekend", preferred_start: fri }));
  assert.equal(r.status, 409);
});

await test("12 Weekend/TZ", "After midnight BST (23:30 UTC) 'today' is already the next day on the Isle of Man", async () => {
  // Fresh DB so earlier rows don't interfere.
  DB = makeD1("db/migrations");
  env = { ...baseEnv(), DB, SMTP_HOST: undefined };
  fixedNow = RealDate.parse("2027-07-01T23:30:00Z"); // 00:30 BST on 2 July 2027
  try {
    const past = await call("POST", "/api/enquiry", enquiry({ preferred_start: "2027-07-01" }));
    assert.equal(past.status, 400, "1 July is the past on the island at 00:30 BST");
    const ok = await call("POST", "/api/enquiry", enquiry({ preferred_start: "2027-07-02" }));
    assert.equal(ok.status, 200);
    // inserted directly: the admin JWT minted in real time would read as expired at the faked 2027 clock
    DB.raw.exec("INSERT INTO diary (start_date, end_date, kind) VALUES ('2027-07-01','2027-07-01','blocked'), ('2027-07-02','2027-07-02','blocked')");
    const u = await call("GET", "/api/unavailable");
    assert.deepEqual(u.body.unavailable.map((r: any) => r.start_date), ["2027-07-02"], "yesterday's block is not listed");
  } finally {
    fixedNow = null;
  }
});

await test("12 Weekend/TZ", "In winter (GMT) 23:30 UTC is still the same day", async () => {
  fixedNow = RealDate.parse("2027-01-14T23:30:00Z");
  try {
    const r = await call("POST", "/api/enquiry", enquiry({ preferred_start: "2027-01-14" }));
    assert.equal(r.status, 200);
  } finally {
    fixedNow = null;
  }
});

/* -------------------------------- 14 persistence, email, SMTP recovery -- */
await test("14 Email", "Enquiry persisted and both emails delivered over SMTP (implicit TLS, AUTH PLAIN)", async () => {
  DB = makeD1("db/migrations");
  env = baseEnv();
  smtpState.mode = "ok";
  smtpState.sessions.length = 0;
  const r = await call("POST", "/api/enquiry", enquiry({ message: "Line one\n.\n..two dots\nend" }));
  assert.equal(r.status, 200);
  assert.equal(r.body.emailed, true);
  const q = row(lastId());
  assert.equal(q.emailed, 1);
  assert.equal(q.email_error, null);
  assert.equal(smtpState.sessions.length, 2, "notification + acknowledgement");
  const [n, a] = smtpState.sessions;
  assert.equal(n!.secure, "on");
  const tok = Buffer.from(n!.authToken!, "base64").toString("utf8");
  assert.equal(tok, "\u0000website@sparklecarpets.im\u0000pässword-ü", "AUTH PLAIN carries UTF-8 credentials");
  assert.deepEqual(n!.messages[0]!.to, ["RCPT TO:<bookings@sparklecarpets.im>"]);
  assert.deepEqual(a!.messages[0]!.to, ["RCPT TO:<customer@example.com>"]);
  const data = n!.messages[0]!.data;
  assert.ok(data.includes("\r\n..\r\n"), "lone dot is dot-stuffed");
  assert.ok(data.includes("\r\n...two dots\r\n"), "leading dots are stuffed");
  assert.ok(/^Message-ID: <[0-9a-f-]+@sparklecarpets\.im>$/m.test(data));
  assert.ok(data.includes("acknowledged as read at enquiry"));
  const ack = a!.messages[0]!.data;
  assert.ok(ack.includes("This is NOT a confirmed booking yet"));
  assert.ok(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m.test(ack), "non-ASCII subject is RFC 2047 encoded");
  const subj = ack.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/m)![1]!;
  assert.equal(Buffer.from(subj, "base64").toString("utf8"), "We've received your enquiry — Sparkle Carpets");
});

await test("14 Email", "STARTTLS path (port 587) upgrades before authenticating", async () => {
  env = { ...baseEnv(), SMTP_PORT: "587" };
  smtpState.sessions.length = 0;
  const r = await call("POST", "/api/enquiry", enquiry());
  assert.equal(r.body.emailed, true);
  const s = smtpState.sessions[0]!;
  assert.equal(s.secure, "starttls");
  const idx = (cmd: string) => s.lines.findIndex((l) => l.startsWith(cmd));
  assert.ok(idx("STARTTLS") > 0 && idx("STARTTLS") < idx("AUTH"), "AUTH only after STARTTLS");
  assert.equal(s.lines.filter((l) => l.startsWith("EHLO")).length, 2, "EHLO repeated after TLS");
});

await test("14 Email", "Customer name cannot inject headers or redirect the acknowledgement", async () => {
  env = baseEnv();
  smtpState.sessions.length = 0;
  const r = await call("POST", "/api/enquiry", enquiry({ name: "Eve <victim@evil.test>\r\nBcc: spam@evil.test" }));
  assert.equal(r.status, 200);
  const ack = smtpState.sessions[1]!.messages[0]!;
  assert.deepEqual(ack.to, ["RCPT TO:<customer@example.com>"]);
  assert.ok(!/^Bcc:/im.test(ack.data));
  assert.ok(!ack.data.includes("victim@evil.test>"));
});

await test("14 Email", "SMTP auth failure: enquiry still saved, flagged, customer told; admin retry then succeeds", async () => {
  smtpState.mode = "auth_fail";
  const r = await call("POST", "/api/enquiry", enquiry({ name: "Retry Person" }));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.emailed, false);
  const id = lastId();
  assert.equal(row(id).emailed, 0);
  assert.match(row(id).email_error, /535/);
  smtpState.mode = "ok";
  const retry = await admin("POST", `/enquiries/${id}/resend`);
  assert.equal(retry.status, 200);
  assert.equal(row(id).emailed, 1);
  assert.equal(row(id).email_error, null);
});

await test("14 Email", "Mail server unreachable: enquiry saved and flagged, no crash", async () => {
  smtpState.mode = "refuse";
  const r = await call("POST", "/api/enquiry", enquiry());
  assert.equal(r.status, 200);
  assert.equal(r.body.emailed, false);
  assert.ok(row(lastId()).email_error);
  smtpState.mode = "ok";
});

await test("14 Email", "SMTP not configured: enquiry saved with a clear flag", async () => {
  env = { ...baseEnv(), SMTP_PASS: undefined };
  const r = await call("POST", "/api/enquiry", enquiry());
  assert.equal(r.body.emailed, false);
  assert.equal(row(lastId()).email_error, "SMTP not configured");
  env = baseEnv();
});

/* --------------------------------------------- admin access (fail-closed) - */
await test("16 Admin", "Admin API is fail-closed: unconfigured 503, no/forged/wrong-audience/expired token 401", async () => {
  env = { ...baseEnv(), ACCESS_AUD: "" };
  assert.equal((await admin("GET", "/enquiries")).status, 503);
  env = baseEnv();
  assert.equal((await call("GET", "/api/admin/enquiries")).status, 401);
  const wrongAud = await jwt({ aud: ["other"], email: "x@y", iss: `https://${TEAM}`, exp: now() + 60, iat: now() });
  assert.equal((await call("GET", "/api/admin/enquiries", undefined, { "Cf-Access-Jwt-Assertion": wrongAud })).status, 401);
  const expired = await jwt({ aud: [AUD], email: "x@y", iss: `https://${TEAM}`, exp: now() - 10, iat: now() - 100 });
  assert.equal((await call("GET", "/api/admin/enquiries", undefined, { "Cf-Access-Jwt-Assertion": expired })).status, 401);
  const forged = goodJwt.slice(0, -6) + "AAAAAA";
  assert.equal((await call("GET", "/api/admin/enquiries", undefined, { "Cf-Access-Jwt-Assertion": forged })).status, 401);
  assert.equal((await admin("GET", "/enquiries")).status, 200);
});

/* ------------------------------ 15 formal acceptance / 16 admin flows ---- */
let confirmId = 0;
await test("15 Terms", "Confirming does NOT record formal acceptance; confirmation email doesn't claim it", async () => {
  smtpState.mode = "ok";
  const start = daysFromNow(100);
  await call("POST", "/api/enquiry", enquiry({ preferred_start: start, name: "No Accept" }));
  const id = lastId();
  smtpState.sessions.length = 0;
  const c = await admin("POST", `/enquiries/${id}/confirm`);
  assert.equal(c.status, 200);
  assert.equal(c.body.confirmation_emailed, true);
  const q = row(id);
  assert.equal(q.status, "confirmed");
  assert.equal(q.accepted_at, null);
  assert.equal(q.acceptance_method, null);
  const mail = smtpState.sessions[0]!.messages[0]!.data;
  assert.ok(mail.includes(`Equipment Hire Terms & Conditions v${CURRENT_TERMS.version}.`), "names the version");
  assert.ok(!mail.includes("which you accepted"));
  assert.ok(mail.includes("Handover may be with Amanda or with Barry"));
  const canon = readFileSync(`terms/versions/v${CURRENT_TERMS.version}.txt`, "utf8").replace(/\r?\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..");
  assert.ok(mail.includes(canon.trimEnd()), "durable full copy of the acknowledged version embedded verbatim");
});

await test("15 Terms", "Enquiry acknowledged under v1.0 is confirmed with the v1.0 text, never silently the newer version", async () => {
  await call("POST", "/api/enquiry", enquiry({ preferred_start: daysFromNow(105), name: "Old Terms" }));
  const id = lastId();
  DB.raw.prepare("UPDATE enquiries SET terms_version = '1.0' WHERE id = ?").run(id);
  smtpState.sessions.length = 0;
  assert.equal((await admin("POST", `/enquiries/${id}/confirm`)).status, 200);
  const mail = smtpState.sessions[0]!.messages[0]!.data;
  assert.ok(mail.includes("Equipment Hire Terms & Conditions v1.0."));
  assert.ok(mail.includes("12.3. Optional accessories, including upholstery attachments where available"));
  assert.ok(!mail.includes("Version 1.1"));
});

await test("15 Terms", "Recording acceptance stores version, time and method, audited; repeat and bad method refused", async () => {
  await call("POST", "/api/enquiry", enquiry({ preferred_start: daysFromNow(110), name: "Accepts" }));
  const id = lastId();
  assert.equal((await admin("POST", `/enquiries/${id}/acceptance`, { method: "fax" })).status, 400);
  const a = await admin("POST", `/enquiries/${id}/acceptance`, { method: "whatsapp" });
  assert.equal(a.status, 200);
  const q = row(id);
  assert.equal(q.accepted_terms_version, CURRENT_TERMS.version);
  assert.equal(q.acceptance_method, "whatsapp");
  assert.match(q.accepted_at, /^\d{4}-\d{2}-\d{2} /);
  assert.equal(q.terms_version, CURRENT_TERMS.version, "acknowledgement kept separately");
  assert.equal((await admin("POST", `/enquiries/${id}/acceptance`, { method: "email" })).status, 409);
  assert.equal(row(id).acceptance_method, "whatsapp", "not overwritten");
  const act = await admin("GET", "/activity");
  assert.ok(act.body.activity.some((x: any) => x.action === "enquiry.terms_accepted" && x.entity_id === id && x.detail === `v${CURRENT_TERMS.version} via whatsapp`));
  smtpState.sessions.length = 0;
  assert.equal((await admin("POST", `/enquiries/${id}/confirm`)).status, 200);
  assert.ok(smtpState.sessions[0]!.messages[0]!.data.includes("which you accepted when we agreed your booking"));
  confirmId = id;
});

await test("16 Admin", "Confirm writes the diary span; dates then show as unavailable; double-confirm refused", async () => {
  const q = row(confirmId);
  const d = DB.raw.prepare("SELECT * FROM diary WHERE enquiry_id = ?").get(confirmId) as any;
  assert.equal(d.start_date, q.preferred_start);
  assert.equal(d.end_date, iso(new RealDate(new RealDate(q.preferred_start + "T12:00:00Z").getTime() + 86400000)), "48h covers 2 days");
  const u = await call("GET", "/api/unavailable");
  assert.ok(u.body.unavailable.some((r: any) => r.start_date === d.start_date && r.end_date === d.end_date));
  assert.equal((await admin("POST", `/enquiries/${confirmId}/confirm`)).status, 409);
});

await test("16 Admin", "Two overlapping enquiries confirmed at once: exactly one wins, the other gets 409", async () => {
  const fri = nextFriday(120);
  await call("POST", "/api/enquiry", enquiry({ preferred_start: fri, rate_plan_code: "weekend" }));
  const a = lastId();
  const mon = iso(new RealDate(new RealDate(fri + "T12:00:00Z").getTime() + 3 * 86400000));
  await call("POST", "/api/enquiry", enquiry({ preferred_start: mon, rate_plan_code: "24h" }));
  const b = lastId();
  const [ra, rb] = await Promise.all([admin("POST", `/enquiries/${a}/confirm`), admin("POST", `/enquiries/${b}/confirm`)]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
  const n = (DB.raw.prepare("SELECT count(*) AS n FROM diary WHERE enquiry_id IN (?, ?)").get(a, b) as any).n;
  assert.equal(n, 1);
});

await test("16 Admin", "Declined enquiry: status set, audited, never blocks the calendar", async () => {
  const d = daysFromNow(130);
  await call("POST", "/api/enquiry", enquiry({ preferred_start: d }));
  const id = lastId();
  assert.equal((await admin("POST", `/enquiries/${id}/status`, { status: "declined" })).status, 200);
  assert.equal(row(id).status, "declined");
  assert.equal((await admin("POST", `/enquiries/${id}/status`, { status: "bogus" })).status, 400);
  const u = await call("GET", "/api/unavailable");
  assert.ok(!u.body.unavailable.some((r: any) => r.start_date <= d && r.end_date >= d));
  assert.equal((await call("POST", "/api/enquiry", enquiry({ preferred_start: d }))).status, 200);
});

const ALL_OK = { machine_ok: true, attachment: true, hose: true, accessories: true, detergent: true, photos: false };
const drow = (id: number) => DB.raw.prepare("SELECT * FROM diary WHERE id = ?").get(id) as any;
const ledger = (id: number) => (DB.raw.prepare("SELECT kind, amount_pence, reason FROM deposit_entries WHERE diary_id = ? ORDER BY id").all(id) as any[]).map((r) => ({ ...r }));
async function newBooking(daysAhead: number, name = "Ledger Test") {
  const r = await admin("POST", "/diary", { start_date: daysFromNow(daysAhead), end_date: daysFromNow(daysAhead + 1), kind: "booking", name });
  return r.body.id as number;
}

await test("Phase 2", "Handover records checklist, hire payment (amount + method) and deposit taken, with times", async () => {
  const id = await newBooking(150);
  const r = await admin("POST", `/diary/${id}/handover`, { checks: ALL_OK, note: "Small scuff on handle", hire_paid_pence: 4500, hire_paid_method: "cash", deposit_pence: 7500 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = drow(id);
  assert.match(d.handed_over_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const chk = JSON.parse(d.handover_check);
  assert.equal(chk.attachment, true); assert.equal(chk.photos, false); assert.equal(chk.note, "Small scuff on handle");
  assert.equal(d.paid, 1); assert.equal(d.hire_paid_pence, 4500); assert.equal(d.hire_paid_method, "cash"); assert.ok(d.hire_paid_at);
  assert.deepEqual(ledger(id), [{ kind: "taken", amount_pence: 7500, reason: null }]);
  assert.equal(d.deposit_status, "held");
});

await test("Phase 2", "Duplicate and out-of-order actions are refused (double handover, return before handover, double return)", async () => {
  const id = await newBooking(155);
  assert.equal((await admin("POST", `/diary/${id}/return`, { checks: ALL_OK })).status, 409, "return before handover");
  assert.equal((await admin("POST", `/diary/${id}/deposit/refund`, { amount_pence: 100 })).status, 409, "refund before return");
  assert.equal((await admin("POST", `/diary/${id}/handover`, { checks: ALL_OK, deposit_pence: 7500 })).status, 200);
  assert.equal((await admin("POST", `/diary/${id}/handover`, { checks: ALL_OK, deposit_pence: 7500 })).status, 409, "second handover");
  assert.equal(ledger(id).length, 1, "deposit taken once only");
  assert.equal((await admin("POST", `/diary/${id}/return`, { checks: ALL_OK, refund_pence: 7500 })).status, 200);
  assert.equal((await admin("POST", `/diary/${id}/return`, { checks: ALL_OK, refund_pence: 7500 })).status, 409, "second return");
  assert.equal(ledger(id).filter((e) => e.kind === "refund").length, 1, "refunded once only");
  assert.equal(drow(id).deposit_status, "refunded");
});

await test("Phase 2", "Two devices recording the same handover at once: exactly one succeeds", async () => {
  const id = await newBooking(160);
  const [a, b] = await Promise.all([
    admin("POST", `/diary/${id}/handover`, { checks: ALL_OK, deposit_pence: 7500, hire_paid_pence: 4500, hire_paid_method: "bank" }),
    admin("POST", `/diary/${id}/handover`, { checks: ALL_OK, deposit_pence: 7500, hire_paid_pence: 4500, hire_paid_method: "bank" }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(ledger(id).length, 1);
});

await test("Phase 2", "Partial refunds and deductions: itemised, reasons required, never more than held", async () => {
  const id = await newBooking(165);
  await admin("POST", `/diary/${id}/handover`, { checks: ALL_OK, deposit_pence: 7500 });
  assert.equal((await admin("POST", `/diary/${id}/return`, { checks: ALL_OK, deduction_pence: 1000 })).status, 400, "deduction without reason");
  assert.equal((await admin("POST", `/diary/${id}/return`, { checks: ALL_OK, deduction_pence: 5000, deduction_reason: "x", refund_pence: 5000 })).status, 400);
  assert.equal((await admin("POST", `/diary/${id}/return`, { checks: ALL_OK, deduction_pence: 5000, deduction_reason: "Cracked tank", refund_pence: 5000 })).status, 409, "over held");
  assert.equal(drow(id).returned, 0, "refused return changed nothing");
  const r = await admin("POST", `/diary/${id}/return`, { checks: { ...ALL_OK, machine_ok: false }, note: "Tank lid cracked", deduction_pence: 1000, deduction_reason: "Excess cleaning (terms 7.5)", refund_pence: 3000 });
  assert.equal(r.status, 200); assert.equal(r.body.held_pence, 3500);
  assert.equal(drow(id).deposit_status, "held", "still partly held");
  assert.equal((await admin("POST", `/diary/${id}/deposit/refund`, { amount_pence: 4000 })).status, 409, "refund above held");
  assert.equal((await admin("POST", `/diary/${id}/deposit/deduction`, { amount_pence: 500 })).status, 400, "deduction needs reason");
  assert.equal((await admin("POST", `/diary/${id}/deposit/refund`, { amount_pence: 0 })).status, 400);
  assert.equal((await admin("POST", `/diary/${id}/deposit/refund`, { amount_pence: -5 })).status, 400);
  assert.equal((await admin("POST", `/diary/${id}/deposit/refund`, { amount_pence: 12.5 })).status, 400);
  assert.equal((await admin("POST", `/diary/${id}/deposit/refund`, { amount_pence: 3500 })).status, 200);
  assert.deepEqual(ledger(id).map((e) => [e.kind, e.amount_pence]), [["taken", 7500], ["deduction", 1000], ["refund", 3000], ["refund", 3500]]);
  assert.equal(drow(id).deposit_status, "deducted", "fully settled with a deduction");
  assert.equal((await admin("POST", `/diary/${id}/deposit/refund`, { amount_pence: 1 })).status, 409, "nothing left");
  const g = await admin("GET", `/diary/${id}/deposit`);
  assert.equal(g.body.entries.length, 4); assert.ok(g.body.entries.every((e: any) => e.created_at));
});

await test("Phase 2", "Two simultaneous full refunds: one succeeds, the other is refused", async () => {
  const id = await newBooking(170);
  await admin("POST", `/diary/${id}/handover`, { checks: ALL_OK, deposit_pence: 7500 });
  await admin("POST", `/diary/${id}/return`, { checks: ALL_OK });
  const [a, b] = await Promise.all([
    admin("POST", `/diary/${id}/deposit/refund`, { amount_pence: 7500 }),
    admin("POST", `/diary/${id}/deposit/refund`, { amount_pence: 7500 }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(ledger(id).filter((e) => e.kind === "refund").length, 1);
});

await test("Phase 2", "Hire payment recorded separately (e.g. bank transfer first): once only, amount and method validated", async () => {
  const id = await newBooking(175);
  assert.equal((await admin("POST", `/diary/${id}/payment`, { amount_pence: 4500, method: "cheque" })).status, 400);
  assert.equal((await admin("POST", `/diary/${id}/payment`, { amount_pence: 0, method: "bank" })).status, 400);
  assert.equal((await admin("POST", `/diary/${id}/payment`, { amount_pence: 4500, method: "bank" })).status, 200);
  assert.equal((await admin("POST", `/diary/${id}/payment`, { amount_pence: 4500, method: "bank" })).status, 409);
  assert.equal((await admin("POST", `/diary/${id}/handover`, { checks: ALL_OK, hire_paid_pence: 4500, hire_paid_method: "cash" })).status, 409, "would double-record income");
  assert.equal((await admin("POST", `/diary/${id}/handover`, { checks: ALL_OK, deposit_pence: 7500 })).status, 200);
  const d = drow(id);
  assert.equal(d.hire_paid_pence, 4500); assert.equal(d.hire_paid_method, "bank");
  assert.equal(ledger(id)[0].amount_pence, 7500, "deposit kept apart from hire income");
});

await test("Phase 2", "Blocked dates can't be handed over; hires with records can't be deleted; plain bookings still can", async () => {
  const blk = (await admin("POST", "/diary", { start_date: daysFromNow(180), end_date: daysFromNow(180), kind: "blocked" })).body.id;
  assert.equal((await admin("POST", `/diary/${blk}/handover`, { checks: ALL_OK })).status, 409);
  assert.equal((await admin("POST", `/diary/${blk}/payment`, { amount_pence: 100, method: "cash" })).status, 409);
  const id = await newBooking(182);
  await admin("POST", `/diary/${id}/handover`, { checks: ALL_OK, deposit_pence: 7500 });
  assert.equal((await admin("DELETE", `/diary/${id}`)).status, 409);
  assert.ok(drow(id));
  const plain = await newBooking(185);
  assert.equal((await admin("DELETE", `/diary/${plain}`)).status, 200);
  assert.equal(drow(plain), undefined);
  assert.equal((await admin("POST", `/diary/999999/handover`, { checks: ALL_OK })).status, 404);
});

await test("Phase 2", "Legacy rows keep their values after migration 0010; old flag endpoints are gone", async () => {
  const leg = DB.raw.prepare("INSERT INTO diary (start_date, end_date, kind, name, paid, returned, deposit_status) VALUES ('2026-01-01','2026-01-02','booking','Legacy',1,1,'refunded') RETURNING id").get() as any;
  const d = drow(leg.id);
  assert.equal(d.paid, 1); assert.equal(d.deposit_status, "refunded"); assert.equal(d.hire_paid_pence, null);
  assert.equal((await admin("POST", `/diary/${leg.id}/paid`, { paid: true })).status, 404);
  assert.equal((await admin("POST", `/diary/${leg.id}/returned`, { returned: true })).status, 404);
});

await test("Phase 2", "Today dashboard: going out, due back (incl. overdue), open enquiries, deposits to settle", async () => {
  const savedDB = DB;
  DB = makeD1("db/migrations");
  env = baseEnv();
  try {
  const today = new RealDate(RealDate.now());
  const iomToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Isle_of_Man" }).format(today);
  const shift = (n: number) => iso(new RealDate(new RealDate(iomToday + "T12:00:00Z").getTime() + n * 86400000));
  const mk = async (start: string, end: string, name: string) =>
    (await admin("POST", "/diary", { start_date: start, end_date: end, kind: "booking", name })).body.id as number;
  const goingOut = await mk(iomToday, shift(1), "Out Today");
  const lateOut = await mk(shift(-1), shift(1), "Late Collect");
  await mk(shift(3), shift(4), "Future");
  const dueBack = await mk(shift(-1), iomToday, "Back Today");
  await admin("POST", `/diary/${dueBack}/handover`, { checks: ALL_OK, deposit_pence: 7500 });
  const overdue = await mk(shift(-3), shift(-1), "Overdue");
  await admin("POST", `/diary/${overdue}/handover`, { checks: ALL_OK, deposit_pence: 7500 });
  const settle = await mk(shift(-5), shift(-4), "Refund Me");
  await admin("POST", `/diary/${settle}/handover`, { checks: ALL_OK, deposit_pence: 7500 });
  await admin("POST", `/diary/${settle}/return`, { checks: ALL_OK, refund_pence: 2500 });
  const done = await mk(shift(-8), shift(-7), "All Settled");
  await admin("POST", `/diary/${done}/handover`, { checks: ALL_OK, deposit_pence: 7500 });
  await admin("POST", `/diary/${done}/return`, { checks: ALL_OK, refund_pence: 7500 });
  await call("POST", "/api/enquiry", enquiry({ preferred_start: shift(20), name: "Open Enquiry" }));
  const t = await admin("GET", "/today");
  assert.equal(t.status, 200);
  assert.equal(t.body.today, iomToday);
  assert.deepEqual(t.body.going_out.map((x: any) => x.name).sort(), ["Late Collect", "Out Today"]);
  assert.deepEqual(t.body.due_back.map((x: any) => x.name).sort(), ["Back Today", "Overdue"]);
  assert.deepEqual(t.body.enquiries.map((x: any) => x.name), ["Open Enquiry"]);
  assert.deepEqual(t.body.deposits_to_settle.map((x: any) => x.name), ["Refund Me"]);
  const r = t.body.deposits_to_settle[0];
  assert.equal(r.deposit_taken - r.deposit_refunded - r.deposit_deducted, 5000);
  assert.equal(t.body.deposit_default_pence, 7500);
  } finally {
    DB = savedDB;
    env = baseEnv();
  }
});

await test("16 Admin", "Confirmation email failure is surfaced and audited; booking stays saved", async () => {
  await call("POST", "/api/enquiry", enquiry({ preferred_start: daysFromNow(140) }));
  const id = lastId();
  smtpState.mode = "auth_fail";
  const c = await admin("POST", `/enquiries/${id}/confirm`);
  smtpState.mode = "ok";
  assert.equal(c.status, 200);
  assert.equal(c.body.confirmation_emailed, false);
  assert.equal(row(id).status, "confirmed");
  const acts = (await admin("GET", "/activity")).body.activity;
  assert.ok(acts.some((x: any) => x.action === "enquiry.confirm_email_failed" && x.entity_id === id));
});

await test("16 Admin", "Admin enquiry list exposes acknowledgement and acceptance fields separately", async () => {
  const l = await admin("GET", "/enquiries");
  const e = l.body.enquiries.find((x: any) => x.id === confirmId);
  for (const k of ["terms_version", "terms_acknowledged_at", "accepted_terms_version", "accepted_at", "acceptance_method"]) assert.ok(k in e, k);
});

/* ------------------------------------------------------------- report ---- */
let fail = 0;
for (const r of results) {
  if (!r.ok) fail++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  [${r.area}] ${r.name}${r.ok ? "" : `\n      -> ${r.detail}`}`);
}
console.log(`\n${results.length - fail}/${results.length} passed (${pricedCount} priced enquiries checked)`);
process.exit(fail ? 1 : 0);

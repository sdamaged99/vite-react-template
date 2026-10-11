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

await test("15 Terms", "Acknowledgement stores version 1.0, timestamp and the v1.0 hash; formal acceptance left empty", async () => {
  const r = await call("POST", "/api/enquiry", enquiry());
  assert.equal(r.status, 200);
  const q = row(lastId());
  assert.equal(q.terms_version, "1.0");
  assert.match(q.terms_acknowledged_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const sha = createHash("sha256").update(readFileSync("terms/versions/v1.0.txt", "utf8")).digest("hex");
  assert.equal(q.terms_hash, sha);
  assert.equal(q.accepted_at, null);
  assert.equal(q.accepted_terms_version, null);
  assert.equal(q.acceptance_method, null);
});

await test("15 Terms", "Generated terms module matches the canonical files (hashes and text)", () => {
  for (const [v, file] of [["1.0", "v1.0.txt"], ["0.2-draft", "v0.2.txt"]] as const) {
    const text = readFileSync(`terms/versions/${file}`, "utf8");
    assert.equal(TERMS_VERSIONS[v]!.text, text);
    assert.equal(TERMS_VERSIONS[v]!.sha256, createHash("sha256").update(text).digest("hex"));
  }
  assert.equal(CURRENT_TERMS.version, "1.0");
});

await test("Content", "Published terms page carries exactly the v1.0 clauses (no clause missing or altered)", () => {
  const html = readFileSync("terms/index.html", "utf8");
  const pageText = html
    .replace(/<\/?(a|strong|span)\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  const canon = readFileSync("terms/versions/v1.0.txt", "utf8");
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
  assert.ok(mail.includes("Equipment Hire Terms & Conditions v1.0."), "names the version");
  assert.ok(!mail.includes("which you accepted"));
  assert.ok(mail.includes("Handover may be with Amanda or with Barry"));
  const canon = readFileSync("terms/versions/v1.0.txt", "utf8").replace(/\r?\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..");
  assert.ok(mail.includes(canon.trimEnd()), "durable full copy of v1.0 embedded verbatim");
});

await test("15 Terms", "Recording acceptance stores version, time and method, audited; repeat and bad method refused", async () => {
  await call("POST", "/api/enquiry", enquiry({ preferred_start: daysFromNow(110), name: "Accepts" }));
  const id = lastId();
  assert.equal((await admin("POST", `/enquiries/${id}/acceptance`, { method: "fax" })).status, 400);
  const a = await admin("POST", `/enquiries/${id}/acceptance`, { method: "whatsapp" });
  assert.equal(a.status, 200);
  const q = row(id);
  assert.equal(q.accepted_terms_version, "1.0");
  assert.equal(q.acceptance_method, "whatsapp");
  assert.match(q.accepted_at, /^\d{4}-\d{2}-\d{2} /);
  assert.equal(q.terms_version, "1.0", "acknowledgement kept separately");
  assert.equal((await admin("POST", `/enquiries/${id}/acceptance`, { method: "email" })).status, 409);
  assert.equal(row(id).acceptance_method, "whatsapp", "not overwritten");
  const act = await admin("GET", "/activity");
  assert.ok(act.body.activity.some((x: any) => x.action === "enquiry.terms_accepted" && x.entity_id === id && x.detail === "v1.0 via whatsapp"));
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

await test("16 Admin", "Return, payment and deposit are separate records; returned never touches the deposit", async () => {
  const diaryId = (DB.raw.prepare("SELECT id FROM diary WHERE enquiry_id = ?").get(confirmId) as any).id;
  const get = () => DB.raw.prepare("SELECT returned, paid, deposit_status FROM diary WHERE id = ?").get(diaryId) as any;
  const before = get();
  assert.equal((await admin("POST", `/diary/${diaryId}/paid`, { paid: true })).status, 200);
  assert.equal((await admin("POST", `/diary/${diaryId}/deposit`, { status: "held" })).status, 200);
  assert.equal((await admin("POST", `/diary/${diaryId}/returned`, { returned: true })).status, 200);
  assert.deepEqual({ ...get() }, { returned: 1, paid: 1, deposit_status: "held" }, `before: ${JSON.stringify(before)}`);
  assert.equal((await admin("POST", `/diary/${diaryId}/deposit`, { status: "refunded" })).status, 200);
  assert.equal(get().deposit_status, "refunded");
  assert.equal((await admin("POST", `/diary/${diaryId}/deposit`, { status: "lost" })).status, 400);
  const acts = (await admin("GET", "/activity")).body.activity.map((x: any) => x.action);
  for (const a of ["diary.paid", "diary.returned", "diary.deposit", "enquiry.confirm", "enquiry.status"]) assert.ok(acts.includes(a), a);
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

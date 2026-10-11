// Test-only local server: serves the real pages and the real browser
// TypeScript (types stripped on the fly), and routes /api/* into the real
// Worker running on SQLite with the fake SMTP server. No Tailwind build is
// available offline, so pages render UNSTYLED here: good for behaviour,
// not for visual/layout checks.
// Run: node --experimental-transform-types --no-warnings --import ./tests/harness/register.mjs tests/harness/server.ts <port>
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { makeD1 } from "./d1.ts";
import { smtpState } from "./sockets.ts";

const worker = (await import("../../worker/index.ts")).default;
const ROOT = new URL("../../", import.meta.url).pathname;
const port = Number(process.argv[2] ?? 8787);
let DB = makeD1(ROOT + "db/migrations");
// Cloudflare Access stand-in: a local signing key, its JWKS served to the
// Worker's own verifier, and /__test/jwt to mint Amanda's token.
const TEAM = "test.cloudflareaccess.com";
const AUD = "aud-test";
const kp = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", alg: "RS256" };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (i: any, init?: any) =>
  (typeof i === "string" ? i : i.url) === `https://${TEAM}/cdn-cgi/access/certs`
    ? new Response(JSON.stringify({ keys: [jwk] }))
    : realFetch(i, init)) as typeof fetch;
const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
async function mintJwt() {
  const t = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1" }));
  const p = b64u(JSON.stringify({ aud: [AUD], email: "amanda@example.com", iss: `https://${TEAM}`, iat: t, exp: t + 3600 }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64u(sig)}`;
}

const env = () => ({
  DB,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  SMTP_HOST: "mail.example.test",
  SMTP_PORT: "465",
  SMTP_USER: "u",
  SMTP_PASS: "p",
  MAIL_FROM: "Sparkle Carpets <website@sparklecarpets.im>",
  MAIL_TO: "bookings@sparklecarpets.im",
});
smtpState.mode = "ok";

const TYPES: Record<string, string> = { ".html": "text/html", ".jpg": "image/jpeg", ".webp": "image/webp", ".txt": "text/plain" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);

  // Test controls
  if (url.pathname === "/__test/sql") {
    const { sql, params } = JSON.parse(body.toString() || "{}");
    const st = DB.raw.prepare(sql);
    const out = /^\s*select/i.test(sql) ? st.all(...(params ?? [])) : st.run(...(params ?? []));
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
  }
  if (url.pathname === "/__test/reset") {
    DB = makeD1(ROOT + "db/migrations");
    smtpState.mode = (url.searchParams.get("smtp") as any) ?? "ok";
    smtpState.sessions.length = 0;
    return res.end("ok");
  }
  if (url.pathname === "/__test/jwt") return res.end(await mintJwt());
  if (url.pathname === "/__test/smtp") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(smtpState.sessions.map((s) => s.messages)));
  }

  if (url.pathname.startsWith("/api/")) {
    const r = await worker.fetch(
      new Request(url.href, { method: req.method, headers: req.headers as any, body: body.length ? body : undefined }),
      env(),
      {} as any,
    );
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }

  let path = url.pathname;
  if (path.endsWith("/")) path += "index.html";
  let file = ROOT + path.slice(1);
  if (!existsSync(file) && existsSync(ROOT + "public" + path)) file = ROOT + "public" + path;
  if (!existsSync(file) && existsSync(file + ".ts")) file += ".ts";
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end("not found");
  }
  if (file.endsWith(".css")) {
    res.setHeader("content-type", "text/javascript"); // CSS imported as a module: no-op without Vite
    return res.end("");
  }
  if (file.endsWith(".ts")) {
    res.setHeader("content-type", "text/javascript");
    return res.end(stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "transform" }));
  }
  res.setHeader("content-type", TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream");
  res.end(readFileSync(file));
}).listen(port, () => console.log(`test server on ${port}`));

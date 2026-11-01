/**
 * Self-hosted entry point: runs the same Hono app as the Cloudflare Worker on
 * Node 22, with SQLite in place of D1 and Node sockets for SMTP.
 *
 *   node dist/server/server.js                  serve (PORT, default 8787)
 *   node dist/server/server.js --migrate        apply pending db/migrations
 *   node dist/server/server.js --run-reminders  one reminders run (systemd timer; still needs
 *                                                settings.reminders_enabled = '1')
 *
 * Settings come from the environment (see deploy/sparkle.env.example).
 * Intended to sit behind Nginx Proxy Manager with Cloudflare's proxy in front,
 * which keeps Cloudflare Access protecting /admin/ and /api/admin/.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import worker from "../worker/index";
import { runReminders } from "../worker/lib/reminders";
import { setSocketConnect } from "../worker/lib/smtp";
import type { Env } from "../worker/types";
import { applyMigrations } from "./migrate";
import { nodeConnect } from "./sockets-node";
import { SqliteD1 } from "./sqlite-d1";
import { SECURITY_HEADERS, serveStatic } from "./static";

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.APP_ROOT ?? resolve(here, "../..");
const CLIENT_DIR = process.env.CLIENT_DIR ?? resolve(APP_ROOT, "dist/client");
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? resolve(APP_ROOT, "db/migrations");
const DB_PATH = process.env.DB_PATH ?? resolve(APP_ROOT, "data/sparkle.db");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
const MAX_BODY = 256 * 1024;

setSocketConnect(nodeConnect);

export function buildEnv(db: SqliteD1): Env {
  const e = process.env;
  return {
    DB: db as unknown as Env["DB"],
    ACCESS_TEAM_DOMAIN: e.ACCESS_TEAM_DOMAIN ?? "",
    ACCESS_AUD: e.ACCESS_AUD ?? "",
    SMTP_HOST: e.SMTP_HOST || undefined,
    SMTP_PORT: e.SMTP_PORT || undefined,
    SMTP_USER: e.SMTP_USER || undefined,
    SMTP_PASS: e.SMTP_PASS || undefined,
    MAIL_FROM: e.MAIL_FROM || undefined,
    MAIL_TO: e.MAIL_TO || undefined,
    TURNSTILE_SECRET_KEY: e.TURNSTILE_SECRET_KEY || undefined,
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Converts Node's request into a Fetch Request for the Hono app and back. */
export function makeHandler(env: Env, clientDir: string) {
  const pending = new Set<Promise<unknown>>();
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      const t = p.catch((e) => console.error("background task failed", e)).finally(() => pending.delete(t));
      pending.add(t);
    },
    passThroughOnException: () => {},
    props: {},
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    try {
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { Allow: "GET, HEAD", ...SECURITY_HEADERS }).end();
          return;
        }
        serveStatic(clientDir, url.pathname, req.method, res);
        return;
      }
      const body = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req);
      if (body === null && req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(413, SECURITY_HEADERS).end("Request too large");
        return;
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
      }
      // Behind a proxy the Worker code expects https URLs; the scheme only
      // affects URL construction, never routing.
      const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "http";
      const request = new Request(`${proto}://${host}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: body && body.length ? body : undefined,
      });
      const response = await worker.fetch(request, env, ctx as never);
      const out: Record<string, string | string[]> = { ...SECURITY_HEADERS };
      response.headers.forEach((value, key) => {
        if (key === "set-cookie") return;
        out[key] = value;
      });
      const cookies = response.headers.getSetCookie?.() ?? [];
      if (cookies.length) out["set-cookie"] = cookies;
      const buf = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, out);
      res.end(req.method === "HEAD" ? undefined : buf);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json", ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: "Internal error" }));
    }
  };
  return { handler, pending };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const db = new SqliteD1(DB_PATH);
  if (args.has("--migrate")) {
    applyMigrations(db, MIGRATIONS_DIR);
    db.close();
    return;
  }
  const env = buildEnv(db);
  if (args.has("--run-reminders")) {
    const r = await runReminders(env);
    console.log(JSON.stringify(r));
    db.close();
    return;
  }
  // Refuse to serve an empty or behind-schema database.
  const applied = applyMigrations(db, MIGRATIONS_DIR, () => {});
  if (applied.length) console.log(`applied ${applied.length} migration(s) on start: ${applied.join(", ")}`);
  const { handler, pending } = makeHandler(env, CLIENT_DIR);
  const server = createServer(handler);
  server.listen(PORT, HOST, () => console.log(`Sparkle Carpets listening on ${HOST}:${PORT}`));
  const stop = () => {
    server.close(async () => {
      await Promise.allSettled([...pending]);
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

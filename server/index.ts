// Self-hosted entry point: the Worker's API plus the built site, on Node.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import worker from "../worker/index";
import type { Env } from "../worker/types";
import { openDatabase } from "./d1";

const required = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

const appDir = resolve(process.env.APP_DIR ?? ".");
const assets = join(appDir, "dist/client");
const db = openDatabase(required("DATABASE_PATH"), join(appDir, "db/migrations"));

const env = {
  DB: db,
  ACCESS_TEAM_DOMAIN: process.env.ACCESS_TEAM_DOMAIN ?? "",
  ACCESS_AUD: process.env.ACCESS_AUD ?? "",
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  MAIL_FROM: process.env.MAIL_FROM,
  MAIL_TO: process.env.MAIL_TO,
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
} as unknown as Env;

const app = new Hono();
app.all("/api/*", (c) => worker.fetch(c.req.raw as never, env, {} as never) as unknown as Response);
// Workers Static Assets redirected /admin to /admin/; keep those URLs working.
app.use("*", async (c, next) => {
  const path = c.req.path;
  const dir = join(assets, path);
  if (!path.endsWith("/") && dir.startsWith(assets) && existsSync(dir) && statSync(dir).isDirectory()) {
    return c.redirect(`${path}/${new URL(c.req.url).search}`, 301);
  }
  await next();
});
app.use("*", serveStatic({ root: assets }));
app.notFound((c) => c.text("Not found", 404));

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "127.0.0.1";
const server = serve({ fetch: app.fetch, port, hostname }, () => console.log(`listening on ${hostname}:${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}

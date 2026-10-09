import { Hono } from "hono";
import { requireAccess } from "../lib/access";
import type { AppBindings } from "../types";

/**
 * Minimal admin API for Amanda's one-page availability screen at /admin/.
 * Everything requires a valid Cloudflare Access JWT (fail-closed).
 */
export const adminRoutes = new Hono<AppBindings>();

adminRoutes.use("*", requireAccess);

adminRoutes.get("/me", (c) => c.json({ email: c.get("adminEmail") ?? null }));

adminRoutes.get("/diary", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, start_date, end_date, kind, name, note FROM diary WHERE end_date >= date('now', '-30 days') ORDER BY start_date",
  ).all();
  return c.json({ diary: results });
});

adminRoutes.post("/diary", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    start_date?: string;
    end_date?: string;
    kind?: string;
    name?: string;
    note?: string;
  };
  const start = (body.start_date ?? "").trim();
  const end = (body.end_date ?? "").trim() || start;
  const kind = body.kind === "blocked" ? "blocked" : "booking";
  const name = (body.name ?? "").trim().slice(0, 100) || null;
  const note = (body.note ?? "").trim().slice(0, 300) || null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
    return c.json({ error: "Dates must be valid, with the end on or after the start." }, 400);
  }
  const row = await c.env.DB.prepare(
    "INSERT INTO diary (start_date, end_date, kind, name, note) VALUES (?, ?, ?, ?, ?) RETURNING id",
  ).bind(start, end, kind, name, note).first<{ id: number }>();
  await c.env.DB.prepare(
    "INSERT INTO audit_log (actor, action, entity, entity_id) VALUES (?, 'diary.add', 'diary', ?)",
  ).bind(c.get("adminEmail") ?? "admin", row?.id ?? null).run();
  return c.json({ ok: true, id: row?.id });
});

adminRoutes.delete("/diary/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Bad id" }, 400);
  await c.env.DB.prepare("DELETE FROM diary WHERE id = ?").bind(id).run();
  await c.env.DB.prepare(
    "INSERT INTO audit_log (actor, action, entity, entity_id) VALUES (?, 'diary.delete', 'diary', ?)",
  ).bind(c.get("adminEmail") ?? "admin", id).run();
  return c.json({ ok: true });
});

adminRoutes.get("/enquiries", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, created_at, name, email, phone, preferred_start, rate_plan_code,
            fulfilment, area, address, extras, estimate_total_pence, message, status, emailed, email_error
     FROM enquiries ORDER BY created_at DESC LIMIT 100`,
  ).all();
  return c.json({ enquiries: results });
});

adminRoutes.post("/enquiries/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  const status = body.status ?? "";
  if (!Number.isInteger(id) || !["new", "replied", "declined", "closed"].includes(status)) {
    return c.json({ error: "Bad request" }, 400);
  }
  await c.env.DB.prepare("UPDATE enquiries SET status = ? WHERE id = ?").bind(status, id).run();
  return c.json({ ok: true });
});

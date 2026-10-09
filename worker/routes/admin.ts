import { Hono } from "hono";
import { lastDay, spanDaysFor } from "../../shared/booking";
import { requireAccess } from "../lib/access";
import { FULFILMENT_LABELS, sendConfirmationEmail, sendEnquiryEmails, type EnquiryEmailData } from "../lib/notify";
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
    "SELECT id, start_date, end_date, kind, name, note, enquiry_id, returned, paid, deposit_status FROM diary WHERE end_date >= date('now', '-30 days') ORDER BY start_date",
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
            fulfilment, area, address, extras, estimate_total_pence, message, status, emailed, email_error,
            terms_version, terms_accepted_at
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
  await audit(c.env.DB, c.get("adminEmail"), "enquiry.status", "enquiry", id, status);
  return c.json({ ok: true });
});

async function audit(db: D1Database, actor: string | undefined, action: string, entity: string, entityId: number, detail?: string) {
  await db
    .prepare("INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(actor ?? "admin", action, entity, entityId, detail ?? null)
    .run();
}

interface EnquiryRow {
  id: number;
  name: string;
  email: string;
  phone: string;
  preferred_start: string;
  rate_plan_code: string;
  fulfilment: string;
  area: string | null;
  address: string | null;
  extras: string;
  message: string | null;
  status: string;
  terms_version: string | null;
}

async function buildEmailData(db: D1Database, q: EnquiryRow): Promise<EnquiryEmailData | null> {
  const plan = await db
    .prepare("SELECT label, price_pence, duration_hours FROM rate_plans WHERE code = ?")
    .bind(q.rate_plan_code)
    .first<{ label: string; price_pence: number; duration_hours: number }>();
  if (!plan) return null;
  const spanEnd = lastDay(q.preferred_start, spanDaysFor(q.rate_plan_code, plan.duration_hours));
  const extraCodes = JSON.parse(q.extras || "[]") as string[];
  const addonRows = await db.prepare("SELECT code, label, price_pence FROM addons").all<{
    code: string;
    label: string;
    price_pence: number;
  }>();
  const extras = addonRows.results.filter((x) => extraCodes.includes(x.code));
  const zone =
    q.fulfilment !== "self" && q.area
      ? await db
          .prepare("SELECT one_way_pence, both_pence FROM delivery_zones WHERE areas = ?")
          .bind(q.area)
          .first<{ one_way_pence: number; both_pence: number }>()
      : null;
  const journeys = q.fulfilment === "self" ? 0 : q.fulfilment === "both" ? 2 : 1;
  const transport = journeys === 0 ? 0 : zone ? (journeys === 1 ? zone.one_way_pence : zone.both_pence) : null;
  const dep = await db.prepare("SELECT value FROM settings WHERE key = 'deposit_pence'").first<{ value: string }>();
  const deposit = Number(dep?.value ?? 0);
  const extrasSum = extras.reduce((s, x) => s + x.price_pence, 0);
  const due = transport === null ? null : plan.price_pence + extrasSum + transport + deposit;
  return {
    id: q.id,
    name: q.name,
    email: q.email,
    phone: q.phone,
    preferred_start: q.preferred_start,
    span_end: spanEnd,
    plan_label: plan.label,
    fulfilment: q.fulfilment,
    area: q.area,
    address: q.address,
    extras,
    transport_pence: transport,
    deposit_pence: deposit,
    due_pence: due,
    message: q.message,
  };
}

/** Retry the failed notification email for an enquiry. */
adminRoutes.post("/enquiries/:id/resend", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Bad id" }, 400);
  const q = await c.env.DB.prepare("SELECT * FROM enquiries WHERE id = ?").bind(id).first<EnquiryRow>();
  if (!q) return c.json({ error: "Enquiry not found" }, 404);
  const data = await buildEmailData(c.env.DB, q);
  if (!data) return c.json({ error: "Enquiry's hire package no longer exists" }, 409);
  const sent = await sendEnquiryEmails(c.env, data);
  await c.env.DB.prepare("UPDATE enquiries SET emailed = ?, email_error = ? WHERE id = ?")
    .bind(sent.emailed ? 1 : 0, sent.error ?? null, id)
    .run();
  await audit(c.env.DB, c.get("adminEmail"), "enquiry.resend_email", "enquiry", id, sent.emailed ? "sent" : sent.error);
  return sent.emailed ? c.json({ ok: true }) : c.json({ error: `Email failed again: ${sent.error}` }, 502);
});

/**
 * Confirm an enquiry: atomically writes the diary booking for the full hire
 * span (the guarded insert makes concurrent confirmations for overlapping
 * periods impossible — the second one gets a 409), marks the enquiry
 * confirmed, and only THEN emails the customer.
 */
adminRoutes.post("/enquiries/:id/confirm", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Bad id" }, 400);
  const q = await c.env.DB.prepare("SELECT * FROM enquiries WHERE id = ?").bind(id).first<EnquiryRow>();
  if (!q) return c.json({ error: "Enquiry not found" }, 404);
  if (q.status === "confirmed") return c.json({ error: "Already confirmed" }, 409);
  const plan = await c.env.DB.prepare("SELECT label, duration_hours FROM rate_plans WHERE code = ?")
    .bind(q.rate_plan_code)
    .first<{ label: string; duration_hours: number }>();
  if (!plan) return c.json({ error: "Enquiry's hire package no longer exists" }, 409);
  const end = lastDay(q.preferred_start, spanDaysFor(q.rate_plan_code, plan.duration_hours));

  const ins = await c.env.DB.prepare(
    `INSERT INTO diary (start_date, end_date, kind, name, note, enquiry_id)
     SELECT ?1, ?2, 'booking', ?3, ?4, ?5
     WHERE NOT EXISTS (SELECT 1 FROM diary WHERE start_date <= ?2 AND end_date >= ?1)`,
  )
    .bind(q.preferred_start, end, q.name, `${plan.label} · ${FULFILMENT_LABELS[q.fulfilment] ?? q.fulfilment}`, id)
    .run();
  if ((ins.meta?.changes ?? 0) === 0) {
    return c.json({ error: "Those dates now clash with another booking or block. Decline or arrange new dates." }, 409);
  }
  await c.env.DB.prepare("UPDATE enquiries SET status = 'confirmed' WHERE id = ?").bind(id).run();
  await audit(c.env.DB, c.get("adminEmail"), "enquiry.confirm", "enquiry", id, `${q.preferred_start} to ${end}`);

  // Email only after the booking row definitely exists.
  const sent = await sendConfirmationEmail(c.env, {
    name: q.name,
    email: q.email,
    plan_label: plan.label,
    start: q.preferred_start,
    end,
    terms_version: q.terms_version,
  });
  if (!sent.emailed) {
    await audit(c.env.DB, c.get("adminEmail"), "enquiry.confirm_email_failed", "enquiry", id, sent.error);
  }
  return c.json({ ok: true, start: q.preferred_start, end, confirmation_emailed: sent.emailed });
});

/** Mark a diary booking's equipment as returned (never touches the deposit). */
adminRoutes.post("/diary/:id/returned", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { returned?: boolean };
  if (!Number.isInteger(id)) return c.json({ error: "Bad id" }, 400);
  const val = body.returned === false ? 0 : 1;
  await c.env.DB.prepare("UPDATE diary SET returned = ? WHERE id = ?").bind(val, id).run();
  await audit(c.env.DB, c.get("adminEmail"), "diary.returned", "diary", id, String(val));
  return c.json({ ok: true });
});

/** Record hire payment received — separate from 'returned' and the deposit. */
adminRoutes.post("/diary/:id/paid", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { paid?: boolean };
  if (!Number.isInteger(id)) return c.json({ error: "Bad id" }, 400);
  const val = body.paid === false ? 0 : 1;
  await c.env.DB.prepare("UPDATE diary SET paid = ? WHERE id = ?").bind(val, id).run();
  await audit(c.env.DB, c.get("adminEmail"), "diary.paid", "diary", id, String(val));
  return c.json({ ok: true });
});

/** Record the deposit outcome — an explicit, separate action from 'returned'. */
adminRoutes.post("/diary/:id/deposit", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  const status = body.status ?? "";
  if (!Number.isInteger(id) || !["held", "refunded", "deducted", "na"].includes(status)) {
    return c.json({ error: "Bad request" }, 400);
  }
  await c.env.DB.prepare("UPDATE diary SET deposit_status = ? WHERE id = ?").bind(status, id).run();
  await audit(c.env.DB, c.get("adminEmail"), "diary.deposit", "diary", id, status);
  return c.json({ ok: true });
});

/** Recent administrative activity, newest first. */
adminRoutes.get("/activity", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT actor, action, entity, entity_id, detail, created_at FROM audit_log ORDER BY id DESC LIMIT 40",
  ).all();
  return c.json({ activity: results });
});

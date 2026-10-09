import { Hono } from "hono";
import { lastDay, spanDaysFor, todayIoM } from "../../shared/booking";
import { sendMail } from "../lib/smtp";
import type { AppBindings, Env } from "../types";

export const publicRoutes = new Hono<AppBindings>();

publicRoutes.get("/health", (c) => c.json({ ok: true }));

publicRoutes.get("/rates", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT code, label, duration_hours, price_pence FROM rate_plans WHERE active = 1 ORDER BY duration_hours",
  ).all();
  return c.json({ rates: results });
});

// Only these settings are public; everything else stays server-side.
const PUBLIC_SETTINGS = [
  "deposit_pence",
  "extra_day_pence",
  "cleaning_charge_pence",
  "detergent_included",
  "operating_base",
  "whatsapp_number",
] as const;

publicRoutes.get("/pricing", async (c) => {
  const [rates, addons, zones, settings] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT code, label, duration_hours, price_pence FROM rate_plans WHERE active = 1 ORDER BY duration_hours",
    ),
    c.env.DB.prepare("SELECT code, label, price_pence FROM addons WHERE active = 1 ORDER BY code"),
    c.env.DB.prepare(
      "SELECT name, areas, one_way_pence, both_pence FROM delivery_zones WHERE active = 1 ORDER BY sort",
    ),
    c.env.DB.prepare(
      `SELECT key, value FROM settings WHERE key IN (${PUBLIC_SETTINGS.map(() => "?").join(",")})`,
    ).bind(...PUBLIC_SETTINGS),
  ]);
  const settingsMap: Record<string, string> = {};
  for (const row of settings.results as { key: string; value: string }[]) settingsMap[row.key] = row.value;
  c.header("Cache-Control", "public, max-age=300");
  return c.json({
    rates: rates.results,
    addons: addons.results,
    delivery_zones: zones.results,
    settings: settingsMap,
  });
});

/** Unavailable date ranges for the public calendar (no names or details). */
publicRoutes.get("/unavailable", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT start_date, end_date FROM diary WHERE end_date >= date('now') ORDER BY start_date",
  ).all();
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ unavailable: results });
});

interface EnquiryBody {
  name?: string;
  email?: string;
  phone?: string;
  preferred_start?: string;
  rate_plan_code?: string;
  fulfilment_pref?: string;
  area?: string;
  address?: string;
  message?: string;
  website?: string; // honeypot: must stay empty
  turnstile_token?: string;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function verifyTurnstile(env: Env, token: string, ip: string | undefined): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true; // not configured yet
  if (!token) return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

publicRoutes.post("/enquiry", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as EnquiryBody;

  if (str(body.website, 10) !== "") return c.json({ ok: true }); // honeypot: pretend success

  const name = str(body.name, 100);
  const email = str(body.email, 200);
  const phone = str(body.phone, 40);
  const preferredStart = str(body.preferred_start, 10);
  const plan = str(body.rate_plan_code, 20);
  const fulfilment = str(body.fulfilment_pref, 10);
  const area = str(body.area, 100);
  const address = str(body.address, 300);
  const message = str(body.message, 1000);

  if (name.length < 2) return c.json({ error: "Please tell us your name." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "That email address doesn't look right." }, 400);
  if (phone.length < 6) return c.json({ error: "Please include a phone number." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(preferredStart) || preferredStart < todayIoM()) {
    return c.json({ error: "Please pick a start date from today onwards." }, 400);
  }
  if (!["collect", "deliver"].includes(fulfilment)) return c.json({ error: "Please choose collection or delivery." }, 400);
  if (fulfilment === "deliver" && (area.length < 2 || address.length < 6)) {
    return c.json({ error: "For delivery, please include your area and address." }, 400);
  }
  const planRow = await c.env.DB.prepare(
    "SELECT label, price_pence, duration_hours FROM rate_plans WHERE code = ? AND active = 1",
  ).bind(plan).first<{ label: string; price_pence: number; duration_hours: number }>();
  if (!planRow) return c.json({ error: "Please choose a hire length." }, 400);

  // The whole hire span (including the weekend Monday return day) must be
  // free of confirmed bookings and owner blocks. Pending enquiries do not
  // block availability by design.
  const spanEnd = lastDay(preferredStart, spanDaysFor(plan, planRow.duration_hours));
  const clash = await c.env.DB.prepare(
    "SELECT 1 AS x FROM diary WHERE start_date <= ? AND end_date >= ? LIMIT 1",
  ).bind(spanEnd, preferredStart).first();
  if (clash) {
    return c.json({ error: "Those dates are no longer available. Please pick different dates on the calendar." }, 409);
  }

  const human = await verifyTurnstile(c.env, str(body.turnstile_token, 2048), c.req.header("CF-Connecting-IP"));
  if (!human) return c.json({ error: "Verification failed; please try again." }, 400);

  const inserted = await c.env.DB.prepare(
    `INSERT INTO enquiries (name, email, phone, preferred_start, rate_plan_code, fulfilment_pref, area, address, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(name, email, phone, preferredStart, plan, fulfilment, area || null, address || null, message || null)
    .first<{ id: number }>();

  // Email Amanda (and acknowledge the customer). Failure never loses the
  // enquiry: it is already stored and visible on the admin page.
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_TO } = c.env;
  if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && MAIL_FROM && MAIL_TO) {
    const cfg = { host: SMTP_HOST, port: Number(SMTP_PORT), user: SMTP_USER, pass: SMTP_PASS };
    const lines = [
      `New hire enquiry (ref ${inserted?.id ?? "?"})`,
      "",
      `Name:   ${name}`,
      `Email:  ${email}`,
      `Phone:  ${phone}`,
      `Start:  ${preferredStart}`,
      `Hire:   ${planRow.label}`,
      `Fulfil: ${fulfilment === "deliver" ? `Delivery — ${area}, ${address}` : "Customer collects"}`,
      message ? `Message: ${message}` : "",
      "",
      "Reply to this email to respond to the customer.",
    ].filter(Boolean);
    try {
      await sendMail(cfg, {
        from: MAIL_FROM,
        to: [MAIL_TO],
        replyTo: `${name} <${email}>`,
        subject: `Hire enquiry: ${planRow.label} from ${preferredStart} (${name})`,
        text: lines.join("\n"),
      });
      await c.env.DB.prepare("UPDATE enquiries SET emailed = 1 WHERE id = ?").bind(inserted?.id).run();
      await sendMail(cfg, {
        from: MAIL_FROM,
        to: [`${name} <${email}>`],
        replyTo: MAIL_TO,
        subject: "We've received your enquiry — Sparkle Carpets",
        text:
          `Hi ${name},\n\nThanks for your enquiry about hiring our BISSELL Big Green ` +
          `(${planRow.label}, from ${preferredStart}).\n\nThis isn't a confirmed booking yet: ` +
          `we'll check availability and reply personally, usually the same day, to agree the details ` +
          `and payment at handover.\n\nSparkle Carpets, Isle of Man\nbookings@sparklecarpets.im`,
      }).catch(() => { /* acknowledgement is best-effort */ });
    } catch (err) {
      console.error("enquiry email failed", err);
    }
  }

  return c.json({ ok: true });
});

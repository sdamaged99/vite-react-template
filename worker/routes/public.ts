import { Hono } from "hono";
import {
  FULFILMENTS,
  computeEstimate,
  lastDay,
  spanDaysFor,
  todayIoM,
  transportPence,
  type Fulfilment,
} from "../../shared/booking";
import { sendEnquiryEmails, type EnquiryEmailData } from "../lib/notify";
import { CURRENT_TERMS } from "../lib/terms";
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
    "SELECT start_date, end_date FROM diary WHERE end_date >= ? ORDER BY start_date",
  ).bind(todayIoM()).all();
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ unavailable: results });
});

interface EnquiryBody {
  name?: string;
  email?: string;
  phone?: string;
  preferred_start?: string;
  rate_plan_code?: string;
  fulfilment?: string;
  area?: string;
  address?: string;
  extras?: unknown;
  message?: string;
  terms_acknowledged?: unknown;
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

  if (str(body.website, 10) !== "") return c.json({ ok: true, emailed: true }); // honeypot: pretend success

  const name = str(body.name, 100);
  const email = str(body.email, 200);
  const phone = str(body.phone, 40);
  const preferredStart = str(body.preferred_start, 10);
  const plan = str(body.rate_plan_code, 20);
  const fulfilment = str(body.fulfilment, 20) as Fulfilment;
  const area = str(body.area, 100);
  const address = str(body.address, 300);
  const message = str(body.message, 1000);
  const extrasRaw = Array.isArray(body.extras) ? body.extras.map((e) => str(e, 40)).filter(Boolean) : [];

  if (name.length < 2) return c.json({ error: "Please tell us your name." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "That email address doesn't look right." }, 400);
  if (phone.length < 6) return c.json({ error: "Please include a phone number." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(preferredStart) || preferredStart < todayIoM()) {
    return c.json({ error: "Please pick a start date from today onwards." }, 400);
  }
  if (!FULFILMENTS.includes(fulfilment)) {
    return c.json({ error: "Please choose how you'd like to receive the machine." }, 400);
  }
  const wantsTransport = fulfilment !== "self";
  if (wantsTransport && (area.length < 2 || address.length < 6)) {
    return c.json({ error: "For delivery or collection by us, please include your area and address." }, 400);
  }

  // Server-side check: the checkbox alone is never trusted. This records an
  // ACKNOWLEDGEMENT that the proposed terms were read — formal acceptance
  // happens later, when Amanda agrees the arrangements with the customer.
  if (body.terms_acknowledged !== true) {
    return c.json({ error: "Please confirm you have read the proposed Equipment Hire Terms & Conditions." }, 400);
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

  // Prices only ever come from the database; the client's figures are display-only.
  const addonRows = await c.env.DB.prepare(
    "SELECT code, label, price_pence FROM addons WHERE active = 1",
  ).all<{ code: string; label: string; price_pence: number }>();
  const extras = addonRows.results.filter((a) => extrasRaw.includes(a.code));

  // A zone is matched exactly against the configured areas; anything else is
  // "quoted individually" — never priced from free text.
  const zone = wantsTransport
    ? await c.env.DB.prepare(
        "SELECT one_way_pence, both_pence FROM delivery_zones WHERE active = 1 AND areas = ?",
      ).bind(area).first<{ one_way_pence: number; both_pence: number }>()
    : null;
  const transport = transportPence(fulfilment, zone ?? null); // null => quote

  const depositRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'deposit_pence'").first<{
    value: string;
  }>();
  const deposit = Number(depositRow?.value ?? 0);
  const est = computeEstimate({
    hirePence: planRow.price_pence,
    transportPence: transport,
    extrasPence: extras.map((x) => x.price_pence),
    depositPence: deposit,
  });

  const inserted = await c.env.DB.prepare(
    `INSERT INTO enquiries (name, email, phone, preferred_start, rate_plan_code, fulfilment, area, address, extras, estimate_total_pence, message,
                             terms_version, terms_acknowledged_at, terms_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?) RETURNING id`,
  )
    .bind(
      name,
      email,
      phone,
      preferredStart,
      plan,
      fulfilment,
      area || null,
      address || null,
      JSON.stringify(extras.map((x) => x.code)),
      est.dueAtHandoverPence,
      message || null,
      CURRENT_TERMS.version,
      CURRENT_TERMS.sha256,
    )
    .first<{ id: number }>();
  if (!inserted) return c.json({ error: "We couldn't save your enquiry; please email bookings@sparklecarpets.im." }, 500);

  const mailData: EnquiryEmailData = {
    id: inserted.id,
    name,
    email,
    phone,
    preferred_start: preferredStart,
    span_end: spanEnd,
    plan_label: planRow.label,
    fulfilment,
    area: area || null,
    address: address || null,
    extras,
    transport_pence: transport,
    deposit_pence: deposit,
    due_pence: est.dueAtHandoverPence,
    message: message || null,
  };
  const sent = await sendEnquiryEmails(c.env, mailData);
  await c.env.DB.prepare("UPDATE enquiries SET emailed = ?, email_error = ? WHERE id = ?")
    .bind(sent.emailed ? 1 : 0, sent.error ?? null, inserted.id)
    .run();

  // Honest partial success: the enquiry is saved either way; the flag lets the
  // page tell the customer when our notification email failed.
  return c.json({ ok: true, emailed: sent.emailed });
});

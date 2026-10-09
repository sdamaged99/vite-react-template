import { Hono } from "hono";
import type { AppBindings } from "../types";

/**
 * Public, unauthenticated API.
 * Phase 2 adds GET /availability (bookable dates respecting bookings,
 * blocked_dates and the turnaround buffer).
 */
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
] as const;

/**
 * Everything the pricing section needs in one call. The homepage hydrates its
 * static figures from this, so price and zone changes made in the admin
 * dashboard show immediately without a redeploy.
 */
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

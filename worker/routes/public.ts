import { Hono } from "hono";
import type { AppBindings } from "../types";

/**
 * Public, unauthenticated API.
 * Phase 2 adds GET /availability (bookable dates respecting bookings,
 * blocked_dates and the turnaround buffer) and the public settings
 * needed by the booking widget (rates, add-ons, handover times).
 */
export const publicRoutes = new Hono<AppBindings>();

publicRoutes.get("/health", (c) => c.json({ ok: true }));

publicRoutes.get("/rates", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT code, label, duration_hours, price_pence FROM rate_plans WHERE active = 1 ORDER BY duration_hours",
  ).all();
  return c.json({ rates: results });
});

import { Hono } from "hono";
import { requireAccess } from "../lib/access";
import type { AppBindings } from "../types";

/**
 * Admin API (Phase 2). Every route requires a valid Cloudflare Access JWT.
 * Planned endpoints: bookings list/calendar, confirm/decline/cancel,
 * collections & returns, deposit status, blocked dates, price settings,
 * income report, CSV export. All mutating actions write to audit_log.
 */
export const adminRoutes = new Hono<AppBindings>();

adminRoutes.use("*", requireAccess);

adminRoutes.get("/me", (c) => c.json({ email: c.get("adminEmail") ?? null }));
adminRoutes.get("/bookings", (c) => c.json({ error: "Admin dashboard arrives in Phase 2" }, 501));

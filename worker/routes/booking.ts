import { Hono } from "hono";
import type { AppBindings } from "../types";

/**
 * Booking request flow (Phase 2).
 *
 * POST /request — validate input + Turnstile token, then insert the booking
 * with status 'requested' and hold_expires_at = now + hold window, inside a
 * single conditional statement that fails if any overlapping hold, confirmed
 * booking (including its buffer_until) or blocked date exists. See
 * DATABASE.md "Overlap prevention" for the exact pattern.
 *
 * Unanswered requests past hold_expires_at are flipped to 'expired' by a
 * scheduled Worker run, releasing the dates automatically.
 */
export const bookingRoutes = new Hono<AppBindings>();

bookingRoutes.post("/request", (c) => c.json({ error: "Booking opens in Phase 2" }, 501));
bookingRoutes.get("/availability", (c) => c.json({ error: "Booking opens in Phase 2" }, 501));

import { Hono } from "hono";
import type { AppBindings } from "../types";

/**
 * Booking request flow (Phase 2).
 *
 * POST /request — validate input + Turnstile, then insert the booking with
 * status 'requested' and hold_expires_at = now + hold window, inside the
 * atomic overlap-guarded insert documented in DATABASE.md.
 *
 * Fulfilment: 'self' (free) | 'delivery_only' | 'collection_only' | 'both'.
 * - Zone picked from delivery_zones via a location selector (never free-text
 *   pricing); full address captured when fulfilment != 'self'.
 * - transport_pence = zone one_way/both price, or delivery_quote_pence when
 *   Amanda quotes a remote address manually; she may also waive it (0).
 * - delivery_status starts 'requested': Amanda confirms or declines each
 *   delivery according to her availability. No delivery date or time is ever
 *   promised automatically; journey times are agreed separately from the
 *   rental dates.
 * - The pre-confirmation summary itemises hire, add-ons, transport and the
 *   refundable deposit as separate lines.
 *
 * Additional hire day: extend end_at/buffer_until only if the same atomic
 * overlap check passes for the extended window; a conflicting confirmed
 * reservation blocks the extension.
 *
 * Unanswered requests past hold_expires_at are flipped to 'expired' by a
 * scheduled Worker run, releasing the dates automatically.
 */
export const bookingRoutes = new Hono<AppBindings>();

bookingRoutes.post("/request", (c) => c.json({ error: "Booking opens in Phase 2" }, 501));
bookingRoutes.get("/availability", (c) => c.json({ error: "Booking opens in Phase 2" }, 501));

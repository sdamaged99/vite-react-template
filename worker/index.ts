import { Hono } from "hono";
import { publicRoutes } from "./routes/public";
import { bookingRoutes } from "./routes/booking";
import { adminRoutes } from "./routes/admin";
import type { AppBindings, Env } from "./types";

const app = new Hono<AppBindings>();

app.route("/api", publicRoutes);
app.route("/api/booking", bookingRoutes);
app.route("/api/admin", adminRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

export default {
  fetch: app.fetch,
  // Phase 2: scheduled handler expires unanswered booking requests
  // (status 'requested' past hold_expires_at → 'expired').
} satisfies ExportedHandler<Env>;

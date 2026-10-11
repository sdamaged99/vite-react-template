import { Hono } from "hono";
import { publicRoutes } from "./routes/public";
import { adminRoutes } from "./routes/admin";
import { runReminders } from "./lib/reminders";
import type { AppBindings, Env } from "./types";

const app = new Hono<AppBindings>();

app.route("/api", publicRoutes);
app.route("/api/admin", adminRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

export default {
  fetch: app.fetch,
  // Runs only if a cron trigger is added to wrangler.jsonc (none yet) AND
  // settings.reminders_enabled = '1'. See worker/lib/reminders.ts.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runReminders(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;

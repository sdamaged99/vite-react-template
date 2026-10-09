export interface Env {
  DB: D1Database;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  // Phase 3 secrets (set via `wrangler secret put`):
  EMAIL_API_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export type AppBindings = { Bindings: Env; Variables: { adminEmail?: string } };

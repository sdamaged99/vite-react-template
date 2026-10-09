export interface Env {
  DB: D1Database;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  // Self-hosted email submission (NethServer). Set via `wrangler secret put`;
  // with any of these unset, enquiries are stored but no email is attempted.
  SMTP_HOST?: string;
  SMTP_PORT?: string; // "465" (implicit TLS) or "587" (STARTTLS)
  SMTP_USER?: string;
  SMTP_PASS?: string;
  MAIL_FROM?: string; // e.g. "Sparkle Carpets <website@sparklecarpets.im>"
  MAIL_TO?: string;   // e.g. "bookings@sparklecarpets.im"
  // Cloudflare Turnstile; with the secret unset, verification is skipped.
  TURNSTILE_SECRET_KEY?: string;
}

export type AppBindings = { Bindings: Env; Variables: { adminEmail?: string } };

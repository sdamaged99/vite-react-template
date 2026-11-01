import type { Context, MiddlewareHandler } from "hono";
import { requireAccess } from "./access";
import type { AppBindings, Env } from "../types";

/**
 * Admin sign-in: a one-time code emailed to an address on the ADMIN_EMAILS
 * allowlist, then a 14-day session held in an HttpOnly cookie. Codes and
 * session tokens are stored only as SHA-256 hashes.
 *
 * Cloudflare Access still works if its variables are set, for as long as the
 * Worker exists. With neither configured, admin is closed; there is no bypass.
 */
export const SESSION_COOKIE = "sparkle_admin";
export const SESSION_DAYS = 14;

export function adminEmails(env: Env): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

export const sessionToken = (c: Context<AppBindings>) => cookieValue(c.req.header("Cookie"), SESSION_COOKIE);

/** The signed-in email, if the cookie is live and the address is still allowed. */
async function sessionEmail(c: Context<AppBindings>): Promise<string | null> {
  const token = sessionToken(c);
  if (!token) return null;
  const row = await c.env.DB.prepare("SELECT email FROM admin_sessions WHERE token_hash = ? AND expires_at > datetime('now')")
    .bind(await sha256(token))
    .first<{ email: string }>();
  return row && adminEmails(c.env).has(row.email) ? row.email : null;
}

export const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const useSessions = adminEmails(c.env).size > 0;
  const useAccess = Boolean(c.env.ACCESS_TEAM_DOMAIN && c.env.ACCESS_AUD);
  if (!useSessions && !useAccess) return c.json({ error: "Admin access is not configured" }, 503);
  if (useSessions) {
    const email = await sessionEmail(c);
    if (email) {
      c.set("adminEmail", email);
      c.set("adminSession", true);
      c.header("Cache-Control", "no-store");
      await next();
      return;
    }
  }
  if (useAccess) return requireAccess(c, next);
  return c.json({ error: "Unauthorised" }, 401);
};

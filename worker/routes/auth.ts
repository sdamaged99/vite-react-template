import { Hono } from "hono";
import { cfg, smtpConfigured } from "../lib/notify";
import { adminEmails, SESSION_COOKIE, SESSION_DAYS, sessionToken, sha256 } from "../lib/session";
import { sendMail } from "../lib/smtp";
import type { AppBindings } from "../types";

/** Sign-in for the admin page. See worker/lib/session.ts. */
export const authRoutes = new Hono<AppBindings>();

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I/L
const CODE_LENGTH = 8;

function randomCode(): string {
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(CODE_LENGTH * 2))) {
      // Reject the top of the byte range so every character is equally likely.
      if (b < 248 && out.length < CODE_LENGTH) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

const normEmail = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase().slice(0, 200) : "");
const normCode = (v: unknown) => (typeof v === "string" ? v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) : "");
const codeHash = (email: string, code: string) => sha256(`${email}:${code}`);

/** Same answer for every address, so the page never reveals who is allowed. */
authRoutes.post("/request", async (c) => {
  const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown });
  const email = normEmail(body.email);
  const ok = c.json({ ok: true });
  if (!adminEmails(c.env).has(email)) return ok;
  if (!smtpConfigured(c.env)) {
    console.error("Admin sign-in code not sent: mail is not configured");
    return ok;
  }

  const db = c.env.DB;
  await db.prepare("DELETE FROM admin_login_codes WHERE created_at < datetime('now', '-1 day')").run();
  const recent = await db
    .prepare(
      `SELECT count(*) AS n, coalesce(sum(created_at > datetime('now', '-1 minute')), 0) AS last_minute
       FROM admin_login_codes WHERE email = ? AND created_at > datetime('now', '-1 hour')`,
    )
    .bind(email)
    .first<{ n: number; last_minute: number }>();
  if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR || (recent?.last_minute ?? 0) > 0) return ok;

  const code = randomCode();
  await db.prepare("UPDATE admin_login_codes SET used_at = datetime('now') WHERE email = ? AND used_at IS NULL").bind(email).run();
  const inserted = await db
    .prepare(`INSERT INTO admin_login_codes (email, code_hash, expires_at) VALUES (?, ?, datetime('now', '+${CODE_MINUTES} minutes'))`)
    .bind(email, await codeHash(email, code))
    .run();
  try {
    await sendMail(cfg(c.env), {
      from: c.env.MAIL_FROM!,
      to: [email],
      subject: "Your Sparkle Carpets sign-in code",
      text:
        `Your sign-in code for the Sparkle Carpets admin page is:\n\n${code.slice(0, 4)} ${code.slice(4)}\n\n` +
        `It lasts ${CODE_MINUTES} minutes and can be used once. If you didn't ask for it, you can ignore this email.\n`,
    });
  } catch (err) {
    console.error("Admin sign-in code could not be sent", err);
    await db.prepare("DELETE FROM admin_login_codes WHERE id = ?").bind(inserted.meta.last_row_id).run();
  }
  return ok;
});

authRoutes.post("/verify", async (c) => {
  const denied = () => c.json({ error: "That code isn't right, or it has expired. Please try again." }, 401);
  const body = await c.req.json<{ email?: unknown; code?: unknown }>().catch(() => ({}) as { email?: unknown; code?: unknown });
  const email = normEmail(body.email);
  const code = normCode(body.code);
  if (!adminEmails(c.env).has(email) || code.length !== CODE_LENGTH) return denied();

  const db = c.env.DB;
  const row = await db
    .prepare(
      `SELECT id, code_hash FROM admin_login_codes
       WHERE email = ? AND used_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`,
    )
    .bind(email)
    .first<{ id: number; code_hash: string }>();
  if (!row) return denied();
  // Count the attempt first, so parallel guesses can't exceed the limit.
  const counted = await db
    .prepare("UPDATE admin_login_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ?")
    .bind(row.id, MAX_ATTEMPTS)
    .run();
  if ((counted.meta.changes ?? 0) === 0 || (await codeHash(email, code)) !== row.code_hash) return denied();
  const claimed = await db
    .prepare("UPDATE admin_login_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL")
    .bind(row.id)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) return denied();

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await db.prepare("DELETE FROM admin_sessions WHERE expires_at <= datetime('now')").run();
  await db
    .prepare(`INSERT INTO admin_sessions (token_hash, email, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`)
    .bind(await sha256(token), email)
    .run();
  await db.prepare("INSERT INTO audit_log (actor, action, entity) VALUES (?, 'auth.sign_in', 'admin')").bind(email).run();
  c.header(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`,
  );
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true });
});

authRoutes.post("/logout", async (c) => {
  const token = sessionToken(c);
  if (token) await c.env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  c.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  return c.json({ ok: true });
});
